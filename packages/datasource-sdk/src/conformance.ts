import type {
  DatasourceDriver,
  QueryBatch,
  ResolvedConnectionConfig,
} from "./types.js";
import { validateDatasourceDriver } from "./helpers.js";

export interface DriverConformanceOptions {
  driver: DatasourceDriver;
  /** A valid connection configuration pointing to a test database instance. */
  config: ResolvedConnectionConfig;
  /** Simple read-only SELECT query that returns at least 1 row (e.g. `SELECT 1 AS ok`). */
  smokeQuery?: string;
  /** Optional invalid config to verify probe() fails cleanly without leaking password. */
  invalidConfig?: ResolvedConnectionConfig;
}

export interface ConformanceCheckResult {
  name: string;
  passed: boolean;
  error?: string;
}

/**
 * Framework-agnostic conformance verifier for custom DataChat datasource drivers.
 * Plugin authors can invoke this from Vitest/Jest/Node test suites to verify
 * manifest validity, probe behavior, introspection, streaming execution, and pool cleanup.
 */
export async function runDriverConformanceChecks(
  options: DriverConformanceOptions,
): Promise<{ ok: boolean; checks: ConformanceCheckResult[] }> {
  const checks: ConformanceCheckResult[] = [];
  const run = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      checks.push({ name, passed: true });
    } catch (err) {
      checks.push({
        name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await run("manifest_and_dialect_valid", () => {
    const res = validateDatasourceDriver(options.driver);
    if (!res.ok) throw new Error(res.reason);
  });

  await run("probe_succeeds", async () => {
    const result = await options.driver.probe(options.config);
    if (!result.ok) {
      throw new Error(`probe failed: ${result.error ?? "unknown error"}`);
    }
    if (!Array.isArray(result.warnings)) {
      throw new Error("probe.warnings must be an array");
    }
  });

  if (options.invalidConfig) {
    await run("probe_failure_scrubs_secret", async () => {
      const secret = options.invalidConfig!.password;
      const result = await options.driver.probe(options.invalidConfig!);
      if (result.ok) throw new Error("expected invalidConfig probe to fail");
      if (secret && result.error?.includes(secret)) {
        throw new Error("probe error leaked password");
      }
    });
  }

  const pool = options.driver.createPool(options.config);
  try {
    await run("introspect_returns_valid_snapshot", async () => {
      const snapshot = await pool.introspect();
      if (!Array.isArray(snapshot.tables)) {
        throw new Error("snapshot.tables must be an array");
      }
      if (typeof snapshot.refreshedAt !== "number") {
        throw new Error("snapshot.refreshedAt must be a number");
      }
    });

    await run("execute_query_streams_rows", async () => {
      const sql = options.smokeQuery ?? "SELECT 1 AS value";
      const batches: QueryBatch[] = [];
      await pool.executeQuery(
        { sql, params: [], batchSize: 100, maxRows: 10, timeoutMs: 10_000 },
        async (batch) => {
          batches.push(batch);
        },
      );
      const totalRows = batches.reduce((sum, b) => sum + b.rows.length, 0);
      if (totalRows < 1) {
        throw new Error(`expected at least 1 row from "${sql}", received 0`);
      }
    });
  } finally {
    await run("pool_closes_cleanly", async () => {
      await pool.close();
    });
  }

  return { ok: checks.every((c) => c.passed), checks };
}
