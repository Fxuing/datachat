import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { createDepartment, setUserDepartments, updateDepartment } from "../src/db/repositories/departments.js";
import { saveSchema } from "../src/db/repositories/schema-cache.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { queryAudit } from "../src/db/schema.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;
const DS_ID = "11111111-1111-4111-8111-111111111111";

let db: Db;
let adminId: string;
let userId: string;
let adminCookie: string;
let departmentId: string;

function seedSchema(): void {
  saveSchema(db, DS_ID, {
    refreshedAt: Date.now(),
    tables: [
      {
        schema: "demo",
        name: "orders",
        comment: null,
        rowEstimate: 1,
        columns: [
          { name: "id", type: "int", nullable: false, defaultValue: null, comment: null },
          { name: "dept_id", type: "varchar", nullable: true, defaultValue: null, comment: null },
        ],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
      {
        schema: "demo",
        name: "settings",
        comment: null,
        rowEstimate: 1,
        columns: [
          { name: "id", type: "int", nullable: false, defaultValue: null, comment: null },
          { name: "value", type: "text", nullable: true, defaultValue: null, comment: null },
        ],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
    ],
  });
}

beforeEach(async () => {
  db = createDb(":memory:").db;
  migrateDb(db);
  adminId = randomUUID();
  userId = randomUUID();
  insertUser(db, { id: adminId, username: "root", passwordHash: "x", role: "admin", createdAt: Date.now() });
  insertUser(db, { id: userId, username: "bob", passwordHash: "x", role: "user", createdAt: Date.now() });
  insertDatasource(db, {
    id: DS_ID,
    name: "demo",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "demo",
    username: "demo",
    passwordCipher: "cipher",
    createdBy: adminId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const signer = createSessionSigner(config.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  departmentId = createDepartment(db, { name: "销售", code: "sales" }).id;
  setUserDepartments(db, userId, [departmentId], departmentId);
  seedSchema();
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

async function putPolicies(a: Awaited<ReturnType<typeof buildApp>>, policies: unknown[]) {
  return a.inject({
    method: "PUT",
    url: `/api/admin/datasources/${DS_ID}/scope/policies`,
    cookies: { dc_session: adminCookie },
    payload: { policies },
  });
}

const SCOPED = {
  tableName: "orders",
  mode: "scoped",
  rules: [{ columnName: "dept_id", operator: "in", valueMode: "department_id" }],
};
const PUBLIC = { tableName: "settings", mode: "public" };

describe("admin data scope", () => {
  it("returns scope config, coverage, and schema column candidates", async () => {
    await putPolicies(await app(), [SCOPED]);
    const a = await app();
    const scope = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/${DS_ID}/scope`,
      cookies: { dc_session: adminCookie },
    });
    expect(scope.statusCode).toBe(200);
    expect(scope.json().mode).toBe("off");
    expect(scope.json().coverage.policies.unclassified).toEqual(["settings"]);
    expect(scope.json().coverage.departments.unmapped).toBe(1);

    const columns = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/${DS_ID}/scope/columns`,
      cookies: { dc_session: adminCookie },
    });
    expect(columns.statusCode).toBe(200);
    expect(columns.json().candidates).toEqual([{ table: "orders", column: "dept_id" }]);
    await a.close();
  });

  it("refuses to enable until every table is classified", async () => {
    await putPolicies(await app(), [SCOPED]);
    const a = await app();
    const blocked = await a.inject({
      method: "POST",
      url: `/api/admin/datasources/${DS_ID}/scope/enable`,
      cookies: { dc_session: adminCookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("SCOPE_COVERAGE_INCOMPLETE");
    expect(blocked.json().error.unclassified).toEqual(["settings"]);

    await putPolicies(a, [SCOPED, PUBLIC]);
    const enabled = await a.inject({
      method: "POST",
      url: `/api/admin/datasources/${DS_ID}/scope/enable`,
      cookies: { dc_session: adminCookie },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().mode).toBe("enabled");

    const disabled = await a.inject({
      method: "POST",
      url: `/api/admin/datasources/${DS_ID}/scope/disable`,
      cookies: { dc_session: adminCookie },
    });
    expect(disabled.json().mode).toBe("off");
    await a.close();
  });

  it("requires department mappings for external value modes", async () => {
    await putPolicies(await app(), [
      {
        ...SCOPED,
        rules: [{ columnName: "dept_id", operator: "in", valueMode: "external_id" }],
      },
      PUBLIC,
    ]);
    const a = await app();
    const blocked = await a.inject({
      method: "POST",
      url: `/api/admin/datasources/${DS_ID}/scope/enable`,
      cookies: { dc_session: adminCookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain("组织映射");

    const mappings = await a.inject({
      method: "PUT",
      url: `/api/admin/datasources/${DS_ID}/scope/mappings`,
      cookies: { dc_session: adminCookie },
      payload: { mappings: [{ departmentCode: "sales", externalId: "S-1" }] },
    });
    expect(mappings.statusCode).toBe(200);
    expect(mappings.json().inserted).toBe(1);

    const enabled = await a.inject({
      method: "POST",
      url: `/api/admin/datasources/${DS_ID}/scope/enable`,
      cookies: { dc_session: adminCookie },
    });
    expect(enabled.statusCode).toBe(200);
    await a.close();
  });

  it("imports mappings from CSV and reports row errors", async () => {
    const a = await app();
    const response = await a.inject({
      method: "PUT",
      url: `/api/admin/datasources/${DS_ID}/scope/mappings`,
      cookies: { dc_session: adminCookie },
      payload: {
        csv: "department_code,external_id,external_code\nsales,EXT-1,SC\nmissing,EXT-2,MC\n",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().inserted).toBe(1);
    expect(response.json().errors).toHaveLength(1);
    expect(response.json().errors[0]).toContain("missing");
    await a.close();
  });

  it("previews the rewritten SQL and lists diagnostics per user", async () => {
    await putPolicies(await app(), [SCOPED, PUBLIC]);
    const a = await app();
    const preview = await a.inject({
      method: "POST",
      url: `/api/admin/datasources/${DS_ID}/scope/preview`,
      cookies: { dc_session: adminCookie },
      payload: { userId, sql: "select * from orders" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().sql).toContain("SELECT * FROM (SELECT * FROM `orders`");
    expect(preview.json().params).toEqual([departmentId]);

    const diagnostics = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/${DS_ID}/scope/diagnostics?userId=${userId}`,
      cookies: { dc_session: adminCookie },
    });
    expect(diagnostics.statusCode).toBe(200);
    const orders = diagnostics.json().tables.find((row: { table: string }) => row.table === "orders");
    expect(orders.decision).toBe("scoped");
    expect(orders.rules).toEqual([
      {
        column: "dept_id",
        operator: "in",
        valueMode: "department_id",
        literalValues: [],
        nullVisible: false,
      },
    ]);
    expect(diagnostics.json().canAccessDatasource).toBe(false);
    await a.close();
  });

  it("lists scope denials and audits scope changes", async () => {
    const a = await app();
    await putPolicies(a, [SCOPED, PUBLIC]);
    db.insert(queryAudit)
      .values({
        id: randomUUID(),
        userId,
        datasourceId: DS_ID,
        action: "query",
        sqlText: "select * from orders",
        sqlHash: "hash",
        status: "rejected",
        scopeReason: "DATA_SCOPE_MAPPING_MISSING",
        createdAt: Date.now(),
      })
      .run();
    const denials = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/${DS_ID}/scope/denials`,
      cookies: { dc_session: adminCookie },
    });
    expect(denials.statusCode).toBe(200);
    expect(denials.json().denials).toHaveLength(1);
    expect(denials.json().denials[0].username).toBe("bob");
    expect(
      db
        .select()
        .from(queryAudit)
        .all()
        .some((row) => row.action === "data_scope_change"),
    ).toBe(true);
    await a.close();
  });

  it("returns 400 for DataScopeError in PUT /scope/policies", async () => {
    const a = await app();
    const invalidEq = await putPolicies(a, [
      {
        tableName: "orders",
        mode: "scoped",
        rules: [{ columnName: "dept_id", operator: "eq", valueMode: "department_id" }],
      },
    ]);
    expect(invalidEq.statusCode).toBe(400);
    expect(invalidEq.json().error.code).toBe("EQ_REQUIRES_SINGLE_VALUE");

    const duplicate = await putPolicies(a, [
      { tableName: "orders", mode: "public" },
      { tableName: "Orders", mode: "denied" },
    ]);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error.code).toBe("DUPLICATE_TABLE");
    await a.close();
  });

  it("checks active departments and required external fields when enabling", async () => {
    const archived = createDepartment(db, { name: "旧部门", code: "old" });
    updateDepartment(db, archived.id, { status: "archived" });

    const a = await app();
    await putPolicies(a, [
      {
        ...SCOPED,
        rules: [{ columnName: "dept_id", operator: "in", valueMode: "external_org_code" }],
      },
      PUBLIC,
    ]);
    await a.inject({
      method: "PUT",
      url: `/api/admin/datasources/${DS_ID}/scope/mappings`,
      cookies: { dc_session: adminCookie },
      payload: { mappings: [{ departmentCode: "sales", externalId: "S-1" }] },
    });

    // externalId is set, but externalOrgCode is still missing -> must refuse enable.
    const missingField = await a.inject({
      method: "POST",
      url: `/api/admin/datasources/${DS_ID}/scope/enable`,
      cookies: { dc_session: adminCookie },
    });
    expect(missingField.statusCode).toBe(409);

    await a.inject({
      method: "PUT",
      url: `/api/admin/datasources/${DS_ID}/scope/mappings`,
      cookies: { dc_session: adminCookie },
      payload: { mappings: [{ departmentCode: "sales", externalId: "S-1", externalOrgCode: "ORG-1" }] },
    });

    // Archived department has no mapping, but active department is mapped -> allowed.
    const enabled = await a.inject({
      method: "POST",
      url: `/api/admin/datasources/${DS_ID}/scope/enable`,
      cookies: { dc_session: adminCookie },
    });
    expect(enabled.statusCode).toBe(200);
    await a.close();
  });

  it("reports literal rules for admins and unconfigured tables in diagnostics, and deduplicates autoMatched", async () => {
    saveSchema(db, DS_ID, {
      refreshedAt: Date.now(),
      tables: [
        {
          schema: "demo",
          name: "orders",
          comment: null,
          rowEstimate: 1,
          columns: [
            { name: "id", type: "int", nullable: false, defaultValue: null, comment: null },
            { name: "dept_id", type: "varchar", nullable: true, defaultValue: null, comment: null },
            { name: "org_code", type: "varchar", nullable: true, defaultValue: null, comment: null },
            { name: "is_deleted", type: "int", nullable: true, defaultValue: null, comment: null },
          ],
          primaryKey: ["id"],
          indexes: [],
          foreignKeys: [],
        },
        {
          schema: "demo",
          name: "settings",
          comment: null,
          rowEstimate: 1,
          columns: [{ name: "id", type: "int", nullable: false, defaultValue: null, comment: null }],
          primaryKey: ["id"],
          indexes: [],
          foreignKeys: [],
        },
      ],
    });

    const a = await app();
    const columns = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/${DS_ID}/scope/columns`,
      cookies: { dc_session: adminCookie },
    });
    expect(columns.json().candidates).toHaveLength(2);
    expect(columns.json().autoMatched).toHaveLength(1);
    expect(columns.json().autoMatched[0].rules[0].columnName).toBe("dept_id");

    await putPolicies(a, [
      {
        tableName: "orders",
        mode: "scoped",
        rules: [
          { columnName: "dept_id", operator: "in", valueMode: "department_id" },
          { columnName: "is_deleted", operator: "eq", valueMode: "literal", literalValues: ["0"] },
        ],
      },
    ]);

    const adminDiag = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/${DS_ID}/scope/diagnostics?userId=${adminId}`,
      cookies: { dc_session: adminCookie },
    });
    expect(adminDiag.json().tables).toEqual([
      {
        table: "orders",
        decision: "scoped",
        rules: [
          {
            column: "is_deleted",
            operator: "eq",
            valueMode: "literal",
            literalValues: ["0"],
            nullVisible: false,
          },
        ],
      },
      { table: "settings", decision: "admin_all" },
    ]);

    const userDiag = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/${DS_ID}/scope/diagnostics?userId=${userId}`,
      cookies: { dc_session: adminCookie },
    });
    expect(userDiag.json().tables.find((row: { table: string }) => row.table === "settings")).toEqual({
      table: "settings",
      decision: "unconfigured",
    });
    await a.close();
  });
});
