import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { upsertSetting } from "../src/db/repositories/settings.js";
import { insertUser } from "../src/db/repositories/users.js";
import type { DatasourceRow } from "../src/db/repositories/datasources.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { runGuardedQuery } from "../src/services/query-service.js";
import {
  QUERY_LIMIT_CAPS,
  resolveQueryLimits,
  saveSettings,
} from "../src/services/app-settings.js";
import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import { testConfig as config } from "./helpers/config.js";

let root: string;
let handle: DbHandle;
let artifacts: ArtifactStore;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-query-settings-"));
  handle = createDb(":memory:");
  migrateDb(handle.db);
  artifacts = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await artifacts.init();
  insertUser(handle.db, {
    id: "u1",
    username: "alice",
    passwordHash: "not-used",
    role: "admin",
    createdAt: Date.now(),
  });
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function datasourceRow(): DatasourceRow {
  const now = Date.now();
  return {
    id: "d1",
    name: "test",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "app",
    username: "app",
    passwordCipher: encryptSecret("super-secret", deriveSecretKey(config.appSecret)),
    sslMode: "disable",
    optionsJson: null,
    readOnlyVerified: 1,
    status: "ok",
    lastCheckedAt: null,
    createdBy: "u1",
    createdAt: now,
    updatedAt: now,
  };
}

/** Fake mysql2 pool that records the guarded SQL and the session timeout. */
function fakeMysqlPool(rowCount: number) {
  const calls = { sql: [] as string[], maxExecutionMs: [] as number[] };
  const pool = {
    async getConnection() {
      return {
        query(input: unknown) {
          if (typeof input === "string") {
            const match = /MAX_EXECUTION_TIME = (\d+)/.exec(input);
            if (match) calls.maxExecutionMs.push(Number(match[1]));
            return Promise.resolve([{}, []]);
          }
          calls.sql.push((input as { sql: string }).sql);
          const listeners = new Map<string, (value: unknown) => void>();
          return {
            on(event: string, listener: (value: unknown) => void) {
              listeners.set(event, listener);
              return this;
            },
            stream() {
              listeners.get("fields")?.([{ name: "id" }]);
              return (async function* rows() {
                for (let index = 1; index <= rowCount; index += 1) yield [index];
              })();
            },
          };
        },
        destroy() {},
        release() {},
      };
    },
  };
  const pools = { get: () => ({ mysql: pool }) } as unknown as PoolRegistry;
  return { pools, calls };
}

async function run(rowCount = 10) {
  const { pools, calls } = fakeMysqlPool(rowCount);
  const result = await runGuardedQuery(
    { db: handle.db, config, pools, artifacts },
    {
      datasource: datasourceRow(),
      userId: "u1",
      conversationId: "c1",
      runId: null,
      sql: "SELECT id FROM t",
    },
  );
  return { result, calls };
}

describe("query settings at runtime", () => {
  it("uses config defaults when nothing is saved", async () => {
    const { result, calls } = await run(10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.sql).toEqual(["SELECT id FROM t\nLIMIT 1001"]);
    expect(calls.maxExecutionMs[0]).toBe(config.queryTimeoutMs);
    expect(result.guardedSql).toBe("SELECT id FROM t\nLIMIT 1001");
    expect(result.previewRows).toHaveLength(10);
  });

  it("applies saved limits to subsequent runs", async () => {
    saveSettings(handle.db, {
      queryMaxRows: 5,
      queryPreviewRows: 2,
      queryTimeoutMs: 9_000,
    });

    const first = await run(10);
    expect(first.result.ok).toBe(true);
    if (!first.result.ok) return;
    expect(first.calls.sql).toEqual(["SELECT id FROM t\nLIMIT 6"]);
    expect(first.calls.maxExecutionMs[0]).toBe(9_000);
    expect(first.result.previewRows).toEqual([[1], [2]]);
    expect(first.result.rowCount).toBe(5);
    expect(first.result.truncated).toBe(true);

    // A later admin change must affect the next run without a restart.
    saveSettings(handle.db, { queryMaxRows: 3 });
    const second = await run(10);
    expect(second.calls.sql).toEqual(["SELECT id FROM t\nLIMIT 4"]);
    if (second.result.ok) expect(second.result.rowCount).toBe(3);
  });

  it("clamps env defaults to the hard caps", () => {
    const limits = resolveQueryLimits(handle.db, {
      ...config,
      queryMaxRows: 9_999_999,
      queryPreviewRows: 9_999,
      queryTimeoutMs: 9_999_999,
    });
    expect(limits).toEqual(QUERY_LIMIT_CAPS);
  });

  it("ignores invalid stored values so they fall back to the defaults", async () => {
    upsertSetting(handle.db, "queryMaxRows", JSON.stringify(100_001));
    upsertSetting(handle.db, "queryPreviewRows", "not-json");
    upsertSetting(handle.db, "queryTimeoutMs", JSON.stringify(0));

    expect(resolveQueryLimits(handle.db, config)).toEqual({
      maxRows: config.queryMaxRows,
      previewRows: config.queryPreviewRows,
      timeoutMs: config.queryTimeoutMs,
    });
    const { calls } = await run(10);
    expect(calls.sql).toEqual(["SELECT id FROM t\nLIMIT 1001"]);
    expect(calls.maxExecutionMs[0]).toBe(config.queryTimeoutMs);
  });
});
