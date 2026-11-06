import { mkdtemp } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MySqlContainer } from "@testcontainers/mysql";
import mysql from "mysql2/promise";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { findDatasource, insertDatasource } from "../src/db/repositories/datasources.js";
import { queryAudit } from "../src/db/schema.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { PoolRegistry } from "../src/agent/datasource/pool.js";
import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import { runGuardedQuery } from "../src/services/query-service.js";
import { testConfig as config } from "./helpers/config.js";

const run = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!run)("runGuardedQuery", () => {
  let container: Awaited<ReturnType<MySqlContainer["start"]>>;
  let mysqlPool: mysql.Pool;
  let handle: DbHandle;
  let artifactsDir: string;

  beforeAll(async () => {
    container = await new MySqlContainer("mysql:8.0").start();
    mysqlPool = mysql.createPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getUserPassword(),
    });
    await mysqlPool.query("CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20))");
    await mysqlPool.query("INSERT INTO t VALUES (1,'a'),(2,'b')");
  });

  afterAll(async () => {
    await mysqlPool?.end();
    await container?.stop();
    handle?.sqlite.close();
    if (artifactsDir) await rm(artifactsDir, { recursive: true, force: true });
  });

  it("executes a select, stores artifact, and audits both paths", async () => {
    handle = createDb(":memory:");
    migrateDb(handle.db);
    insertUser(handle.db, {
      id: "u1",
      username: "alice",
      passwordHash: "not-used",
      role: "admin",
      createdAt: Date.now(),
    });
    const now = Date.now();
    insertDatasource(handle.db, {
      id: "d1",
      name: "test",
      type: "mysql",
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      username: container.getUsername(),
      passwordCipher: encryptSecret(
        container.getUserPassword(),
        deriveSecretKey(config.appSecret),
      ),
      sslMode: "disable",
      readOnlyVerified: 1,
      status: "ok",
      lastCheckedAt: now,
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });
    artifactsDir = await mkdtemp(path.join(tmpdir(), "dc-q-"));
    const deps = {
      db: handle.db,
      config,
      pools: new PoolRegistry(),
      artifacts: new ArtifactStore(handle.db, artifactsDir),
    };
    await deps.artifacts.init();

    const ds = findDatasource(handle.db, "d1")!;
    const ok = await runGuardedQuery(deps, {
      datasource: ds,
      userId: "u1",
      conversationId: "c1",
      runId: null,
      sql: "SELECT * FROM t ORDER BY id",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.rowCount).toBe(2);
      expect(ok.columns[0]?.name).toBe("id");
      expect(ok.previewRows).toHaveLength(2);
      const stored = await deps.artifacts.read(ok.artifactId);
      expect(stored?.rows).toHaveLength(2);
    }

    const rejected = await runGuardedQuery(deps, {
      datasource: ds,
      userId: "u1",
      conversationId: "c1",
      runId: null,
      sql: "DELETE FROM t",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("FORBIDDEN_STATEMENT");

    const audits = handle.db.select().from(queryAudit).all();
    expect(audits.map((a) => a.status).sort()).toEqual(["ok", "rejected"]);
    const okAudit = audits.find((a) => a.status === "ok");
    expect(okAudit?.rowCount).toBe(2);
    expect(okAudit?.durationMs).toBeGreaterThanOrEqual(0);
    await deps.pools.closeAll();
  });
});
