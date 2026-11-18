import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { queryAudit } from "../src/db/schema.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;
const DS_ID = "11111111-1111-4111-8111-111111111111";

let db: Db;
let adminId: string;
let userId: string;
let adminCookie: string;
let userCookie: string;

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
  userCookie = await signer.sign({ sub: userId, username: "bob", role: "user" });
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

async function createDepartment(
  a: Awaited<ReturnType<typeof buildApp>>,
  payload: Record<string, unknown>,
) {
  return a.inject({
    method: "POST",
    url: "/api/admin/departments",
    cookies: { dc_session: adminCookie },
    payload,
  });
}

describe("admin departments", () => {
  it("creates a tree and lists it with counts", async () => {
    const a = await app();
    const sales = await createDepartment(a, { name: "销售", code: "sales" });
    expect(sales.statusCode).toBe(201);
    const salesId = sales.json().department.id;
    const east = await createDepartment(a, { name: "华东", code: "east", parentId: salesId });
    expect(east.statusCode).toBe(201);

    const members = await a.inject({
      method: "PUT",
      url: `/api/admin/users/${userId}/departments`,
      cookies: { dc_session: adminCookie },
      payload: { departmentIds: [salesId], primaryId: salesId },
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().departments).toEqual([
      { id: salesId, name: "销售", code: "sales", isPrimary: true },
    ]);

    const list = await a.inject({
      method: "GET",
      url: "/api/admin/departments",
      cookies: { dc_session: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().departments).toHaveLength(1);
    expect(list.json().departments[0].memberCount).toBe(1);
    expect(list.json().departments[0].children[0].name).toBe("华东");
    await a.close();
  });

  it("rejects cycles, duplicate codes, and non-empty deletes", async () => {
    const a = await app();
    const salesId = (await createDepartment(a, { name: "销售", code: "sales" })).json().department.id;
    const eastId = (await createDepartment(a, { name: "华东", code: "east", parentId: salesId }))
      .json().department.id;

    const cycle = await a.inject({
      method: "POST",
      url: `/api/admin/departments/${salesId}/move`,
      cookies: { dc_session: adminCookie },
      payload: { parentId: eastId },
    });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error.code).toBe("CYCLE");

    const duplicate = await createDepartment(a, { name: "重复", code: "sales" });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("DUPLICATE_CODE");

    const blocked = await a.inject({
      method: "DELETE",
      url: `/api/admin/departments/${salesId}`,
      cookies: { dc_session: adminCookie },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("HAS_CHILDREN");
    await a.close();
  });

  it("grants datasources to a department and inherits them downwards", async () => {
    const a = await app();
    const salesId = (await createDepartment(a, { name: "销售", code: "sales" })).json().department.id;
    const eastId = (await createDepartment(a, { name: "华东", code: "east", parentId: salesId }))
      .json().department.id;
    const put = await a.inject({
      method: "PUT",
      url: `/api/admin/departments/${salesId}/grants`,
      cookies: { dc_session: adminCookie },
      payload: { datasourceIds: [DS_ID] },
    });
    expect(put.statusCode).toBe(200);

    const eastGrants = await a.inject({
      method: "GET",
      url: `/api/admin/departments/${eastId}/grants`,
      cookies: { dc_session: adminCookie },
    });
    expect(eastGrants.json().datasourceIds).toEqual([DS_ID]);
    await a.close();
  });

  it("imports departments by parent code and reports row errors", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST",
      url: "/api/admin/departments/import",
      cookies: { dc_session: adminCookie },
      payload: {
        departments: [
          { name: "销售", code: "sales" },
          { name: "华东", code: "east", parentCode: "sales" },
          { name: "孤儿", code: "orphan", parentCode: "missing" },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().created).toBe(2);
    expect(response.json().errors).toHaveLength(1);
    expect(response.json().errors[0]).toContain("父部门编码不存在");
    await a.close();
  });

  it("exposes department names on /api/auth/me and admin user rows", async () => {
    const a = await app();
    const salesId = (await createDepartment(a, { name: "销售", code: "sales" })).json().department.id;
    await a.inject({
      method: "PUT",
      url: `/api/admin/users/${userId}/departments`,
      cookies: { dc_session: adminCookie },
      payload: { departmentIds: [salesId] },
    });

    const me = await a.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { dc_session: userCookie },
    });
    expect(me.json().departmentNames).toEqual(["销售"]);

    const users = await a.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
    });
    const bob = users.json().users.find((row: { username: string }) => row.username === "bob");
    expect(bob.departments.map((row: { name: string }) => row.name)).toEqual(["销售"]);
    await a.close();
  });

  it("denies the department API without the permission and audits changes", async () => {
    const a = await app();
    const denied = await a.inject({
      method: "GET",
      url: "/api/admin/departments",
      cookies: { dc_session: userCookie },
    });
    expect(denied.statusCode).toBe(403);
    await createDepartment(a, { name: "销售" });
    const audit = db.select().from(queryAudit).all();
    expect(audit.some((row) => row.action === "department_change")).toBe(true);
    await a.close();
  });
});
