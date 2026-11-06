import { describe, expect, it } from "vitest";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import {
  executeReadOnly,
  SqlAbortedError,
  SqlTimeoutError,
} from "../../src/agent/sql/executor.js";

const run = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!run)("executeReadOnly integration", () => {
  it(
    "streams a MySQL result with a row cap",
    async () => {
      const container = await new MySqlContainer("mysql:8.0").withDatabase("app").start();
      const pool: MysqlPool = createPool({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase(),
      });
      try {
        await pool.query("CREATE TABLE executor_users (id INT PRIMARY KEY, name VARCHAR(50))");
        await pool.query("INSERT INTO executor_users VALUES (1, 'a'), (2, 'b'), (3, 'c')");

        const seen: unknown[][] = [];
        const result = await executeReadOnly(
          {
            dialect: "mysql",
            pool,
            sql: "SELECT id, name FROM executor_users ORDER BY id",
            maxRows: 2,
            previewRows: 10,
            timeoutMs: 5000,
          },
          async (row) => {
            seen.push(row);
          },
        );

        expect(result.rowCount).toBe(2);
        expect(result.truncated).toBe(true);
        expect(seen).toHaveLength(2);
        expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);

        await expect(
          executeReadOnly(
            {
              dialect: "mysql",
              pool,
              sql: "SELECT SLEEP(5)",
              maxRows: 10,
              previewRows: 10,
              timeoutMs: 200,
            },
            async () => undefined,
          ),
        ).rejects.toBeInstanceOf(SqlTimeoutError);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        await expect(
          executeReadOnly(
            {
              dialect: "mysql",
              pool,
              sql: "SELECT SLEEP(5)",
              maxRows: 10,
              previewRows: 10,
              timeoutMs: 5000,
              signal: controller.signal,
            },
            async () => undefined,
          ),
        ).rejects.toBeInstanceOf(SqlAbortedError);
      } finally {
        await pool.end();
        await container.stop();
      }
    },
    120_000,
  );

  it(
    "streams a PostgreSQL result with column types",
    async () => {
      const container = await new PostgreSqlContainer("postgres:16-alpine")
        .withDatabase("app")
        .start();
      const pool = new PgPool({ connectionString: container.getConnectionUri() });
      try {
        await pool.query("CREATE TABLE executor_users (id INT PRIMARY KEY, name TEXT)");
        await pool.query("INSERT INTO executor_users VALUES (1, 'a'), (2, 'b')");

        const seen: unknown[][] = [];
        const result = await executeReadOnly(
          {
            dialect: "postgres",
            pool,
            sql: "SELECT id, name FROM executor_users ORDER BY id",
            maxRows: 100,
            previewRows: 10,
            timeoutMs: 5000,
          },
          async (row) => {
            seen.push(row);
          },
        );

        expect(result.rowCount).toBe(2);
        expect(result.truncated).toBe(false);
        expect(seen).toEqual([
          [1, "a"],
          [2, "b"],
        ]);
        expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
        expect(result.columns[0]?.type).toBe("number");
      } finally {
        await pool.end();
        await container.stop();
      }
    },
    120_000,
  );
});
