import type { Pool as MysqlPool, PoolConnection as MysqlConnection } from "mysql2/promise";
import type { Pool as PgPool, PoolClient, QueryResult } from "pg";
import Cursor from "pg-cursor";
import { guardSql, type GuardErrorCode } from "./guard.js";
import type { ColumnInfo } from "../../services/artifacts.js";

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
  dialect: "mysql" | "postgres";
  pool: MysqlPool | PgPool;
  sql: string;
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
      dialect: input.dialect,
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
      input.dialect === "mysql"
        ? await streamMysql(input, sql, consume, shouldStop)
        : await streamPostgres(input, sql, consume, shouldStop);
    if (columnsRef.columns.length === 0 && streamedColumns.length > 0) {
      columnsRef.columns = streamedColumns;
    }
  } catch (error) {
    if (input.signal?.aborted) throw new SqlAbortedError();
    if (error instanceof SqlTimeoutError || error instanceof SqlAbortedError) throw error;
    if (isTimeoutError(error)) throw new SqlTimeoutError();
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

export function inferType(values: unknown[]): ColumnInfo["type"] {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "bigint") return "number";
    if (typeof value === "boolean") return "boolean";
    if (value instanceof Date) return "date";
    if (Buffer.isBuffer(value)) return "string";
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
  let timer: NodeJS.Timeout | undefined;
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
  timer = setTimeout(() => {
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

    const query = (connection as MysqlConnection).query({
      sql,
      rowsAsArray: true,
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
  let timer: NodeJS.Timeout | undefined;
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

  timer = setTimeout(() => {
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
      new Cursor(sql, [], { rowMode: "array" }) as never,
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
