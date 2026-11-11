import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { loadEvalCases } from "../src/eval/cases.js";
import { compareResultSets } from "../src/eval/compare.js";
import { queryFixture, resetFixture } from "../src/eval/fixture.js";

const run = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!run)("nl2sql fixture", () => {
  let mysqlContainer: Awaited<ReturnType<MySqlContainer["start"]>>;
  let pgContainer: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let mysqlPool: MysqlPool;
  let pgPool: PgPool;

  beforeAll(async () => {
    mysqlContainer = await new MySqlContainer("mysql:8.0").start();
    pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
    mysqlPool = createPool({
      host: mysqlContainer.getHost(),
      port: mysqlContainer.getPort(),
      database: mysqlContainer.getDatabase(),
      user: mysqlContainer.getUsername(),
      password: mysqlContainer.getUserPassword(),
    });
    pgPool = new PgPool({
      host: pgContainer.getHost(),
      port: pgContainer.getPort(),
      database: pgContainer.getDatabase(),
      user: pgContainer.getUsername(),
      password: pgContainer.getPassword(),
    });
    await resetFixture({ dialect: "mysql", pool: mysqlPool });
    await resetFixture({ dialect: "postgres", pool: pgPool });
  }, 240_000);

  afterAll(async () => {
    await mysqlPool?.end();
    await pgPool?.end();
    await mysqlContainer?.stop();
    await pgContainer?.stop();
  });

  it(
    "produces the same deterministic results on both engines for every golden case",
    async () => {
      const cases = loadEvalCases();
      for (const item of cases) {
        const expectedMysql = await queryFixture(
          { dialect: "mysql", pool: mysqlPool },
          item.mysql,
        );
        const expectedPostgres = await queryFixture(
          { dialect: "postgres", pool: pgPool },
          item.postgres,
        );
        const comparison = compareResultSets(expectedMysql, expectedPostgres, {
          ordered: item.ordered,
        });
        expect(comparison, `${item.id}: ${JSON.stringify(comparison)}`).toEqual({
          equal: true,
        });
      }
    },
    180_000,
  );

  it(
    "loads the fixture twice without leftover rows",
    async () => {
      await resetFixture({ dialect: "mysql", pool: mysqlPool });
      const result = await queryFixture(
        { dialect: "mysql", pool: mysqlPool },
        "SELECT COUNT(*) AS customer_count FROM customers",
      );
      expect(compareResultSets(result, { columns: ["customer_count"], rows: [[11]] })).toEqual({
        equal: true,
      });
    },
    120_000,
  );
});
