import { randomUUID } from "node:crypto";
import { REPORT_MAX_ARTIFACTS, type Permission } from "@datachat/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { createConversation } from "../db/repositories/conversations.js";
import { findDatasource } from "../db/repositories/datasources.js";
import {
  countScheduledTasks,
  createScheduledTask,
  createScheduledTaskRun,
  deleteScheduledTask,
  findOwnedScheduledTask,
  listDueScheduledTasks,
  listScheduledTaskRuns,
  listScheduledTasks,
  claimScheduledTask,
  updateScheduledTask,
  updateScheduledTaskRun,
  type ScheduledTaskRow,
  type ScheduledTaskRunRow,
} from "../db/repositories/scheduled-tasks.js";
import { createNotification } from "../db/repositories/notifications.js";
import { createRun } from "../db/repositories/runs.js";
import { findUserById } from "../db/repositories/users.js";
import { canAccessDatasource, resolveUserAccess } from "../auth/access.js";
import { buildReportMarkdown, createReport, formatReportTitle } from "./reports.js";
import { validateSchedule, nextScheduleRun } from "./schedule.js";
import type { ArtifactStore } from "./artifacts.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import type { RuntimeManager } from "../agent/runtime.js";

export const SCHEDULED_TASK_LIMIT = 20;
export const SCHEDULED_RUN_TIMEOUT_MS = 10 * 60_000;
export const SCHEDULED_MAX_FAILURES = 3;
const MAX_NAME = 80;
const MAX_PROMPT = 4_000;

export class ScheduledTaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ScheduledTaskError";
  }
}

export interface ScheduledTaskView extends ScheduledTaskRow {
  datasourceName: string;
  lastRun: {
    status: string;
    error: string | null;
    reportId: string | null;
    finishedAt: number | null;
  } | null;
}

export interface ScheduledTaskInput {
  name: string;
  prompt: string;
  datasourceId: string;
  modelId?: string | null;
  cronExpression: string;
  timezone: string;
}

export interface ScheduledTaskServiceOptions {
  db: Db;
  config: AppConfig;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
  runtime: RuntimeManager;
  now?: () => number;
}

export interface ScheduledTaskService {
  list(userId: string): ScheduledTaskView[];
  get(userId: string, id: string): ScheduledTaskView;
  create(userId: string, input: ScheduledTaskInput): ScheduledTaskView;
  update(userId: string, id: string, input: Partial<ScheduledTaskInput> & { enabled?: boolean }): ScheduledTaskView;
  remove(userId: string, id: string): void;
  runNow(userId: string, id: string): Promise<ScheduledTaskRunRow>;
  sweep(now?: number): Promise<void>;
  shutdown(): Promise<void>;
}

function cleanText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text) throw new ScheduledTaskError("INVALID_INPUT", `${label}不能为空`);
  if (text.length > max) throw new ScheduledTaskError("INVALID_INPUT", `${label}不能超过 ${max} 字`);
  return text;
}

function toView(db: Db, task: ScheduledTaskRow): ScheduledTaskView {
  const datasource = findDatasource(db, task.datasourceId);
  const last = listScheduledTaskRuns(db, task.id, 1)[0];
  return {
    ...task,
    datasourceName: datasource?.name ?? "已删除的数据源",
    lastRun: last
      ? {
          status: last.status,
          error: last.error,
          reportId: last.reportId,
          finishedAt: last.finishedAt,
        }
      : null,
  };
}

export function createScheduledTaskService(
  options: ScheduledTaskServiceOptions,
): ScheduledTaskService {
  const { db, artifacts, runtime } = options;
  const now = options.now ?? Date.now;
  const activeUsers = new Set<string>();
  const activeTasks = new Map<string, Promise<ScheduledTaskRunRow>>();
  let activeCount = 0;
  let sweeping = false;
  const timers = new Map<string, NodeJS.Timeout>();

  function requireUser(userId: string, permissions: Permission[]): void {
    const user = findUserById(db, userId);
    if (!user || user.status !== "active") {
      throw new ScheduledTaskError("USER_DISABLED", "账号不可用", 403);
    }
    const access = resolveUserAccess(db, user);
    for (const permission of permissions) {
      if (!access.permissions.has(permission)) {
        throw new ScheduledTaskError("PERMISSION_DENIED", `缺少权限：${permission}`, 403);
      }
    }
  }

  function validateDatasource(userId: string, datasourceId: string): void {
    const user = findUserById(db, userId);
    if (!user) throw new ScheduledTaskError("USER_DISABLED", "账号不可用", 403);
    const access = resolveUserAccess(db, user);
    const datasource = findDatasource(db, datasourceId);
    if (!datasource) throw new ScheduledTaskError("DATASOURCE_NOT_FOUND", "数据源不存在", 404);
    if (!canAccessDatasource(access, datasourceId)) {
      throw new ScheduledTaskError("FORBIDDEN", "无权访问该数据源", 403);
    }
  }

  function validateScheduleOrThrow(input: { cronExpression: string; timezone: string }): void {
    const error = validateSchedule(input);
    if (error) throw new ScheduledTaskError(error.code, error.message);
  }

  function owner(userId: string, id: string): ScheduledTaskRow {
    const task = findOwnedScheduledTask(db, id, userId);
    if (!task) throw new ScheduledTaskError("TASK_NOT_FOUND", "定时任务不存在", 404);
    return task;
  }

  function notify(
    userId: string,
    type: "task_success" | "task_failed" | "task_disabled",
    title: string,
    body: string,
    href?: string,
  ): void {
    createNotification(db, {
      id: randomUUID(),
      userId,
      type,
      title,
      body,
      href: href ?? null,
      createdAt: now(),
    });
  }

  async function execute(task: ScheduledTaskRow, trigger: "schedule" | "manual"): Promise<ScheduledTaskRunRow> {
    const startedAt = now();
    const taskRun = createScheduledTaskRun(db, {
      id: randomUUID(),
      taskId: task.id,
      trigger,
      status: "running",
      startedAt,
      createdAt: startedAt,
    });
    const user = findUserById(db, task.userId);
    if (!user || user.status !== "active") {
      updateScheduledTaskRun(db, taskRun.id, {
        status: "skipped",
        error: "账号已禁用",
        finishedAt: now(),
      });
      updateScheduledTask(db, task.id, { enabled: false, lastStatus: "skipped", lastError: "账号已禁用", updatedAt: now() });
      return { ...taskRun, status: "skipped", error: "账号已禁用" };
    }
    const access = resolveUserAccess(db, user);
    if (!access.permissions.has("chat.use") || !access.permissions.has("report.create") || !canAccessDatasource(access, task.datasourceId)) {
      const reason = !canAccessDatasource(access, task.datasourceId)
        ? "已失去该数据源的访问权限"
        : "已失去对话或生成报告的权限";
      updateScheduledTaskRun(db, taskRun.id, { status: "skipped", error: reason, finishedAt: now() });
      updateScheduledTask(db, task.id, {
        enabled: false,
        lastStatus: "skipped",
        lastError: reason,
        updatedAt: now(),
      });
      notify(task.userId, "task_disabled", `定时任务已停用：${task.name}`, reason, "/scheduled");
      return { ...taskRun, status: "skipped", error: reason };
    }

    const conversation = createConversation(db, {
      userId: task.userId,
      datasourceId: task.datasourceId,
      title: `定时任务：${task.name}`,
      modelId: task.modelId,
      kind: "scheduled",
    });
    const run = createRun(db, {
      conversationId: conversation.id,
      userId: task.userId,
      modelId: task.modelId,
    });
    updateScheduledTaskRun(db, taskRun.id, { conversationId: conversation.id });
    taskRun.conversationId = conversation.id;

    let settled = false;
    let settle: (payload: { status: string; error?: string }) => void = () => undefined;
    const ended = new Promise<{ status: string; error?: string }>((resolve) => {
      settle = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
    });
    const unsubscribe = runtime.bus.subscribe(conversation.id, (live) => {
      if (live.runId !== run.id || live.event.type !== "run_end") return;
      settle(live.event.payload as { status: string; error?: string });
    });
    const timer = setTimeout(() => {
      runtime.abort(conversation.id, run.id);
      updateScheduledTaskRun(db, taskRun.id, { error: "任务执行超时", finishedAt: now() });
      settle({ status: "error", error: "任务执行超时" });
    }, SCHEDULED_RUN_TIMEOUT_MS);
    timers.set(taskRun.id, timer);

    try {
      const convRuntime = await runtime.getOrCreate(conversation, task.userId);
      convRuntime.enqueue({ runId: run.id, content: task.prompt, displayContent: task.prompt });
      const end = await ended;
      const error = end.status === "ok" ? null : (end.error ?? "任务执行失败");
      let reportId: string | null = null;
      if (!error) {
        const produced = artifacts.list({ runId: run.id, limit: REPORT_MAX_ARTIFACTS });
        if (produced.length === 0) {
          updateScheduledTaskRun(db, taskRun.id, {
            status: "failed",
            error: "本次任务没有生成可保存的查询结果",
            finishedAt: now(),
          });
          return failTask(task, "本次任务没有生成可保存的查询结果", taskRun);
        }
        const report = createReport({
          db,
          artifacts,
          userId: task.userId,
          conversationId: conversation.id,
          artifactIds: produced.map((item) => item.id),
          title: formatReportTitle(now()),
          markdown: `# ${task.name}\n\n> 问题：${task.prompt}\n\n${buildReportMarkdown(db, produced)}`,
        });
        if (!report.ok) {
          updateScheduledTaskRun(db, taskRun.id, {
            status: "failed",
            error: report.message,
            finishedAt: now(),
          });
          return failTask(task, report.message, taskRun);
        }
        reportId = report.report.id;
        updateScheduledTaskRun(db, taskRun.id, {
          status: "success",
          reportId,
          finishedAt: now(),
        });
        updateScheduledTask(db, task.id, {
          lastRunAt: now(),
          lastStatus: "success",
          lastError: null,
          consecutiveFailures: 0,
          updatedAt: now(),
        });
        notify(
          task.userId,
          "task_success",
          `定时任务已完成：${task.name}`,
          "已生成报告，点击查看。",
          `/reports/${reportId}`,
        );
        return { ...taskRun, status: "success", reportId, finishedAt: now() };
      }
      updateScheduledTaskRun(db, taskRun.id, { status: "failed", error, finishedAt: now() });
      return failTask(task, error, taskRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务执行失败";
      updateScheduledTaskRun(db, taskRun.id, { status: "failed", error: message, finishedAt: now() });
      return failTask(task, message, taskRun);
    } finally {
      clearTimeout(timer);
      timers.delete(taskRun.id);
      unsubscribe();
      await runtime.remove(conversation.id);
    }
  }

  function failTask(task: ScheduledTaskRow, message: string, taskRun: ScheduledTaskRunRow): ScheduledTaskRunRow {
    const failures = task.consecutiveFailures + 1;
    const disabled = failures >= SCHEDULED_MAX_FAILURES;
    updateScheduledTask(db, task.id, {
      lastRunAt: now(),
      lastStatus: "failed",
      lastError: message,
      consecutiveFailures: failures,
      ...(disabled ? { enabled: false } : {}),
      updatedAt: now(),
    });
    notify(task.userId, "task_failed", `定时任务失败：${task.name}`, message, "/scheduled");
    if (disabled) {
      notify(
        task.userId,
        "task_disabled",
        `定时任务已自动停用：${task.name}`,
        `连续失败 ${SCHEDULED_MAX_FAILURES} 次，请检查后手动重新启用。`,
        "/scheduled",
      );
    }
    return { ...taskRun, status: "failed", error: message };
  }

  return {
    list(userId) {
      return listScheduledTasks(db, userId).map((task) => toView(db, task));
    },

    get(userId, id) {
      return toView(db, owner(userId, id));
    },

    create(userId, input) {
      requireUser(userId, ["chat.use", "report.create"]);
      if (countScheduledTasks(db, userId) >= SCHEDULED_TASK_LIMIT) {
        throw new ScheduledTaskError("TASK_LIMIT", `最多创建 ${SCHEDULED_TASK_LIMIT} 个定时任务`);
      }
      validateDatasource(userId, input.datasourceId);
      validateScheduleOrThrow(input);
      const timestamp = now();
      const task = createScheduledTask(db, {
        id: randomUUID(),
        userId,
        name: cleanText(input.name, "任务名称", MAX_NAME),
        prompt: cleanText(input.prompt, "问题", MAX_PROMPT),
        datasourceId: input.datasourceId,
        modelId: input.modelId ?? null,
        cronExpression: input.cronExpression.trim(),
        timezone: input.timezone.trim(),
        nextRunAt: nextScheduleRun(input),
        now: timestamp,
      });
      return toView(db, task);
    },

    update(userId, id, input) {
      requireUser(userId, ["chat.use", "report.create"]);
      const task = owner(userId, id);
      if (input.datasourceId) validateDatasource(userId, input.datasourceId);
      if (input.cronExpression || input.timezone) {
        const next = {
          cronExpression: input.cronExpression?.trim() ?? task.cronExpression,
          timezone: input.timezone?.trim() ?? task.timezone,
        };
        validateScheduleOrThrow(next);
        input = { ...input, cronExpression: next.cronExpression, timezone: next.timezone };
      }
      const updated = updateScheduledTask(db, id, {
        ...(input.name !== undefined ? { name: cleanText(input.name, "任务名称", MAX_NAME) } : {}),
        ...(input.prompt !== undefined ? { prompt: cleanText(input.prompt, "问题", MAX_PROMPT) } : {}),
        ...(input.datasourceId !== undefined ? { datasourceId: input.datasourceId } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId ?? null } : {}),
        ...(input.cronExpression !== undefined ? { cronExpression: input.cronExpression } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.cronExpression || input.timezone
          ? { nextRunAt: nextScheduleRun({ cronExpression: input.cronExpression ?? task.cronExpression, timezone: input.timezone ?? task.timezone }) }
          : {}),
        updatedAt: now(),
      });
      return toView(db, updated ?? task);
    },

    remove(userId, id) {
      owner(userId, id);
      deleteScheduledTask(db, id);
    },

    async runNow(userId, id) {
      const task = owner(userId, id);
      if (activeTasks.has(task.id)) {
        throw new ScheduledTaskError("TASK_RUNNING", "任务正在执行", 409);
      }
      if (activeCount >= 2 || activeUsers.has(task.userId)) {
        throw new ScheduledTaskError("TASK_BUSY", "当前执行队列已满，请稍后再试", 409);
      }
      const promise = execute(task, "manual");
      activeTasks.set(task.id, promise);
      activeCount += 1;
      activeUsers.add(task.userId);
      try {
        return await promise;
      } finally {
        activeTasks.delete(task.id);
        activeCount -= 1;
        activeUsers.delete(task.userId);
      }
    },

    async sweep(at = now()) {
      if (sweeping) return;
      sweeping = true;
      try {
        for (const task of listDueScheduledTasks(db, at)) {
          if (activeCount >= 2 || activeUsers.has(task.userId)) continue;
          const next = nextScheduleRun({
            cronExpression: task.cronExpression,
            timezone: task.timezone,
            from: at,
          });
          if (!claimScheduledTask(db, task.id, task.nextRunAt, next, at)) continue;
          const promise = execute(task, "schedule");
          activeCount += 1;
          activeUsers.add(task.userId);
          void promise.finally(() => {
            activeCount -= 1;
            activeUsers.delete(task.userId);
          });
        }
      } finally {
        sweeping = false;
      }
    },

    async shutdown() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled(activeTasks.values());
    },
  };
}
