import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { Pool as MysqlPool, PoolConnection as MysqlConnection } from "mysql2/promise";
import type { Pool as PgPool, PoolClient, QueryResult } from "pg";
import Cursor from "pg-cursor";
import type {
  DatasourceDriver,
  DatasourceDriverPool,
  DialectProfile,
} from "@datachat/datasource-sdk";
import { guardSql, type GuardErrorCode } from "./guard.js";
import type { ColumnInfo } from "../../services/artifacts.js";

const require = createRequire(import.meta.url);

export class SqlTimeoutError extends Error {
  constructor(message = "查询超时") {
    super(message);
    this.name = "SqlTimeoutError";
  }
}

export class SqlAbortedError extends Error {
  constructor(message = "查询已取消") {
    super(message);
    this.name = "SqlAbortedError";
  }
}

export class SqlRejectedError extends Error {
  constructor(
    readonly code: GuardErrorCode,
    reason: string,
  ) {
    super(reason);
    this.name = "SqlRejectedError";
  }
}

export interface ExecuteInput {
  dialect: "mysql" | "postgres" | "sqlite" | "driver";
  dialectProfile?: DialectProfile;
  pool?: MysqlPool | PgPool;
  driverPool?: DatasourceDriverPool;
  classifyError?: DatasourceDriver["classifyError"];
  sqlitePath?: string;
  sql: string;
  /** Bound values for placeholders produced by the scope rewrite. */
  params?: unknown[];
  maxRows: number;
  previewRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Defense in depth: when set, re-run the guard inside the executor so an
   * unguarded caller can never reach the database. PostgreSQL is rejected
   * with the same structured error before a connection is acquired.
   */
  guard?: { maxTables?: number };
}

export interface ExecuteResult {
  columns: ColumnInfo[];
  previewRows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

const BATCH_SIZE = 500;

interface Batch {
  columns: ColumnInfo[];
  rows: unknown[][];
}

/**
 * Stream a guarded read-only query. Rows beyond `maxRows` are counted and
 * dropped; only the first `previewRows` are retained in memory. The returned
 * async function is called for every batch that should be persisted.
 */
export async function executeReadOnly(
  input: ExecuteInput,
  onRow: (row: unknown[]) => Promise<void>,
): Promise<ExecuteResult> {
  const started = Date.now();
  let sql = input.sql;

  if (input.guard) {
    const guard = guardSql({
      sql,
      dialect:
        input.dialectProfile ??
        (input.dialect === "driver" ? "mysql" : input.dialect),
      maxRows: input.maxRows,
      maxTables: input.guard.maxTables,
    });
    if (!guard.ok) throw new SqlRejectedError(guard.code, guard.reason);
    sql = guard.sql;
  }

  throwIfAborted(input.signal);

  let rowCount = 0;
  let truncated = false;
  const previewRows: unknown[][] = [];
  const columnsRef: { columns: ColumnInfo[] } = { columns: [] };

  const consume = async (batch: Batch): Promise<void> => {
    if (batch.columns.length > 0 && columnsRef.columns.length === 0) {
      const first = batch.rows[0];
      columnsRef.columns = batch.columns.map((column, index) => ({
        name: column.name,
        type:
          column.type === "unknown" && first
            ? inferType([first[index]])
            : column.type,
      }));
    }
    for (const row of batch.rows) {
      if (rowCount >= input.maxRows) {
        truncated = true;
        break;
      }
      rowCount += 1;
      if (previewRows.length < input.previewRows) previewRows.push(row);
      await onRow(row);
    }
  };

  const shouldStop = (): boolean => truncated || input.signal?.aborted === true;

  try {
    const streamedColumns =
      input.dialect === "driver"
        ? await streamDriverPool(input, sql, consume, shouldStop)
        : input.dialect === "mysql"
          ? await streamMysql(input, sql, consume, shouldStop)
          : input.dialect === "postgres"
            ? await streamPostgres(input, sql, consume, shouldStop)
            : await streamSqlite(input, sql, consume, shouldStop);
    if (columnsRef.columns.length === 0 && streamedColumns.length > 0) {
      columnsRef.columns = streamedColumns;
    }
  } catch (error) {
    if (input.signal?.aborted) throw new SqlAbortedError();
    if (error instanceof SqlTimeoutError || error instanceof SqlAbortedError) throw error;
    const classified = input.classifyError?.(error);
    if (classified === "timeout" || isTimeoutError(error)) throw new SqlTimeoutError();
    if (classified === "aborted") throw new SqlAbortedError();
    throw error;
  }

  if (input.signal?.aborted) throw new SqlAbortedError();

  return {
    columns: columnsRef.columns,
    previewRows,
    rowCount,
    truncated,
    durationMs: Date.now() - started,
  };
}

async function streamDriverPool(
  input: ExecuteInput,
  sql: string,
  consume: (batch: Batch) => Promise<void>,
  shouldStop: () => boolean,
): Promise<ColumnInfo[]> {
  const pool = input.driverPool;
  if (!pool) throw new Error("数据源驱动连接池未初始化");

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, input.timeoutMs));
  timer.unref?.();

  let columns: ColumnInfo[] = [];
  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        if (input.signal?.aborted) reject(new SqlAbortedError());
        else if (timedOut) reject(new SqlTimeoutError());
      },
      { once: true },
    );
  });

  try {
    await Promise.race([
      pool.executeQuery(
        {
          sql,
          params: input.params ?? [],
          batchSize: BATCH_SIZE,
          maxRows: input.maxRows,
          timeoutMs: input.timeoutMs,
          signal: controller.signal,
        },
        async (batch) => {
          if (batch.columns.length > 0 && columns.length === 0) {
            columns = batch.columns;
          }
          if (shouldStop()) {
            controller.abort();
            return;
          }
          await consume(batch);
          if (shouldStop()) {
            controller.abort();
          }
        },
      ),
      timeoutPromise,
    ]);
    return columns;
  } catch (error) {
    if (input.signal?.aborted) throw new SqlAbortedError();
    if (timedOut) throw new SqlTimeoutError();
    // Stopping early after hitting maxRows intentionally aborts the driver stream.
    if (shouldStop()) return columns;
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onParentAbort);
  }
}

export function inferType(values: unknown[]): ColumnInfo["type"] {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "bigint") return "number";
    if (typeof value === "boolean") return "boolean";
    if (value instanceof Date) return "date";
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "string";
    if (typeof value === "object") return "json";
    return "string";
  }
  return "unknown";
}

async function streamMysql(
  input: ExecuteInput,
  sql: string,
  consume: (batch: Batch) => Promise<void>,
  shouldStop: () => boolean,
): Promise<ColumnInfo[]> {
  const pool = input.pool as MysqlPool;
  throwIfAborted(input.signal);
  let connection: MysqlConnection | null = null;
  let destroyed = false;
  let timedOut = false;
  let rejectAcquisitionTimeout: ((error: Error) => void) | undefined;

  const destroy = () => {
    destroyed = true;
    connection?.destroy();
  };
  const onAbort = () => {
    destroy();
    rejectAcquisitionTimeout?.(new SqlAbortedError());
  };

  // The timeout starts before pool acquisition: waiting for a free connection is
  // part of the query budget, not an unbounded prelude to it.
  const timer = setTimeout(() => {
    timedOut = true;
    destroy();
    rejectAcquisitionTimeout?.(new SqlTimeoutError());
  }, Math.max(1, input.timeoutMs));
  timer.unref?.();
  const acquisitionTimeout = new Promise<never>((_, reject) => {
    rejectAcquisitionTimeout = reject;
  });
  const acquisition = pool.getConnection();
  acquisition.then((late) => {
    if (timedOut || input.signal?.aborted) late.destroy();
  }).catch(() => undefined);

  try {
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      connection = await Promise.race([acquisition, acquisitionTimeout]);
    } catch (error) {
      if (input.signal?.aborted) throw new SqlAbortedError();
      if (timedOut) throw new SqlTimeoutError();
      throw error;
    }
    if (input.signal?.aborted) throw new SqlAbortedError();
    if (timedOut) throw new SqlTimeoutError();

    await (connection as MysqlConnection).query(
      `SET SESSION MAX_EXECUTION_TIME = ${Math.max(1, Math.floor(input.timeoutMs))}`,
    );

    // `mysql2/promise` connections wrap the callback-style connection: their
    // `query()` resolves to a result and has no `.on`/`.stream`. Streaming must go
    // through the underlying connection (still the same session and pool slot).
    const rawConnection = (
      connection as unknown as { connection?: { query: (options: unknown) => unknown } }
    ).connection;
    const querySource = (rawConnection ?? connection) as unknown as {
      query: (options: { sql: string; rowsAsArray: boolean; values?: unknown[] }) => unknown;
    };
    const query = querySource.query({
      sql,
      rowsAsArray: true,
      values: input.params,
    }) as unknown as {
      on(event: "fields", listener: (fields: Array<{ name: string }>) => void): unknown;
      stream(options?: { highWaterMark?: number }): AsyncIterable<unknown[]>;
    };
    let columns: ColumnInfo[] = [];
    query.on("fields", (fields) => {
      columns = fields.map((field) => ({ name: field.name, type: "unknown" as const }));
    });
    const stream = query.stream({ highWaterMark: BATCH_SIZE });

    let rows: unknown[][] = [];
    for await (const row of stream as AsyncIterable<unknown[]>) {
      if (shouldStop()) {
        destroy();
        break;
      }
      const values = Array.isArray(row) ? row : Object.values(row as Record<string, unknown>);
      rows.push(values);
      if (rows.length >= BATCH_SIZE) {
        await consume({ columns, rows });
        rows = [];
        if (shouldStop()) {
          destroy();
          break;
        }
      }
    }
    if (input.signal?.aborted) throw new SqlAbortedError();
    if (timedOut) throw new SqlTimeoutError();
    if (rows.length > 0) await consume({ columns, rows });
    return columns;
  } catch (error) {
    destroy();
    throw mapStreamError(error, input, timedOut);
  } finally {
    if (timer) clearTimeout(timer);
    rejectAcquisitionTimeout = undefined;
    input.signal?.removeEventListener("abort", onAbort);
    const active = connection as MysqlConnection | null;
    if (active && !destroyed) {
      await active.query("SET SESSION MAX_EXECUTION_TIME = 0").catch(() => undefined);
      active.release();
    }
  }
}

async function streamPostgres(
  input: ExecuteInput,
  sql: string,
  consume: (batch: Batch) => Promise<void>,
  shouldStop: () => boolean,
): Promise<ColumnInfo[]> {
  const pool = input.pool as PgPool;
  throwIfAborted(input.signal);
  let client: PoolClient | null = null;
  let failed = false;
  let released = false;
  let timedOut = false;
  let cursor: Cursor | null = null;
  let rejectAcquisitionTimeout: ((error: Error) => void) | undefined;

  const release = (destroy: boolean) => {
    if (released || !client) return;
    released = true;
    try {
      client.release(destroy);
    } catch {
      // The client may already be gone after a timeout/abort; nothing to do.
    }
  };
  const destroy = () => {
    failed = true;
    release(true);
  };
  const onAbort = () => {
    destroy();
    rejectAcquisitionTimeout?.(new SqlAbortedError());
  };

  const timer = setTimeout(() => {
    timedOut = true;
    destroy();
    rejectAcquisitionTimeout?.(new SqlTimeoutError());
  }, Math.max(1, input.timeoutMs));
  timer.unref?.();
  const acquisitionTimeout = new Promise<never>((_, reject) => {
    rejectAcquisitionTimeout = reject;
  });
  const acquisition = pool.connect();
  acquisition.then((late) => {
    if (timedOut || input.signal?.aborted) late.release(true);
  }).catch(() => undefined);

  try {
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      client = await Promise.race([acquisition, acquisitionTimeout]);
    } catch (error) {
      if (input.signal?.aborted) throw new SqlAbortedError();
      if (timedOut) throw new SqlTimeoutError();
      throw error;
    }
    if (input.signal?.aborted) throw new SqlAbortedError();
    if (timedOut) throw new SqlTimeoutError();

    await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(input.timeoutMs))}`);
    cursor = client.query(
      new Cursor(sql, input.params ?? [], { rowMode: "array" }) as never,
    ) as unknown as Cursor;

    let columns: ColumnInfo[] = [];
    while (true) {
      if (shouldStop()) {
        if (!input.signal?.aborted && !released) await closeCursor(cursor);
        break;
      }
      const { rows, result } = await readCursor(cursor, BATCH_SIZE);
      if (columns.length === 0) {
        columns = (result.fields as Array<{ name: string }>).map((field) => ({
          name: field.name,
          type: "unknown" as const,
        }));
      }
      if (rows.length === 0) break;
      await consume({ columns, rows });
      if (rows.length < BATCH_SIZE) break;
    }
    if (input.signal?.aborted) throw new SqlAbortedError();
    if (timedOut) throw new SqlTimeoutError();
    return columns;
  } catch (error) {
    failed = true;
    if (cursor && !released) await closeCursor(cursor);
    throw mapStreamError(error, input, timedOut);
  } finally {
    if (timer) clearTimeout(timer);
    rejectAcquisitionTimeout = undefined;
    input.signal?.removeEventListener("abort", onAbort);
    if (client && !failed && !released) {
      await client.query("RESET statement_timeout").catch(() => undefined);
    }
    release(failed);
  }
}

const SQLITE_CHILD_SCRIPT = `
const finish = (payload, exitCode) => {
  if (typeof process.send === "function") {
    process.send(payload, () => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
};

process.once("message", (msg) => {
  const Database = require(msg.betterSqlitePath);
  let db;
  try {
    db = new Database(msg.sqlitePath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 2000");
    const stmt = db.prepare(msg.sql);
    if (!stmt.reader) {
      throw new Error("只允许执行返回结果集的只读查询");
    }
    stmt.raw(true);
    const columns = stmt.columns().map((col) => ({
      name: col.name,
      type: "unknown",
    }));
    const params = Array.isArray(msg.params) ? msg.params : [];
    const iter = stmt.iterate(...params);
    let rows = [];
    let emitted = 0;
    const limit = msg.maxRows + 1;
    for (const row of iter) {
      rows.push(row);
      emitted += 1;
      if (rows.length >= msg.batchSize) {
        process.send({ type: "batch", columns, rows });
        rows = [];
      }
      if (emitted >= limit) break;
    }
    if (rows.length > 0) {
      process.send({ type: "batch", columns, rows });
    }
    try { db.close(); } catch {}
    db = undefined;
    finish({ type: "done", columns }, 0);
  } catch (err) {
    if (db) {
      try { db.close(); } catch {}
    }
    finish({
      type: "error",
      message: err && err.message ? err.message : String(err),
    }, 0);
  }
});
`;

type SqliteWorkerMessage =
  | { type: "batch"; columns: ColumnInfo[]; rows: unknown[][] }
  | { type: "done"; columns: ColumnInfo[] }
  | { type: "error"; message: string };

async function streamSqlite(
  input: ExecuteInput,
  sql: string,
  consume: (batch: Batch) => Promise<void>,
  shouldStop: () => boolean,
): Promise<ColumnInfo[]> {
  throwIfAborted(input.signal);
  if (!input.sqlitePath) {
    throw new Error("缺少 SQLite 文件路径");
  }
  const betterSqlitePath = require.resolve("better-sqlite3");

  return new Promise<ColumnInfo[]>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", SQLITE_CHILD_SCRIPT], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    });

    let settled = false;
    let timedOut = false;
    let stoppedEarly = false;
    let exited = false;
    let columns: ColumnInfo[] = [];
    let chain = Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    let stderrText = "";

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderrText.length < 2048) {
        stderrText += String(chunk);
      }
    });

    const waitForExit = (): Promise<void> => {
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve();
      }
      return new Promise<void>((done) => {
        child.once("exit", () => done());
        try {
          child.kill("SIGKILL");
        } catch {
          done();
        }
      });
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      input.signal?.removeEventListener("abort", onAbort);
    };

    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      void waitForExit().then(() => reject(err));
    };

    const finishSuccess = (cols: ColumnInfo[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      void waitForExit().then(() => resolve(cols));
    };

    const onAbort = () => {
      finishError(new SqlAbortedError());
    };

    timer = setTimeout(() => {
      timedOut = true;
      finishError(new SqlTimeoutError());
    }, Math.max(1, input.timeoutMs));
    timer.unref?.();

    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("message", (raw: unknown) => {
      const msg = raw as SqliteWorkerMessage;
      chain = chain.then(async () => {
        if (settled || stoppedEarly) return;
        if (msg.type === "error") {
          finishError(new Error(msg.message));
          return;
        }
        if (msg.columns.length > 0 && columns.length === 0) {
          columns = msg.columns;
        }
        if (msg.type === "batch") {
          await consume({ columns, rows: msg.rows });
          if (shouldStop()) {
            stoppedEarly = true;
            if (input.signal?.aborted) {
              finishError(new SqlAbortedError());
            } else {
              finishSuccess(columns);
            }
          }
          return;
        }
        if (msg.type === "done") {
          if (input.signal?.aborted) {
            finishError(new SqlAbortedError());
          } else if (timedOut) {
            finishError(new SqlTimeoutError());
          } else {
            finishSuccess(columns);
          }
        }
      }).catch((err: unknown) => {
        finishError(err instanceof Error ? err : new Error(String(err)));
      });
    });

    child.on("error", (err) => {
      finishError(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("exit", (code) => {
      exited = true;
      void chain.then(() => {
        if (settled) return;
        if (input.signal?.aborted) {
          finishError(new SqlAbortedError());
        } else if (timedOut) {
          finishError(new SqlTimeoutError());
        } else if (stoppedEarly) {
          finishSuccess(columns);
        } else if (code !== 0) {
          const detail = stderrText.trim();
          finishError(
            new Error(
              detail
                ? `SQLite 查询子进程异常退出（code ${code}）：${detail}`
                : `SQLite 查询子进程异常退出（code ${code}）`,
            ),
          );
        } else {
          finishSuccess(columns);
        }
      });
    });

    child.send({
      sqlitePath: input.sqlitePath,
      sql,
      params: input.params ?? [],
      maxRows: input.maxRows,
      batchSize: BATCH_SIZE,
      betterSqlitePath,
    });
  });
}

function mapStreamError(error: unknown, input: ExecuteInput, timedOut: boolean): Error {
  if (input.signal?.aborted) return new SqlAbortedError();
  if (timedOut || isTimeoutError(error)) return new SqlTimeoutError();
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isTimeoutError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ER_QUERY_TIMEOUT" || code === "57014" || code === "PROTOCOL_SEQUENCE_TIMEOUT") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|maximum statement execution time|statement timeout/i.test(message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SqlAbortedError();
}

async function closeCursor(cursor: Cursor): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    cursor.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 500);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function readCursor(
  cursor: Cursor,
  count: number,
): Promise<{ rows: unknown[][]; result: QueryResult }> {
  return new Promise((resolve, reject) => {
    cursor.read(count, (error, rows, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ rows: rows as unknown[][], result: result as QueryResult });
    });
  });
}
