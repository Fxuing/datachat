import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { userRoles } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

let db: Db;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
});

describe("GET /api/auth/me", () => {
  it("returns permissions and roles for a member", async () => {
    const userId = randomUUID();
    insertUser(db, {
      id: userId,
      username: "alice",
      passwordHash: await hashPassword("correct-password"),
      role: "user",
      createdAt: Date.now(),
    });
    db.insert(userRoles).values({ userId, roleId: "role_member" }).run();

    const app = await buildApp({ config, db, enableRateLimit: false });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "correct-password" },
    });
    expect(login.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { dc_session: login.cookies[0]!.value },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.username).toBe("alice");
    expect(body.permissions).toEqual(
      expect.arrayContaining([
        "chat.use",
        "skill.use",
        "mcp.use",
        "report.create",
        "share.create",
        "export.data",
      ]),
    );
    expect(body.permissions).not.toContain("admin.users");
    expect(body.roles).toEqual([{ id: "role_member", name: "成员" }]);
    await app.close();
  });
});
