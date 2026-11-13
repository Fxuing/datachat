import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  claimScheduledTask,
  createScheduledTask,
  createScheduledTaskRun,
  listDueScheduledTasks,
  listScheduledTaskRuns,
  updateScheduledTaskRun,
} from "../src/db/repositories/scheduled-tasks.js";
import {
  countUnreadNotifications,
  createNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../src/db/repositories/notifications.js";

let dataDir: string;
let handle: DbHandle;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-scheduled-"));
  handle = createDb(path.join(dataDir, "test.db"));
  migrateDb(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function taskInput(now = 1_000) {
  return {
    id: "task-1",
    userId: "user-1",
    name: "每日订单",
    prompt: "昨天的订单量",
    datasourceId: "ds-1",
    modelId: null,
    cronExpression: "0 9 * * *",
    timezone: "Asia/Shanghai",
    nextRunAt: now + 60_000,
    now,
  };
}

describe("scheduled task storage", () => {
  it("applies migration 0012 and defaults conversations to chat", () => {
    const tables = (
      handle.sqlite
        .prepare("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["scheduled_tasks", "scheduled_task_runs", "notifications"]),
    );
    const migrations = handle.sqlite
      .prepare("select count(*) as count from __drizzle_migrations")
      .get() as { count: number };
    expect(migrations.count).toBe(13);

    handle.sqlite
      .prepare(
        "insert into conversations (id, user_id, datasource_id, created_at, updated_at) values (?, ?, ?, ?, ?)",
      )
      .run("c-1", "u-1", "ds-1", 1, 1);
    expect(handle.sqlite.prepare("select kind from conversations where id = 'c-1'").pluck().get()).toBe(
      "chat",
    );
  });

  it("lists due tasks and lets only one claim win", () => {
    const task = createScheduledTask(handle.db, taskInput());
    expect(listDueScheduledTasks(handle.db, 1_000)).toEqual([]);
    expect(listDueScheduledTasks(handle.db, task.nextRunAt)).toHaveLength(1);

    expect(claimScheduledTask(handle.db, task.id, task.nextRunAt, 2_000, 1_100)).toBe(true);
    expect(claimScheduledTask(handle.db, task.id, task.nextRunAt, 3_000, 1_101)).toBe(false);
    expect(listDueScheduledTasks(handle.db, 1_500)).toEqual([]);
  });

  it("stores run history and marks interrupted runs failed", async () => {
    const task = createScheduledTask(handle.db, taskInput());
    createScheduledTaskRun(handle.db, {
      id: "run-1",
      taskId: task.id,
      trigger: "manual",
      status: "running",
      startedAt: 2_000,
      createdAt: 2_000,
    });
    updateScheduledTaskRun(handle.db, "run-1", {
      status: "success",
      reportId: "report-1",
      finishedAt: 3_000,
    });
    createScheduledTaskRun(handle.db, {
      id: "run-2",
      taskId: task.id,
      trigger: "schedule",
      status: "running",
      createdAt: 4_000,
    });

    const { failInterruptedScheduledRuns } = await import(
      "../src/db/repositories/scheduled-tasks.js"
    );
    expect(failInterruptedScheduledRuns(handle.db, 5_000)).toBe(1);
    const runs = listScheduledTaskRuns(handle.db, task.id);
    expect(runs.map((run) => [run.id, run.status])).toEqual([
      ["run-2", "failed"],
      ["run-1", "success"],
    ]);
  });
});

describe("notifications", () => {
  it("tracks unread state per user and is idempotent", () => {
    createNotification(handle.db, {
      id: "n-1",
      userId: "u-1",
      type: "task_success",
      title: "完成",
      body: "报告已生成",
      href: "/reports/r-1",
      createdAt: 1,
    });
    createNotification(handle.db, {
      id: "n-2",
      userId: "u-1",
      type: "task_failed",
      title: "失败",
      body: "查询超时",
      createdAt: 2,
    });
    createNotification(handle.db, {
      id: "n-3",
      userId: "u-2",
      type: "task_failed",
      title: "别人的",
      body: "不应看到",
      createdAt: 3,
    });

    expect(countUnreadNotifications(handle.db, "u-1")).toBe(2);
    expect(listNotifications(handle.db, "u-1").map((row) => row.id)).toEqual(["n-2", "n-1"]);
    expect(markNotificationRead(handle.db, "n-1", "u-2", 10)).toBe(false);
    expect(markNotificationRead(handle.db, "n-1", "u-1", 10)).toBe(true);
    expect(markNotificationRead(handle.db, "n-1", "u-1", 11)).toBe(false);
    expect(countUnreadNotifications(handle.db, "u-1")).toBe(1);
    expect(markAllNotificationsRead(handle.db, "u-1", 12)).toBe(1);
    expect(countUnreadNotifications(handle.db, "u-1")).toBe(0);
  });
});
