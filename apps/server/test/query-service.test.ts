import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { queryAudit, users } from "../src/db/schema.js";
import { insertUser } from "../src/db/repositories/users.js";
import type { DatasourceRow } from "../src/db/repositories/datasources.js";
import { recordAudit } from "../src/services/audit.js";
import { runGuardedQuery, type QueryServiceDeps } from "../src/services/query-service.js";
import type { ArtifactStore } from "../src/services/artifacts.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { testConfig as config } from "./helpers/config.js";

function setup() {
  const { db } = createDb(":memory:");
  migrateDb(db);
  return db;
}

function datasourceRow(overrides: Partial<DatasourceRow> = {}): DatasourceRow {
  const now = Date.now();
  return {
    id: "d1",
    name: "test",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "app",
    username: "app",
    passwordCipher: "unused-by-rejected-paths",
    sslMode: "disable",
    optionsJson: null,
    readOnlyVerified: 0,
    status: "ok",
    lastCheckedAt: null,
    createdBy: "u1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Deps whose pools/artifacts fail loudly if a rejected query ever reaches them. */
function rejectionDeps(db: QueryServiceDeps["db"]) {
  const calls = { poolGets: 0, artifactOpens: 0 };
  const deps: QueryServiceDeps = {
    db,
    config,
    pools: {
      get() {
        calls.poolGets += 1;
        throw new Error("pool must not be acquired for a rejected query");
      },
      async closeAll() {},
    } as unknown as PoolRegistry,
    artifacts: {
      openResult() {
        calls.artifactOpens += 1;
        throw new Error("artifact must not be opened for a rejected query");
      },
    } as unknown as ArtifactStore,
  };
  return { deps, calls };
}

describe("audit", () => {
  it("hashes sql and persists rejected statements", () => {
    const db = setup();
    recordAudit(db, {
      runId: null,
      conversationId: null,
      userId: "u1",
      datasourceId: "d1",
      action: "query",
      sqlText: "DELETE FROM users",
      status: "rejected",
      errorMessage: "不允许的语句类型",
    });
    const row = db.select().from(queryAudit).all()[0]!;
    expect(row.status).toBe("rejected");
    expect(row.sqlHash).toHaveLength(64);
    expect(config.queryMaxRows).toBe(1000);
  });
});

describe("runGuardedQuery", () => {
  it("rejects unsafe SQL before touching a pool or an artifact", async () => {
    const db = setup();
    insertUser(db, {
      id: "u1",
      username: "alice",
      passwordHash: "not-used",
      role: "admin",
      createdAt: Date.now(),
    });
    const { deps, calls } = rejectionDeps(db);

    const result = await runGuardedQuery(deps, {
      datasource: datasourceRow(),
      userId: "u1",
      conversationId: "c1",
      runId: null,
      sql: "DELETE FROM t",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN_STATEMENT");
    expect(calls).toEqual({ poolGets: 0, artifactOpens: 0 });

    const audit = db.select().from(queryAudit).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.status).toBe("rejected");
    expect(audit[0]?.sqlHash).toHaveLength(64);
  });

  it("denies datasource access before the guard and never reaches a pool", async () => {
    const db = setup();
    insertUser(db, {
      id: "u2",
      username: "bob",
      passwordHash: "not-used",
      role: "user",
      createdAt: Date.now(),
    });
    const { deps, calls } = rejectionDeps(db);

    const result = await runGuardedQuery(deps, {
      datasource: datasourceRow(),
      userId: "u2",
      conversationId: "c1",
      runId: null,
      sql: "SELECT 1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FORBIDDEN");
      expect(result.reason).toBe("无权访问该数据源");
    }
    expect(calls).toEqual({ poolGets: 0, artifactOpens: 0 });

    const audit = db.select().from(queryAudit).all();
    expect(audit.map((row) => row.status)).toEqual(["rejected"]);
  });

  it("fails closed for an unknown or disabled user", async () => {
    const db = setup();
    insertUser(db, {
      id: "u3",
      username: "carol",
      passwordHash: "not-used",
      role: "admin",
      createdAt: Date.now(),
    });
    db.update(users).set({ status: "disabled" }).where(eq(users.id, "u3")).run();
    const { deps, calls } = rejectionDeps(db);

    const unknown = await runGuardedQuery(deps, {
      datasource: datasourceRow(),
      userId: "missing",
      conversationId: null,
      runId: null,
      sql: "SELECT 1",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("FORBIDDEN");

    const disabled = await runGuardedQuery(deps, {
      datasource: datasourceRow(),
      userId: "u3",
      conversationId: null,
      runId: null,
      sql: "SELECT 1",
    });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.reason).toBe("用户已被禁用");

    expect(calls).toEqual({ poolGets: 0, artifactOpens: 0 });
  });

  it("allows an admin to reach the guard for an ungranted datasource", async () => {
    const db = setup();
    insertUser(db, {
      id: "u1",
      username: "alice",
      passwordHash: "not-used",
      role: "admin",
      createdAt: Date.now(),
    });
    const { deps, calls } = rejectionDeps(db);

    const result = await runGuardedQuery(deps, {
      datasource: datasourceRow(),
      userId: "u1",
      conversationId: null,
      runId: null,
      sql: "SELECT * INTO OUTFILE '/tmp/x' FROM t",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN_CONSTRUCT");
    expect(calls).toEqual({ poolGets: 0, artifactOpens: 0 });
  });
});
