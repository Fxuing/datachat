import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool as MysqlPool } from "mysql2/promise";
import type { Pool as PgPool } from "pg";
import { executeReadOnly, type ExecuteInput } from "../agent/sql/executor.js";
import type { QueryResultSet } from "./compare.js";

export type Dialect = "mysql" | "postgres";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../evals/nl2sql/fixtures",
);

export function fixtureStatements(dialect: Dialect, path?: string): string[] {
  const file = path ?? join(fixtureDir, `${dialect}.sql`);
  const script = readFileSync(file, "utf8");
  return script
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export interface FixtureTarget {
  dialect: Dialect;
  pool: ExecuteInput["pool"];
}

/**
 * Recreate the deterministic fixture. Statements run serially so the
 * DROP/CREATE order and foreign keys are respected on both engines.
 */
export async function resetFixture(target: FixtureTarget, path?: string): Promise<void> {
  for (const statement of fixtureStatements(target.dialect, path)) {
    if (target.dialect === "mysql") {
      await (target.pool as MysqlPool).query(statement);
    } else {
      await (target.pool as PgPool).query(statement);
    }
  }
}

/**
 * Run SQL and materialize every row. Uses the same read-only executor as the
 * product so fixture results and graded SQL share one code path.
 */
export async function queryFixture(
  target: FixtureTarget,
  sql: string,
  maxRows = 10_000,
): Promise<QueryResultSet> {
  const result = await executeReadOnly(
    {
      dialect: target.dialect,
      pool: target.pool,
      sql,
      maxRows,
      previewRows: maxRows,
      timeoutMs: 30_000,
    },
    async () => {},
  );
  return {
    columns: result.columns.map((column) => column.name),
    rows: result.previewRows,
  };
}
