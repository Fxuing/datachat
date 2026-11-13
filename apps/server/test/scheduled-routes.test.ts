import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { createScheduledTask } from "../src/db/repositories/scheduled-tasks.js";
import { createRole, replaceRolePermissions, setUserRoles } from "../src/db/repositories/roles.js";
import type { ScheduledTaskService } from "../src/services/scheduled-tasks.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let db: Db;
let userId: string;
let otherId: string;
let cookie: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-scheduled-routes-"));
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  userId = randomUUID();
  otherId = randomUUID();
  insertUser(db, { id: userId, username: "alice", passwordHash: "hash", role: "user", createdAt: Date.now() });
  insertUser(db, { id: otherId, username: "bob", passwordHash: "hash", role: "user", createdAt: Date.now() });
  const signer = createSessionSigner(testConfig.appSecret);
  cookie = await signer.sign({ sub: userId, username: "alice", role: "user" });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeService(): ScheduledTaskService {
  return {
    list: vi.fn(() => []),
    get: vi.fn(),
    create: vi.fn(() => ({ id: randomUUID() })) as never,
    update: vi.fn(() => ({ id: "x" })) as never,
    remove: vi.fn(),
    runNow: vi.fn(async () => ({ id: "run" })) as never,
    sweep: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
}

async function appFor(scheduledTasks: ScheduledTaskService) {
  return buildApp({
    config: { ...testConfig, dataDir: root, agentAuthPath: path.join(root, "agent", "auth.json") },
    db,
    enableRateLimit: false,
    scheduledTasks,
  });
}

describe("scheduled task routes", () => {
  it("creates a task for a member", async () => {
    const service = fakeService();
    const app = await appFor(service);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/scheduled-tasks",
        headers: { cookie: `dc_session=${cookie}` },
        payload: {
          name: "每日订单",
          prompt: "昨天的订单量",
          datasourceId: randomUUID(),
          cronExpression: "0 9 * * *",
          timezone: "Asia/Shanghai",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(service.create).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires report.create to create or update", async () => {
    const role = createRole(db, { name: "only-chat", description: null, permissions: [], datasourceIds: [] });
    replaceRolePermissions(db, role.id, ["chat.use"]);
    setUserRoles(db, userId, [role.id]);
    const app = await appFor(fakeService());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/scheduled-tasks",
        headers: { cookie: `dc_session=${cookie}` },
        payload: {
          name: "x",
          prompt: "y",
          datasourceId: randomUUID(),
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.permission).toBe("report.create");
    } finally {
      await app.close();
    }
  });

  it("hides other users' run history", async () => {
    const task = createScheduledTask(db, {
      id: randomUUID(),
      now: Date.now(),
      userId: otherId,
      name: "bob",
      prompt: "p",
      datasourceId: "ds",
      modelId: null,
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      nextRunAt: Date.now() + 60_000,
    });
    const app = await appFor(fakeService());
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/scheduled-tasks/${task.id}/runs`,
        headers: { cookie: `dc_session=${cookie}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 204 when deleting", async () => {
    const service = fakeService();
    const app = await appFor(service);
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/scheduled-tasks/${randomUUID()}`,
        headers: { cookie: `dc_session=${cookie}` },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });
});
