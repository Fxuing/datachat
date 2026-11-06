import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import type { DatasourceRow } from "../src/db/repositories/datasources.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { runGuardedQuery } from "../src/services/query-service.js";
import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import { testConfig as config } from "./helpers/config.js";

let root: string;
let handle: DbHandle;
let artifacts: ArtifactStore;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-query-artifacts-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  artifacts = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await artifacts.init();
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

/** Minimal mysql2 pool: one query, one field event, two rows, then release. */
function fakeMysqlPool() {
  const pool = {
    async getConnection() {
      return {
        query(input: unknown) {
          if (typeof input === "string") return Promise.resolve([{}, []]);
          const listeners = new Map<string, (value: unknown) => void>();
          return {
            on(event: string, listener: (value: unknown) => void) {
              listeners.set(event, listener);
              return this;
            },
            stream() {
              listeners.get("fields")?.([{ name: "id" }, { name: "name" }]);
              return (async function* rows() {
                yield [1, "a"];
                yield [2, "b"];
              })();
            },
          };
        },
        destroy() {},
        release() {},
      };
    },
  };
  return { get: () => ({ mysql: pool }) } as unknown as PoolRegistry;
}

describe("runGuardedQuery artifact/audit ordering", () => {
  it("keeps a finalized artifact when the success audit insert fails", async () => {
    insertUser(handle.db, {
      id: "u1",
      username: "alice",
      passwordHash: "not-used",
      role: "admin",
      createdAt: Date.now(),
    });
    // Simulate an audit storage failure after the artifact row was committed.
    handle.sqlite.exec("DROP TABLE query_audit");

    const result = await runGuardedQuery(
      {
        db: handle.db,
        config,
        pools: fakeMysqlPool(),
        artifacts,
      },
      {
        datasource: datasourceRow(),
        userId: "u1",
        conversationId: "c1",
        runId: null,
        sql: "SELECT id, name FROM t",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(2);
    expect(result.auditId).toBe("");
    const record = artifacts.getForUser(result.artifactId, "u1");
    expect(record?.rowCount).toBe(2);
    expect(record?.conversationId).toBe("c1");
    expect(fs.existsSync(path.join(root, "artifacts", `${result.artifactId}.jsonl.gz`))).toBe(true);
  });
});
