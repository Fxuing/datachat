import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { queryAudit } from "../src/db/schema.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource, type DatasourceRow } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { createRun, findRun } from "../src/db/repositories/runs.js";
import {
  createDepartment,
  setUserDepartments,
} from "../src/db/repositories/departments.js";
import { upsertScopePolicy } from "../src/db/repositories/data-scope.js";
import { saveSchema } from "../src/db/repositories/schema-cache.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { runGuardedQuery } from "../src/services/query-service.js";
import { parseScopeSnapshot } from "../src/services/data-scope.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import { testConfig as config } from "./helpers/config.js";

let root: string;
let handle: DbHandle;
let artifacts: ArtifactStore;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-query-scope-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  artifacts = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await artifacts.init();
  insertUser(handle.db, {
    id: "admin",
    username: "admin",
    passwordHash: "not-used",
    role: "admin",
    createdAt: Date.now(),
  });
  insertDatasource(handle.db, datasourceRow());
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

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
    passwordCipher: encryptSecret("super-secret", deriveSecretKey(config.appSecret)),
    sslMode: "disable",
    optionsJson: null,
    readOnlyVerified: 1,
    allowWriteAccount: 0,
    dataScopeMode: "off",
    status: "ok",
    lastCheckedAt: null,
    createdBy: "admin",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function member(): string {
  insertUser(handle.db, {
    id: "u1",
    username: "alice",
    passwordHash: "not-used",
    role: "user",
    createdAt: Date.now(),
  });
  replaceGrants(handle.db, "d1", ["u1"]);
  return "u1";
}

/** Captures the SQL and bound params that actually reached the driver. */
function capturePool() {
  const captured: { sql: string | null; values: unknown[] | undefined; connections: number } = {
    sql: null,
    values: undefined,
    connections: 0,
  };
  const pool = {
    async getConnection() {
      captured.connections += 1;
      return {
        query(input: unknown) {
          if (typeof input === "string") return Promise.resolve([{}, []]);
          const options = input as { sql: string; values?: unknown[] };
          captured.sql = options.sql;
          captured.values = options.values;
          const listeners = new Map<string, (value: unknown) => void>();
          return {
            on(event: string, listener: (value: unknown) => void) {
              listeners.set(event, listener);
              return this;
            },
            stream() {
              listeners.get("fields")?.([{ name: "id" }]);
              return (async function* rows() {
                yield [1];
              })();
            },
          };
        },
        destroy() {},
        release() {},
      };
    },
  };
  const registry = {
    get: () => ({ mysql: pool }),
    async closeAll() {},
  } as unknown as PoolRegistry;
  return { registry, captured };
}

function runAs(
  userId: string,
  sql: string,
  overrides: { runId?: string | null; datasource?: DatasourceRow } = {},
) {
  const { registry, captured } = capturePool();
  const promise = runGuardedQuery(
    { db: handle.db, config, pools: registry, artifacts },
    {
      datasource: overrides.datasource ?? datasourceRow({ dataScopeMode: "enabled" }),
      userId,
      conversationId: "c1",
      runId: overrides.runId ?? null,
      sql,
    },
  );
  return { promise, captured };
}

describe("runGuardedQuery with department scope", () => {
  it("rewrites scoped tables, binds department values, and snapshots the run", async () => {
    const userId = member();
    const sales = createDepartment(handle.db, { name: "销售", code: "sales" });
    const east = createDepartment(handle.db, { name: "华东", code: "east", parentId: sales.id });
    setUserDepartments(handle.db, userId, [sales.id]);
    upsertScopePolicy(handle.db, {
      datasourceId: "d1",
      tableName: "orders",
      mode: "scoped",
      rules: [{ columnName: "dept_id", operator: "in", valueMode: "department_id" }],
    });
    saveSchema(handle.db, "d1", {
      refreshedAt: Date.now(),
      tables: [
        {
          schema: "app",
          name: "orders",
          comment: null,
          rowEstimate: 1,
          columns: [
            { name: "id", type: "int", nullable: false, defaultValue: null, comment: null },
            { name: "dept_id", type: "int", nullable: true, defaultValue: null, comment: null },
          ],
          primaryKey: ["id"],
          indexes: [],
          foreignKeys: [],
        },
      ],
    });

    createConversation(handle.db, { userId, datasourceId: "d1", title: "t" });
    const run = createRun(handle.db, { conversationId: "c1", userId });

    const { promise, captured } = runAs(userId, "SELECT * FROM orders", { runId: run.id });
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(captured.connections).toBe(1);
    expect(captured.sql).toContain("`dept_id` IN (?, ?)");
    expect([...(captured.values ?? [])].sort()).toEqual([east.id, sales.id].sort());

    const stored = findRun(handle.db, run.id);
    expect(parseScopeSnapshot(stored?.scopeSnapshot ?? null)?.departments).toEqual(
      [sales.id, east.id].sort(),
    );
    const audit = handle.db.select().from(queryAudit).all();
    expect(audit[0]?.scopeReason).toBe("SCOPED");
  });

  it("rejects without a department before opening a pool or artifact", async () => {
    const userId = member();
    const { promise, captured } = runAs(userId, "SELECT * FROM orders");
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DATA_SCOPE_NO_DEPARTMENT");
      expect(result.reason).toContain("还没有加入任何部门");
    }
    expect(captured.connections).toBe(0);
    expect(handle.db.select().from(queryAudit).all()[0]?.scopeReason).toBe(
      "DATA_SCOPE_NO_DEPARTMENT",
    );
  });

  it("rejects denied tables and leaves the pool untouched", async () => {
    const userId = member();
    const sales = createDepartment(handle.db, { name: "销售", code: "sales" });
    setUserDepartments(handle.db, userId, [sales.id]);
    upsertScopePolicy(handle.db, { datasourceId: "d1", tableName: "salaries", mode: "denied" });

    const { promise, captured } = runAs(userId, "SELECT * FROM salaries");
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DATA_SCOPE_DENIED_TABLE");
    expect(captured.connections).toBe(0);
  });

  it("rejects unconfigured tables when the datasource is enabled", async () => {
    const userId = member();
    const sales = createDepartment(handle.db, { name: "销售", code: "sales" });
    setUserDepartments(handle.db, userId, [sales.id]);

    const { promise, captured } = runAs(userId, "SELECT * FROM orders");
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DATA_SCOPE_TABLE_NOT_CONFIGURED");
    expect(captured.connections).toBe(0);
  });

  it("does not filter admins and keeps filtering off while configuring", async () => {
    createDepartment(handle.db, { name: "销售", code: "sales" });
    upsertScopePolicy(handle.db, {
      datasourceId: "d1",
      tableName: "orders",
      mode: "scoped",
      rules: [{ columnName: "dept_id", operator: "in", valueMode: "department_id" }],
    });

    const admin = await runAs("admin", "SELECT * FROM orders").promise;
    expect(admin.ok).toBe(true);
    const adminRun = runAs("admin", "SELECT * FROM orders");
    expect((await adminRun.promise).ok).toBe(true);
    const adminSql = adminRun.captured;
    expect(adminSql.sql).not.toContain("dept_id");

    const userId = member();
    const configuring = await runAs(userId, "SELECT * FROM orders", {
      datasource: datasourceRow({ dataScopeMode: "configuring" }),
    }).promise;
    expect(configuring.ok).toBe(true);
  });

  it("keeps global literal rules in effect for admins", async () => {
    upsertScopePolicy(handle.db, {
      datasourceId: "d1",
      tableName: "orders",
      mode: "scoped",
      rules: [
        { columnName: "dept_id", operator: "in", valueMode: "department_id" },
        { columnName: "is_deleted", operator: "eq", valueMode: "literal", literalValues: ["0"] },
      ],
    });

    const adminRun = runAs("admin", "SELECT * FROM orders");
    const result = await adminRun.promise;
    expect(result.ok).toBe(true);
    expect(adminRun.captured.sql).toContain("`is_deleted` = ?");
    expect(adminRun.captured.sql).not.toContain("`dept_id` IN");
    expect(adminRun.captured.values).toEqual(["0"]);
  });
});
