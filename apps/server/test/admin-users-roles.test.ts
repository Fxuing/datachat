import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { createRole } from "../src/db/repositories/roles.js";
import { queryAudit } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

let db: Db;
let adminId: string;
let adminCookie: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  adminId = randomUUID();
  insertUser(db, {
    id: adminId,
    username: "root",
    passwordHash: await hashPassword("admin-pass"),
    role: "admin",
    createdAt: Date.now(),
  });
  adminCookie = await createSessionSigner(config.appSecret).sign({
    sub: adminId,
    username: "root",
    role: "admin",
  });
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

async function createUser(payload: Record<string, unknown>) {
  const a = await app();
  const response = await a.inject({
    method: "POST",
    url: "/api/admin/users",
    cookies: { dc_session: adminCookie },
    payload,
  });
  await a.close();
  return response;
}

describe("admin user roles", () => {
  it("assigns the built-in member role when roleIds is omitted", async () => {
    const created = await createUser({ username: "carol", password: "carol-pass-123" });
    expect(created.statusCode).toBe(201);
    expect(created.json().user.roleIds).toEqual(["role_member"]);
    expect(created.json().user.roles).toEqual([{ id: "role_member", name: "成员" }]);

    const a = await app();
    const list = await a.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const carol = list.json().users.find((user: { username: string }) => user.username === "carol");
    expect(carol.roleIds).toEqual(["role_member"]);
    expect(carol.roles).toEqual([{ id: "role_member", name: "成员" }]);
    await a.close();

    const detail = db
      .select()
      .from(queryAudit)
      .all()
      .find((row) => row.action === "user_create");
    expect(JSON.parse(detail!.detailJson!)).toMatchObject({ roleIds: ["role_member"] });
  });

  it("assigns multiple roles on create and replaces them on patch", async () => {
    const analyst = createRole(db, {
      name: "analyst",
      permissions: ["chat.use", "export.data"],
    });
    const auditor = createRole(db, {
      name: "auditor",
      permissions: ["report.create"],
    });

    const created = await createUser({
      username: "dana",
      password: "dana-pass-123",
      roleIds: [analyst.id, auditor.id],
    });
    expect(created.statusCode).toBe(201);
    expect([...created.json().user.roleIds].sort()).toEqual([analyst.id, auditor.id].sort());
    expect(created.json().user.roles).toHaveLength(2);
    const userId = created.json().user.id;

    const a = await app();
    const updated = await a.inject({
      method: "PATCH",
      url: `/api/admin/users/${userId}`,
      cookies: { dc_session: adminCookie },
      payload: { roleIds: [auditor.id, "role_member"] },
    });
    expect(updated.statusCode).toBe(200);
    expect([...updated.json().user.roleIds].sort()).toEqual([auditor.id, "role_member"].sort());

    const list = await a.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
    });
    const dana = list.json().users.find((user: { username: string }) => user.username === "dana");
    expect([...dana.roleIds].sort()).toEqual([auditor.id, "role_member"].sort());
    expect(dana.roles.map((role: { id: string }) => role.id).sort()).toEqual(
      [auditor.id, "role_member"].sort(),
    );
    await a.close();

    const auditRows = db.select().from(queryAudit).all();
    const createDetail = JSON.parse(
      auditRows.find((row) => row.action === "user_create")!.detailJson!,
    );
    expect([...createDetail.roleIds].sort()).toEqual([analyst.id, auditor.id].sort());
    const updateDetail = JSON.parse(
      auditRows.find((row) => row.action === "user_update")!.detailJson!,
    );
    expect([...updateDetail.roleIds].sort()).toEqual([auditor.id, "role_member"].sort());
  });

  it("rejects an empty roleIds array on create and patch", async () => {
    const created = await createUser({
      username: "erin",
      password: "erin-pass-123",
      roleIds: [],
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error.code).toBe("ROLE_REQUIRED");
    expect(
      db.select().from(queryAudit).all().some((row) => row.action === "user_create"),
    ).toBe(false);

    const member = await createUser({ username: "frank", password: "frank-pass-123" });
    expect(member.statusCode).toBe(201);
    const userId = member.json().user.id;

    const a = await app();
    const cleared = await a.inject({
      method: "PATCH",
      url: `/api/admin/users/${userId}`,
      cookies: { dc_session: adminCookie },
      payload: { roleIds: [] },
    });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().error.code).toBe("ROLE_REQUIRED");

    const list = await a.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
    });
    const frank = list.json().users.find((user: { username: string }) => user.username === "frank");
    expect(frank.roleIds).toEqual(["role_member"]);
    await a.close();
  });

  it("rejects unknown roles without creating a user or changing assignments", async () => {
    const missingRole = randomUUID();
    const created = await createUser({
      username: "grace",
      password: "grace-pass-123",
      roleIds: [missingRole],
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error.code).toBe("UNKNOWN_ROLE");

    const a = await app();
    const list = await a.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
    });
    expect(
      list.json().users.some((user: { username: string }) => user.username === "grace"),
    ).toBe(false);
    expect(list.json().users).toHaveLength(1);

    const member = await createUser({ username: "heidi", password: "heidi-pass-123" });
    const userId = member.json().user.id;
    const rejected = await a.inject({
      method: "PATCH",
      url: `/api/admin/users/${userId}`,
      cookies: { dc_session: adminCookie },
      payload: { roleIds: [missingRole] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("UNKNOWN_ROLE");

    const after = await a.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
    });
    const heidi = after.json().users.find((user: { username: string }) => user.username === "heidi");
    expect(heidi.roleIds).toEqual(["role_member"]);
    await a.close();
  });
});
