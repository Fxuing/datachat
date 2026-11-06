import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { queryAudit, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

let db: Db;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  insertUser(db, {
    id: "u1",
    username: "alice",
    passwordHash: await hashPassword("correct-password"),
    role: "user",
    createdAt: Date.now(),
  });
});

describe("auth", () => {
  it("logs in and returns the current user", async () => {
    const app = await buildApp({ config, db, enableRateLimit: false });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "correct-password" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies[0];
    expect(cookie?.name).toBe("dc_session");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { dc_session: cookie!.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("alice");
    await app.close();
  });

  it("rejects wrong password and missing session", async () => {
    const app = await buildApp({ config, db, enableRateLimit: false });
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const me = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it("audits successful and failed logins", async () => {
    const app = await buildApp({ config, db, enableRateLimit: false });
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "correct-password" },
    });
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "wrong" },
    });
    const actions = db.select({ action: queryAudit.action }).from(queryAudit).all();
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["login", "login_failed"]),
    );
    await app.close();
  });

  it("rejects an admin route immediately after the user is demoted", async () => {
    const id = await makeAdmin("root");
    const app = await buildApp({ config, db, enableRateLimit: false });
    const cookie = await login(app, "root", "admin-password");
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/users", cookies: cookie })).statusCode,
    ).toBe(200);

    db.update(users).set({ role: "user" }).where(eq(users.id, id)).run();
    const denied = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      cookies: cookie,
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a disabled user with 401 on the next request", async () => {
    await makeAdmin("root");
    const app = await buildApp({ config, db, enableRateLimit: false });
    const cookie = await login(app, "root", "admin-password");

    db.update(users).set({ status: "disabled" }).where(eq(users.username, "root")).run();
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: cookie });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a deleted user with 401 and never returns a null user body", async () => {
    await makeAdmin("root");
    const app = await buildApp({ config, db, enableRateLimit: false });
    const cookie = await login(app, "root", "admin-password");

    db.delete(users).where(eq(users.username, "root")).run();
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: cookie });
    expect(me.statusCode).toBe(401);
    expect(me.json().user).toBeUndefined();
    await app.close();
  });

  it("normalizes default ports and compares the scheme for CSRF", async () => {
    const app = await buildApp({ config, db, enableRateLimit: false });
    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: "http://localhost:80", host: "localhost:80" },
    });
    expect(sameOrigin.statusCode).toBe(200);

    const crossScheme = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: "https://localhost", host: "localhost:80" },
    });
    expect(crossScheme.statusCode).toBe(403);

    const refererOnly = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { referer: "http://evil.example/page", host: "localhost:80" },
    });
    expect(refererOnly.statusCode).toBe(403);
    await app.close();
  });

  it("honors APP_ORIGIN as a trusted-origin escape hatch", async () => {
    const app = await buildApp({
      config: { ...config, appOrigins: ["https://chat.example.com"] },
      db,
      enableRateLimit: false,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: "https://chat.example.com", host: "internal:8080" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  async function makeAdmin(username: string): Promise<string> {
    const hash = await hashPassword("admin-password");
    const row = insertUser(db, {
      id: `admin-${username}`,
      username,
      passwordHash: hash,
      role: "admin",
      createdAt: Date.now(),
    });
    return row.id;
  }

  async function login(
    app: Awaited<ReturnType<typeof buildApp>>,
    username: string,
    password: string,
  ): Promise<{ dc_session: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    });
    expect(response.statusCode).toBe(200);
    return { dc_session: response.cookies[0]!.value };
  }
});
