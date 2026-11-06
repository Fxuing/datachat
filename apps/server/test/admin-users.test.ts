import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { queryAudit } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

const DS_ID = "11111111-1111-4111-8111-111111111111";

let db: Db;
let adminId: string;
let adminCookie: string;
let userCookie: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  adminId = randomUUID();
  const userId = randomUUID();
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
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

describe("admin users", () => {
  it("lists users for admin only", async () => {
    const a = await app();
    const ok = await a.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().users).toHaveLength(2);
    expect(JSON.stringify(ok.json())).not.toContain("passwordHash");

    const denied = await a.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: { dc_session: userCookie },
    });
    expect(denied.statusCode).toBe(403);
    await a.close();
  });

  it("creates a user and replaces grants", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
      payload: { username: "carol", password: "carol-pass-123", role: "user" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().user.id;

    // Usernames are normalized, so a case variant is a conflict.
    const duplicate = await a.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
      payload: { username: "CAROL", password: "carol-pass-123" },
    });
    expect(duplicate.statusCode).toBe(409);

    const granted = await a.inject({
      method: "PUT",
      url: `/api/admin/datasources/${DS_ID}/grants`,
      cookies: { dc_session: adminCookie },
      payload: { userIds: [id] },
    });
    expect(granted.statusCode).toBe(200);

    const list = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/${DS_ID}/grants`,
      cookies: { dc_session: adminCookie },
    });
    expect(list.json().userIds).toEqual([id]);
    const actions = db.select().from(queryAudit).all().map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["user_create", "grant_update"]));
    await a.close();
  });

  it("lets an admin edit themselves but not demote, disable, or lock out", async () => {
    const a = await app();

    const demote = await a.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      cookies: { dc_session: adminCookie },
      payload: { role: "user" },
    });
    expect(demote.statusCode).toBe(409);

    const disable = await a.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      cookies: { dc_session: adminCookie },
      payload: { status: "disabled" },
    });
    expect(disable.statusCode).toBe(409);

    const renameAndReset = await a.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      cookies: { dc_session: adminCookie },
      payload: { displayName: "Root Admin", password: "new-root-pass" },
    });
    expect(renameAndReset.statusCode).toBe(200);
    expect(renameAndReset.json().user.displayName).toBe("Root Admin");
    expect(JSON.stringify(renameAndReset.json())).not.toContain("passwordHash");

    const login = await a.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "root", password: "new-root-pass" },
    });
    expect(login.statusCode).toBe(200);
    await a.close();
  });

  it("keeps at least one active admin", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
      payload: { username: "dave", password: "dave-pass-123", role: "admin" },
    });
    expect(created.statusCode).toBe(201);
    const daveId = created.json().user.id;
    const daveCookie = await createSessionSigner(config.appSecret).sign({
      sub: daveId,
      username: "dave",
      role: "admin",
    });

    const demoteDave = await a.inject({
      method: "PATCH",
      url: `/api/admin/users/${daveId}`,
      cookies: { dc_session: adminCookie },
      payload: { role: "user" },
    });
    expect(demoteDave.statusCode).toBe(200);

    // Dave's token still claims admin, but the guard reloads the DB role and
    // rejects the demoted session before the route runs.
    const demoteRoot = await a.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      cookies: { dc_session: daveCookie },
      payload: { role: "user" },
    });
    expect(demoteRoot.statusCode).toBe(403);
    expect(demoteRoot.json().error.code).toBe("FORBIDDEN");
    await a.close();
  });
});
