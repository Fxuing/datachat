import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { createNotification } from "../src/db/repositories/notifications.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let db: Db;
let userId: string;
let cookie: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-notifications-routes-"));
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  userId = randomUUID();
  insertUser(db, {
    id: userId,
    username: "alice",
    passwordHash: "hash",
    role: "user",
    createdAt: Date.now(),
  });
  cookie = await createSessionSigner(testConfig.appSecret).sign({
    sub: userId,
    username: "alice",
    role: "user",
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function appFor() {
  return buildApp({
    config: {
      ...testConfig,
      dataDir: root,
      agentAuthPath: path.join(root, "agent", "auth.json"),
    },
    db,
    enableRateLimit: false,
  });
}

describe("notification routes", () => {
  it("lists unread notifications and marks them read", async () => {
    const id = randomUUID();
    createNotification(db, {
      id,
      userId,
      type: "task_failed",
      title: "任务失败",
      body: "每日订单执行失败",
      href: "/scheduled",
      createdAt: Date.now(),
    });
    const app = await appFor();
    try {
      const list = await app.inject({
        method: "GET",
        url: "/api/notifications",
        headers: { cookie: `dc_session=${cookie}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ unread: 1 });

      const read = await app.inject({
        method: "POST",
        url: `/api/notifications/${id}/read`,
        headers: { cookie: `dc_session=${cookie}` },
      });
      expect(read.statusCode).toBe(204);

      const after = await app.inject({
        method: "GET",
        url: "/api/notifications",
        headers: { cookie: `dc_session=${cookie}` },
      });
      expect(after.json()).toMatchObject({ unread: 0 });
    } finally {
      await app.close();
    }
  });

  it("does not mark another user's notification", async () => {
    const id = randomUUID();
    createNotification(db, {
      id,
      userId: randomUUID(),
      type: "task_success",
      title: "t",
      body: "b",
      href: null,
      createdAt: Date.now(),
    });
    const app = await appFor();
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/notifications/${id}/read`,
        headers: { cookie: `dc_session=${cookie}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("marks all as read", async () => {
    for (let index = 0; index < 2; index += 1) {
      createNotification(db, {
        id: randomUUID(),
        userId,
        type: "task_success",
        title: "t",
        body: "b",
        href: null,
        createdAt: Date.now(),
      });
    }
    const app = await appFor();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/notifications/read-all",
        headers: { cookie: `dc_session=${cookie}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().marked).toBe(2);
    } finally {
      await app.close();
    }
  });
});
