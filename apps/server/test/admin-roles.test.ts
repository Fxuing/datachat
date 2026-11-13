import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { queryAudit } from "../src/db/schema.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  listRoleIdsForUser,
  listRolePermissions,
  roleDetail,
  setUserRoles,
} from "../src/db/repositories/roles.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

let db: Db;
let adminId: string;
let userId: string;
let datasourceId: string;
let adminCookie: string;
let userCookie: string;

function insertDatasourceRow(id: string, name: string): void {
  insertDatasource(db, {
    id,
    name,
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
}

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
  datasourceId = randomUUID();
  insertDatasourceRow(datasourceId, "demo");
  const signer = createSessionSigner(config.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  userCookie = await signer.sign({ sub: userId, username: "bob", role: "user" });
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

async function createRoleViaApi(
  payload: Record<string, unknown> = {},
): Promise<{ statusCode: number; json: () => any }> {
  const a = await app();
  const response = await a.inject({
    method: "POST",
    url: "/api/admin/roles",
    cookies: { dc_session: adminCookie },
    payload: {
      name: "财务",
      description: "财务库",
      permissions: ["chat.use", "export.data"],
      datasourceIds: [datasourceId],
      ...payload,
    },
  });
  await a.close();
  return { statusCode: response.statusCode, json: () => response.json() };
}

describe("admin roles", () => {
  it("creates a role, lists it, and records an audit row", async () => {
    const created = await createRoleViaApi();
    expect(created.statusCode).toBe(201);
    const role = created.json().role;
    expect(role).toMatchObject({
      name: "财务",
      description: "财务库",
      isBuiltin: false,
      userCount: 0,
      permissionCount: 2,
      datasourceCount: 1,
      permissions: ["chat.use", "export.data"],
      datasourceIds: [datasourceId],
    });

    const a = await app();
    const list = await a.inject({
      method: "GET",
      url: "/api/admin/roles",
      cookies: { dc_session: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json().roles.find((row: { id: string }) => row.id === role.id);
    expect(listed).toMatchObject({ name: "财务", isBuiltin: false, userCount: 0 });
    expect(list.json().roles.find((row: { id: string }) => row.id === "role_member")).toMatchObject({
      name: "成员",
      isBuiltin: true,
    });

    const detail = await a.inject({
      method: "GET",
      url: `/api/admin/roles/${role.id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().role.permissions).toEqual(["chat.use", "export.data"]);

    const notFound = await a.inject({
      method: "GET",
      url: `/api/admin/roles/${randomUUID()}`,
      cookies: { dc_session: adminCookie },
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().error.code).toBe("NOT_FOUND");
    await a.close();

    const audits = db
      .select()
      .from(queryAudit)
      .where(eq(queryAudit.action, "role_change"))
      .all();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.sqlText).toBe("role:财务");
    expect(audits[0]!.userId).toBe(adminId);
    expect(JSON.parse(audits[0]!.detailJson!)).toMatchObject({
      roleId: role.id,
      action: "create",
      permissions: ["chat.use", "export.data"],
      datasourceIds: [datasourceId],
    });
  });

  it("rejects system permissions, unknown permissions, missing datasources, and duplicate names", async () => {
    const system = await createRoleViaApi({ name: "系统", permissions: ["admin.users"] });
    expect(system.statusCode).toBe(400);
    expect(system.json().error.code).toBe("SYSTEM_PERMISSION_NOT_ALLOWED");

    const unknown = await createRoleViaApi({ name: "未知", permissions: ["nope.use"] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe("VALIDATION");

    const missing = await createRoleViaApi({ name: "无库", datasourceIds: [randomUUID()] });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("DATASOURCE_NOT_FOUND");

    expect((await createRoleViaApi()).statusCode).toBe(201);
    const duplicate = await createRoleViaApi();
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CONFLICT");
  });

  it("updates a role and replaces its permissions and datasources", async () => {
    const created = await createRoleViaApi();
    const id = created.json().role.id;
    const secondDatasourceId = randomUUID();
    insertDatasourceRow(secondDatasourceId, "ops");

    const a = await app();
    const patched = await a.inject({
      method: "PATCH",
      url: `/api/admin/roles/${id}`,
      cookies: { dc_session: adminCookie },
      payload: {
        name: "财务组",
        permissions: ["chat.use"],
        datasourceIds: [secondDatasourceId],
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().role).toMatchObject({
      name: "财务组",
      permissions: ["chat.use"],
      datasourceIds: [secondDatasourceId],
    });

    const duplicate = await a.inject({
      method: "PATCH",
      url: `/api/admin/roles/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { name: "成员" },
    });
    expect(duplicate.statusCode).toBe(409);

    const missing = await a.inject({
      method: "PATCH",
      url: `/api/admin/roles/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { datasourceIds: [randomUUID()] },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("DATASOURCE_NOT_FOUND");

    const notFound = await a.inject({
      method: "PATCH",
      url: `/api/admin/roles/${randomUUID()}`,
      cookies: { dc_session: adminCookie },
      payload: { name: "ghost" },
    });
    expect(notFound.statusCode).toBe(404);
    await a.close();
  });

  it("protects the built-in member role from rename and delete but allows permission edits", async () => {
    const a = await app();
    const rename = await a.inject({
      method: "PATCH",
      url: "/api/admin/roles/role_member",
      cookies: { dc_session: adminCookie },
      payload: { name: "改名" },
    });
    expect(rename.statusCode).toBe(400);
    expect(rename.json().error.code).toBe("BUILTIN_ROLE");

    const remove = await a.inject({
      method: "DELETE",
      url: "/api/admin/roles/role_member",
      cookies: { dc_session: adminCookie },
    });
    expect(remove.statusCode).toBe(400);
    expect(remove.json().error.code).toBe("BUILTIN_ROLE");

    const edit = await a.inject({
      method: "PATCH",
      url: "/api/admin/roles/role_member",
      cookies: { dc_session: adminCookie },
      payload: { permissions: ["chat.use"], datasourceIds: [datasourceId] },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().role.permissions).toEqual(["chat.use"]);
    expect(edit.json().role.datasourceIds).toEqual([datasourceId]);
    expect(listRolePermissions(db, "role_member")).toEqual(["chat.use"]);
    await a.close();
  });

  it("denies non-admins", async () => {
    const a = await app();
    const list = await a.inject({
      method: "GET",
      url: "/api/admin/roles",
      cookies: { dc_session: userCookie },
    });
    expect(list.statusCode).toBe(403);

    const create = await a.inject({
      method: "POST",
      url: "/api/admin/roles",
      cookies: { dc_session: userCookie },
      payload: { name: "x", permissions: [], datasourceIds: [] },
    });
    expect(create.statusCode).toBe(403);
    await a.close();
  });

  it("refuses to delete a role that is still assigned", async () => {
    const created = await createRoleViaApi();
    const id = created.json().role.id;
    setUserRoles(db, userId, [id]);

    const a = await app();
    const removed = await a.inject({
      method: "DELETE",
      url: `/api/admin/roles/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json().error.code).toBe("ROLE_IN_USE");
    expect(roleDetail(db, id)).toBeDefined();
    expect(listRoleIdsForUser(db, userId)).toEqual([id]);
    await a.close();
  });

  it("deletes an unassigned role and records the audit detail", async () => {
    const created = await createRoleViaApi();
    const id = created.json().role.id;

    const a = await app();
    const removed = await a.inject({
      method: "DELETE",
      url: `/api/admin/roles/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
    expect(roleDetail(db, id)).toBeUndefined();

    const audits = db
      .select()
      .from(queryAudit)
      .where(eq(queryAudit.action, "role_change"))
      .all();
    const deleteAudit = audits.find(
      (row) => JSON.parse(row.detailJson!).action === "delete",
    );
    expect(JSON.parse(deleteAudit!.detailJson!)).toMatchObject({
      roleId: id,
      permissions: ["chat.use", "export.data"],
      datasourceIds: [datasourceId],
    });
    await a.close();
  });
});
