import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { listConversations } from "../src/db/repositories/conversations.js";
import { findScheduledTask, listScheduledTaskRuns } from "../src/db/repositories/scheduled-tasks.js";
import { listNotifications } from "../src/db/repositories/notifications.js";
import { findReport } from "../src/db/repositories/reports.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { createScheduledTaskService } from "../src/services/scheduled-tasks.js";
import { RuntimeManager } from "../src/agent/runtime.js";
import { PoolRegistry } from "../src/agent/datasource/pool.js";
import { FakeAgentSession } from "./helpers/fake-agent-session.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let handle: DbHandle;
let artifacts: ArtifactStore;
let manager: RuntimeManager;
let userId: string;
let datasourceId: string;
let behavior: "success" | "fail";

function sessionFactory() {
  return async ({
    conversation,
    userId: ownerId,
    runId,
  }: {
    conversation: { id: string };
    userId: string;
    runId: string;
  }): Promise<{ session: AgentSession }> => {
    if (behavior === "fail") {
      const session = new FakeAgentSession();
      session.prompt.mockRejectedValue(new Error("模型调用失败"));
      return { session: session as unknown as AgentSession };
    }
    const writer = artifacts.openResult({ userId: ownerId, conversationId: conversation.id, runId });
    await writer.write([["2026-11-12", 42]]);
    await writer.finish({
      columns: [
        { name: "day", type: "string" },
        { name: "orders", type: "number" },
      ],
      rowCount: 1,
      truncated: false,
    });
    const session = new FakeAgentSession();
    session.prompt.mockResolvedValue(undefined);
    return { session: session as unknown as AgentSession };
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-scheduled-exec-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  userId = randomUUID();
  insertUser(handle.db, {
    id: userId,
    username: "owner",
    passwordHash: "hash",
    role: "admin",
    createdAt: Date.now(),
  });
  datasourceId = randomUUID();
  insertDatasource(handle.db, {
    id: datasourceId,
    name: "sales",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "sales",
    username: "reader",
    passwordCipher: "cipher",
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  artifacts = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await artifacts.init();
  manager = new RuntimeManager({
    db: handle.db,
    config: { ...testConfig, dataDir: root },
    pools: new PoolRegistry(),
    artifacts,
    createSession: sessionFactory(),
    sweepIntervalMs: 0,
  });
  behavior = "success";
});

afterEach(async () => {
  await manager.shutdown();
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function service() {
  return createScheduledTaskService({
    db: handle.db,
    config: { ...testConfig, dataDir: root },
    pools: new PoolRegistry(),
    artifacts,
    runtime: manager,
  });
}

function taskInput() {
  return {
    name: "每日订单",
    prompt: "统计昨天的订单量",
    datasourceId,
    cronExpression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  };
}

describe("scheduled task execution", () => {
  it("runs a task into a report and a success notification", async () => {
    const tasks = service();
    const task = tasks.create(userId, taskInput());
    const run = await tasks.runNow(userId, task.id);

    expect(run.status).toBe("success");
    expect(run.reportId).toBeTruthy();
    const report = findReport(handle.db, run.reportId!);
    expect(report?.userId).toBe(userId);
    expect(report?.conversationId).toBe(run.conversationId);

    const conversations = listConversations(handle.db, userId);
    expect(conversations.map((row) => row.id)).not.toContain(run.conversationId);
    const scheduled = handle.sqlite
      .prepare("select kind from conversations where id = ?")
      .pluck()
      .get(run.conversationId);
    expect(scheduled).toBe("scheduled");

    const notifications = listNotifications(handle.db, userId);
    expect(notifications.some((row) => row.type === "task_success")).toBe(true);
    expect(listScheduledTaskRuns(handle.db, task.id)[0]?.status).toBe("success");
    expect(findScheduledTask(handle.db, task.id)?.consecutiveFailures).toBe(0);
  });

  it("does not move nextRunAt on a manual run", async () => {
    const tasks = service();
    const task = tasks.create(userId, taskInput());
    const before = task.nextRunAt;
    await tasks.runNow(userId, task.id);
    expect(findScheduledTask(handle.db, task.id)?.nextRunAt).toBe(before);
  });

  it("disables a task after three consecutive failures", async () => {
    behavior = "fail";
    const tasks = service();
    const task = tasks.create(userId, taskInput());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = await tasks.runNow(userId, task.id);
      expect(run.status).toBe("failed");
    }
    const updated = findScheduledTask(handle.db, task.id);
    expect(updated?.enabled).toBe(0);
    expect(updated?.consecutiveFailures).toBe(3);
    const notifications = listNotifications(handle.db, userId);
    expect(notifications.filter((row) => row.type === "task_failed")).toHaveLength(3);
    expect(notifications.some((row) => row.type === "task_disabled")).toBe(true);
  });

  it("skips and disables when the owner is no longer active", async () => {
    const tasks = service();
    const task = tasks.create(userId, taskInput());
    handle.sqlite.prepare("update users set status = 'disabled' where id = ?").run(userId);
    const run = await tasks.runNow(userId, task.id);
    expect(run.status).toBe("skipped");
    expect(findScheduledTask(handle.db, task.id)?.enabled).toBe(0);
  });
});
