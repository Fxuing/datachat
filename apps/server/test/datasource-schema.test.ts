import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const introspectMock = vi.hoisted(() => ({
  introspectMysql: vi.fn(),
  introspectPostgres: vi.fn(),
}));

vi.mock("../src/agent/datasource/introspect.js", () => introspectMock);

import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import type { SchemaSnapshot } from "../src/agent/datasource/introspect.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { createDepartment, setUserDepartments } from "../src/db/repositories/departments.js";
import { replaceScopePolicies } from "../src/db/repositories/data-scope.js";
import { insertSemanticMetric, insertSemanticRelation } from "../src/db/repositories/semantic-layer.js";
import { insertSqlExample } from "../src/db/repositories/sql-examples.js";
import { datasources } from "../src/db/schema.js";
import { loadSchemaEntry, saveSchema, SCHEMA_CACHE_TTL_MS } from "../src/db/repositories/schema-cache.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

const snapshot: SchemaSnapshot = {
  refreshedAt: Date.now() - 1_000,
  tables: [
    {
      schema: "app",
      name: "users",
      comment: "用户",
      rowEstimate: 42,
      columns: [
        {
          name: "id",
          type: "int",
          nullable: false,
          defaultValue: null,
          comment: null,
        },
      ],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [],
    },
    {
      schema: "app",
      name: "orders",
      comment: null,
      rowEstimate: 0,
      columns: [],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

let db: Db;
let adminId: string;
let userId: string;
let adminCookie: string;
let userCookie: string;
let datasourceId: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  adminId = randomUUID();
  userId = randomUUID();
  insertUser(db, {
    id: adminId,
    username: "root",
    passwordHash: await hashPassword("admin-pass"),
    role: "admin",
    createdAt: Date.now(),
  });
  insertUser(db, {
    id: userId,
    username: "bob",
    passwordHash: await hashPassword("user-pass"),
    role: "user",
    createdAt: Date.now(),
  });
  const signer = createSessionSigner(config.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  userCookie = await signer.sign({ sub: userId, username: "bob", role: "user" });

  datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "analytics",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "app",
    username: "reader",
    passwordCipher: encryptSecret(
      "super-secret",
      deriveSecretKey(config.appSecret),
    ),
    createdBy: adminId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  introspectMock.introspectMysql.mockReset();
  introspectMock.introspectPostgres.mockReset();
  introspectMock.introspectMysql.mockResolvedValue(snapshot);
  introspectMock.introspectPostgres.mockResolvedValue(snapshot);
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

describe("datasource schema routes", () => {
  it("refreshes as admin and serves cached schema to granted users", async () => {
    const a = await app();

    const forbidden = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/schema`,
      cookies: { dc_session: userCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const notAdmin = await a.inject({
      method: "POST",
      url: `/api/datasources/${datasourceId}/refresh-schema`,
      cookies: { dc_session: userCookie },
    });
    expect(notAdmin.statusCode).toBe(403);

    const refreshed = await a.inject({
      method: "POST",
      url: `/api/datasources/${datasourceId}/refresh-schema`,
      cookies: { dc_session: adminCookie },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toEqual({ tableCount: 2, refreshedAt: snapshot.refreshedAt });
    expect(introspectMock.introspectMysql).toHaveBeenCalledTimes(1);
    expect(introspectMock.introspectMysql.mock.calls[0]?.[1]).toBe("app");

    const cached = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/schema`,
      cookies: { dc_session: adminCookie },
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.json().tables).toHaveLength(2);
    expect(cached.json()).toMatchObject({ total: 2, stale: false, error: null });
    expect(JSON.stringify(cached.json())).not.toContain("super-secret");

    replaceGrants(db, datasourceId, [userId]);
    const searched = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/schema?search=USERS`,
      cookies: { dc_session: userCookie },
    });
    expect(searched.statusCode).toBe(200);
    expect(searched.json().tables.map((table: { name: string }) => table.name)).toEqual(["users"]);
    expect(searched.json().total).toBe(1);
    await a.close();
  });

  it("refreshes postgres datasources through the pg introspector", async () => {
    const pgId = randomUUID();
    insertDatasource(db, {
      id: pgId,
      name: "warehouse",
      type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      database: "analytics",
      username: "reader",
      passwordCipher: encryptSecret("pg-secret", deriveSecretKey(config.appSecret)),
      createdBy: adminId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const a = await app();
    const refreshed = await a.inject({
      method: "POST",
      url: `/api/datasources/${pgId}/refresh-schema`,
      cookies: { dc_session: adminCookie },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(introspectMock.introspectPostgres).toHaveBeenCalledTimes(1);
    expect(introspectMock.introspectMysql).not.toHaveBeenCalled();
    await a.close();
  });

  it("returns 404 when nothing has been cached yet", async () => {
    const a = await app();
    const missing = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/schema`,
      cookies: { dc_session: adminCookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");

    saveSchema(db, datasourceId, {
      ...snapshot,
      refreshedAt: Date.now() - SCHEMA_CACHE_TTL_MS - 1,
    });
    const stale = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/schema`,
      cookies: { dc_session: adminCookie },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().stale).toBe(true);
    await a.close();
  });

  it("keeps the last good snapshot when a refresh fails and scrubs secrets", async () => {
    const a = await app();
    await a.inject({
      method: "POST",
      url: `/api/datasources/${datasourceId}/refresh-schema`,
      cookies: { dc_session: adminCookie },
    });

    introspectMock.introspectMysql.mockRejectedValueOnce(
      new Error("connect failed for password super-secret"),
    );
    const failed = await a.inject({
      method: "POST",
      url: `/api/datasources/${datasourceId}/refresh-schema`,
      cookies: { dc_session: adminCookie },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("DS_UNREACHABLE");
    expect(failed.json().error.message).not.toContain("super-secret");
    expect(failed.json().error.message).toContain("***");

    const entry = loadSchemaEntry(db, datasourceId);
    expect(entry?.snapshot.tables).toHaveLength(2);
    expect(entry?.error).toContain("***");

    const cached = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/schema`,
      cookies: { dc_session: adminCookie },
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.json().tables).toHaveLength(2);
    expect(cached.json().error).toContain("***");
    await a.close();
  });

  it("validates ids and rejects unknown datasources", async () => {
    const a = await app();
    const badId = await a.inject({
      method: "GET",
      url: "/api/datasources/not-a-uuid/schema",
      cookies: { dc_session: adminCookie },
    });
    expect(badId.statusCode).toBe(400);

    const unknown = await a.inject({
      method: "POST",
      url: `/api/datasources/${randomUUID()}/refresh-schema`,
      cookies: { dc_session: adminCookie },
    });
    expect(unknown.statusCode).toBe(404);
    await a.close();
  });

  it("enforces row-level data scope on schema and catalog and hides raw SQL", async () => {
    replaceGrants(db, datasourceId, [userId]);
    saveSchema(db, datasourceId, snapshot);

    insertSemanticMetric(db, {
      datasourceId,
      name: "订单总额",
      synonyms: ["GMV"],
      sqlExpression: "SUM(orders.amount)",
      tableName: "orders",
      timeColumn: "orders.paid_at",
      unit: "元",
      description: "已支付订单金额汇总",
    });
    insertSemanticMetric(db, {
      datasourceId,
      name: "用户数",
      sqlExpression: "COUNT(users.id)",
      tableName: "users",
    });
    insertSemanticRelation(db, {
      datasourceId,
      leftTable: "orders",
      leftColumn: "user_id",
      rightTable: "users",
      rightColumn: "id",
      joinType: "left",
      description: "订单关联下单用户",
    });
    insertSqlExample(db, {
      datasourceId,
      question: "上月订单总额是多少？",
      sqlText: "SELECT SUM(amount) FROM orders",
      tables: ["orders"],
    });
    insertSqlExample(db, {
      datasourceId,
      question: "用户表有多少人？",
      sqlText: "SELECT COUNT(*) FROM users",
      tables: ["users"],
    });

    db.update(datasources)
      .set({ dataScopeMode: "enabled" })
      .where(eq(datasources.id, datasourceId))
      .run();
    replaceScopePolicies(db, datasourceId, [
      { tableName: "orders", mode: "public", rules: [] },
      { tableName: "users", mode: "denied", rules: [] },
    ]);

    const a = await app();

    // Non-admin without any department gets 403 on schema and scopeNotice on catalog.
    const noDeptSchema = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/schema`,
      cookies: { dc_session: userCookie },
    });
    expect(noDeptSchema.statusCode).toBe(403);
    expect(noDeptSchema.json().error.code).toBe("DATA_SCOPE_NO_DEPARTMENT");

    const noDeptCatalog = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/catalog`,
      cookies: { dc_session: userCookie },
    });
    expect(noDeptCatalog.statusCode).toBe(200);
    expect(noDeptCatalog.json()).toMatchObject({
      tableCount: 0,
      metrics: [],
      relations: [],
      starterQuestions: [],
    });
    expect(noDeptCatalog.json().scopeNotice).toContain("部门");

    // Assign department: only non-denied tables & their semantic items are visible.
    const dept = createDepartment(db, { name: "运营部", code: "ops" });
    setUserDepartments(db, userId, [dept.id]);

    const scopedSchema = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/schema`,
      cookies: { dc_session: userCookie },
    });
    expect(scopedSchema.statusCode).toBe(200);
    expect(scopedSchema.json().tables.map((t: { name: string }) => t.name)).toEqual(["orders"]);

    const scopedCatalog = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/catalog`,
      cookies: { dc_session: userCookie },
    });
    expect(scopedCatalog.statusCode).toBe(200);
    const catalogBody = scopedCatalog.json();
    expect(catalogBody.tableCount).toBe(1);
    expect(catalogBody.metrics.map((m: { name: string }) => m.name)).toEqual(["订单总额"]);
    expect(catalogBody.relations).toEqual([]);
    expect(catalogBody.starterQuestions.map((q: { body: string }) => q.body)).toEqual([
      "上月订单总额是多少？",
      "按月统计最近 6 个月的订单总额变化趋势并拆解主要构成",
    ]);
    // Raw SQL expressions / SQL examples must not leak in catalog.
    expect(JSON.stringify(catalogBody)).not.toContain("SUM(orders.amount)");
    expect(JSON.stringify(catalogBody)).not.toContain("SELECT SUM(amount)");

    // Admin still sees every table and semantic entry.
    const adminCatalog = await a.inject({
      method: "GET",
      url: `/api/datasources/${datasourceId}/catalog`,
      cookies: { dc_session: adminCookie },
    });
    expect(adminCatalog.statusCode).toBe(200);
    expect(adminCatalog.json().tableCount).toBe(2);
    expect(adminCatalog.json().metrics).toHaveLength(2);
    expect(adminCatalog.json().relations).toHaveLength(1);

    await a.close();
  });
});
