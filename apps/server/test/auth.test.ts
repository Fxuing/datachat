import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { hashPassword } from "../src/auth/password.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir: "./data-test",
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  adminUsername: "admin",
  isProduction: false,
};

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
});
