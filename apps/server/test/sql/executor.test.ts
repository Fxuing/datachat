import { describe, expect, it, vi } from "vitest";
import type { Pool as MysqlPool } from "mysql2/promise";
import type { Pool as PgPool } from "pg";
import {
  executeReadOnly,
  SqlAbortedError,
  SqlRejectedError,
  SqlTimeoutError,
} from "../../src/agent/sql/executor.js";

type Row = unknown[];

function createMysqlPool(rows: Row[] | "hang") {
  let cancel: ((error: Error) => void) | undefined;
  let executedSql: string | undefined;

  const connection = {
    query: (arg: unknown) => {
      if (typeof arg === "string") return Promise.resolve([{}, []]);
      executedSql = (arg as { sql: string }).sql;
      let fieldsHandler: ((fields: Array<{ name: string }>) => void) | undefined;
      const query = {
        on(event: string, handler: (...args: never[]) => void) {
          if (event === "fields") {
            fieldsHandler = handler as unknown as (fields: Array<{ name: string }>) => void;
          }
          return query;
        },
        stream() {
          if (rows === "hang") {
            return {
              [Symbol.asyncIterator]() {
                return {
                  next: () =>
                    new Promise<IteratorResult<Row>>((_resolve, reject) => {
                      cancel = reject;
                    }),
                };
              },
            };
          }
          return (async function* () {
            fieldsHandler?.([{ name: "id" }, { name: "name" }]);
            for (const row of rows) {
              await Promise.resolve();
              yield row;
            }
          })();
        },
      };
      return query;
    },
    destroy: vi.fn(() => cancel?.(new Error("connection destroyed"))),
    release: vi.fn(),
  };

  return {
    pool: { getConnection: vi.fn(async () => connection) } as unknown as MysqlPool,
    connection,
    executedSql: () => executedSql,
  };
}

/** Mimics `mysql2/promise`: query() resolves, streaming lives on `.connection`. */
function createWrappedMysqlPool(rows: Row[]) {
  const fake = createMysqlPool(rows);
  const connection = {
    query: async () => [{}, []],
    connection: fake.connection,
    destroy: fake.connection.destroy,
    release: fake.connection.release,
  };
  return {
    pool: { getConnection: vi.fn(async () => connection) } as unknown as MysqlPool,
    connection,
  };
}

describe("executeReadOnly MySQL", () => {
  it("refuses a guard-rejected statement without touching the pool", async () => {
    const fake = createMysqlPool([]);
    const onRow = vi.fn(async () => undefined);

    await expect(
      executeReadOnly(
        {
          dialect: "mysql",
          pool: fake.pool,
          sql: "DELETE FROM users",
          maxRows: 100,
          previewRows: 10,
          timeoutMs: 1000,
          guard: {},
        },
        onRow,
      ),
    ).rejects.toMatchObject({ name: "SqlRejectedError", code: "FORBIDDEN_STATEMENT" });
    expect(fake.pool.getConnection).not.toHaveBeenCalled();
    expect(onRow).not.toHaveBeenCalled();
  });

  it("re-runs the guard and applies the auto-limit before execution", async () => {
    const fake = createMysqlPool([[1, "a"]]);
    await executeReadOnly(
      {
        dialect: "mysql",
        pool: fake.pool,
        sql: "SELECT id, name FROM users",
        maxRows: 100,
        previewRows: 10,
        timeoutMs: 1000,
        guard: {},
      },
      async () => undefined,
    );
    expect(fake.executedSql()).toContain("LIMIT 101");
  });

  it("streams rows, honors the row cap and flags truncation", async () => {
    const fake = createMysqlPool([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
    const seen: Row[] = [];
    const result = await executeReadOnly(
      {
        dialect: "mysql",
        pool: fake.pool,
        sql: "SELECT id, name FROM users",
        maxRows: 2,
        previewRows: 10,
        timeoutMs: 1000,
      },
      async (row) => {
        seen.push(row);
      },
    );

    expect(seen).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
    expect(result.previewRows).toEqual(seen);
    expect(fake.connection.release).toHaveBeenCalledTimes(1);
    expect(fake.connection.destroy).not.toHaveBeenCalled();
  });

  it("returns columns for a zero-row result (WHERE 1=0)", async () => {
    const fake = createMysqlPool([]);
    const result = await executeReadOnly(
      {
        dialect: "mysql",
        pool: fake.pool,
        sql: "SELECT id, name FROM users WHERE 1 = 0",
        maxRows: 10,
        previewRows: 10,
        timeoutMs: 1000,
        guard: {},
      },
      async () => undefined,
    );
    expect(result.rowCount).toBe(0);
    expect(result.columns).toEqual([
      { name: "id", type: "unknown" },
      { name: "name", type: "unknown" },
    ]);
    expect(fake.connection.release).toHaveBeenCalledTimes(1);
  });

  it("times out while waiting to acquire a connection", async () => {
    const fake = {
      pool: {
        getConnection: vi.fn(() => new Promise(() => undefined)),
      } as unknown as MysqlPool,
    };
    await expect(
      executeReadOnly(
        {
          dialect: "mysql",
          pool: fake.pool,
          sql: "SELECT 1",
          maxRows: 10,
          previewRows: 10,
          timeoutMs: 20,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlTimeoutError);
  });

  it("aborts while waiting for acquisition and disposes a late connection", async () => {
    let resolveConnection: ((connection: unknown) => void) | undefined;
    const late = {
      query: vi.fn(async () => [{}, []]),
      destroy: vi.fn(),
      release: vi.fn(),
    };
    const pool = {
      getConnection: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveConnection = resolve;
          }),
      ),
    } as unknown as MysqlPool;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      executeReadOnly(
        {
          dialect: "mysql",
          pool,
          sql: "SELECT 1",
          maxRows: 10,
          previewRows: 10,
          timeoutMs: 5000,
          signal: controller.signal,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlAbortedError);

    resolveConnection?.(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.destroy).toHaveBeenCalledTimes(1);
    expect(late.release).not.toHaveBeenCalled();
  });

  it("keeps only previewRows in memory", async () => {
    const fake = createMysqlPool([[1], [2], [3]]);
    const result = await executeReadOnly(
      {
        dialect: "mysql",
        pool: fake.pool,
        sql: "SELECT id FROM users",
        maxRows: 10,
        previewRows: 1,
        timeoutMs: 1000,
      },
      async () => undefined,
    );
    expect(result.rowCount).toBe(3);
    expect(result.previewRows).toEqual([[1]]);
  });

  it("times out a hung query with SqlTimeoutError", async () => {
    const fake = createMysqlPool("hang");
    await expect(
      executeReadOnly(
        {
          dialect: "mysql",
          pool: fake.pool,
          sql: "SELECT SLEEP(5)",
          maxRows: 10,
          previewRows: 10,
          timeoutMs: 20,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlTimeoutError);
  });

  it("cancels a running query with SqlAbortedError", async () => {
    const fake = createMysqlPool("hang");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      executeReadOnly(
        {
          dialect: "mysql",
          pool: fake.pool,
          sql: "SELECT SLEEP(5)",
          maxRows: 10,
          previewRows: 10,
          timeoutMs: 5000,
          signal: controller.signal,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlAbortedError);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const fake = createMysqlPool([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeReadOnly(
        {
          dialect: "mysql",
          pool: fake.pool,
          sql: "SELECT 1",
          maxRows: 10,
          previewRows: 10,
          timeoutMs: 1000,
          signal: controller.signal,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlAbortedError);
    expect(fake.pool.getConnection).not.toHaveBeenCalled();
  });
});

  it("streams through the raw connection of a mysql2/promise pool", async () => {
    const fake = createWrappedMysqlPool([
      [1, "a"],
      [2, "b"],
    ]);
    const seen: Row[] = [];

    const result = await executeReadOnly(
      {
        dialect: "mysql",
        pool: fake.pool,
        sql: "SELECT id, name FROM t",
        maxRows: 100,
        previewRows: 10,
        timeoutMs: 1000,
      },
      async (row) => {
        seen.push(row);
      },
    );

    expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
    expect(seen).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
  });

describe("executeReadOnly PostgreSQL", () => {
  it("refuses a guard-rejected statement without connecting", async () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as PgPool;

    await expect(
      executeReadOnly(
        {
          dialect: "postgres",
          pool,
          sql: "DROP TABLE users",
          maxRows: 100,
          previewRows: 10,
          timeoutMs: 1000,
          guard: {},
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlRejectedError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses a locked read without connecting", async () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as PgPool;
    await expect(
      executeReadOnly(
        {
          dialect: "postgres",
          pool,
          sql: "SELECT * FROM users FOR UPDATE",
          maxRows: 100,
          previewRows: 10,
          timeoutMs: 1000,
          guard: {},
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlRejectedError);
    expect(connect).not.toHaveBeenCalled();
  });
});
