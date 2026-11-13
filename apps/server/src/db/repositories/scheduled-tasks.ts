import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Db } from "../client.js";
import { scheduledTaskRuns, scheduledTasks } from "../schema.js";

export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
export type ScheduledTaskRunRow = typeof scheduledTaskRuns.$inferSelect;
export type ScheduledTaskTrigger = "schedule" | "manual";
export type ScheduledTaskRunStatus = "running" | "success" | "failed" | "skipped";

export interface CreateScheduledTaskInput {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  datasourceId: string;
  modelId: string | null;
  cronExpression: string;
  timezone: string;
  nextRunAt: number;
  now: number;
}

export function createScheduledTask(db: Db, input: CreateScheduledTaskInput): ScheduledTaskRow {
  return db
    .insert(scheduledTasks)
    .values({
      id: input.id,
      userId: input.userId,
      name: input.name,
      prompt: input.prompt,
      datasourceId: input.datasourceId,
      modelId: input.modelId,
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      enabled: 1,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      consecutiveFailures: 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .get()!;
}

export function listScheduledTasks(db: Db, userId: string): ScheduledTaskRow[] {
  return db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.userId, userId))
    .orderBy(desc(scheduledTasks.createdAt))
    .all();
}

export function findScheduledTask(db: Db, id: string): ScheduledTaskRow | undefined {
  return db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
}

export function findOwnedScheduledTask(
  db: Db,
  id: string,
  userId: string,
): ScheduledTaskRow | undefined {
  return db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.userId, userId)))
    .get();
}

export interface UpdateScheduledTaskPatch {
  name?: string;
  prompt?: string;
  datasourceId?: string;
  modelId?: string | null;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: "success" | "failed" | "skipped";
  lastError?: string | null;
  consecutiveFailures?: number;
  updatedAt?: number;
}

export function updateScheduledTask(
  db: Db,
  id: string,
  patch: UpdateScheduledTaskPatch,
): ScheduledTaskRow | undefined {
  const { enabled, ...rest } = patch;
  const values: Partial<typeof scheduledTasks.$inferInsert> = { ...rest };
  if (enabled !== undefined) values.enabled = enabled ? 1 : 0;
  if (Object.keys(values).length === 0) return findScheduledTask(db, id);
  return db
    .update(scheduledTasks)
    .set(values)
    .where(eq(scheduledTasks.id, id))
    .returning()
    .get();
}

export function deleteScheduledTask(db: Db, id: string): boolean {
  return db.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).run().changes > 0;
}

export function listDueScheduledTasks(db: Db, now: number): ScheduledTaskRow[] {
  return db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, 1), lte(scheduledTasks.nextRunAt, now)))
    .orderBy(asc(scheduledTasks.nextRunAt))
    .all();
}

/**
 * Compare-and-set the next run time. Only one scheduler wins when multiple
 * sweeps observe the same due task.
 */
export function claimScheduledTask(
  db: Db,
  id: string,
  expectedNextRunAt: number,
  nextRunAt: number,
  now: number,
): boolean {
  const result = db
    .update(scheduledTasks)
    .set({ nextRunAt, updatedAt: now })
    .where(
      and(
        eq(scheduledTasks.id, id),
        eq(scheduledTasks.enabled, 1),
        eq(scheduledTasks.nextRunAt, expectedNextRunAt),
      ),
    )
    .run();
  return result.changes === 1;
}

export function countScheduledTasks(db: Db, userId: string): number {
  return db.select({ id: scheduledTasks.id }).from(scheduledTasks).where(eq(scheduledTasks.userId, userId)).all()
    .length;
}

export interface CreateScheduledTaskRunInput {
  id: string;
  taskId: string;
  trigger: ScheduledTaskTrigger;
  status: ScheduledTaskRunStatus;
  conversationId?: string | null;
  startedAt?: number | null;
  createdAt: number;
}

export function createScheduledTaskRun(
  db: Db,
  input: CreateScheduledTaskRunInput,
): ScheduledTaskRunRow {
  return db
    .insert(scheduledTaskRuns)
    .values({
      id: input.id,
      taskId: input.taskId,
      trigger: input.trigger,
      status: input.status,
      error: null,
      conversationId: input.conversationId ?? null,
      reportId: null,
      startedAt: input.startedAt ?? null,
      finishedAt: null,
      createdAt: input.createdAt,
    })
    .returning()
    .get()!;
}

export interface UpdateScheduledTaskRunPatch {
  status?: ScheduledTaskRunStatus;
  error?: string | null;
  conversationId?: string | null;
  reportId?: string | null;
  finishedAt?: number | null;
}

export function updateScheduledTaskRun(
  db: Db,
  id: string,
  patch: UpdateScheduledTaskRunPatch,
): void {
  if (Object.keys(patch).length === 0) return;
  db.update(scheduledTaskRuns).set(patch).where(eq(scheduledTaskRuns.id, id)).run();
}

export function listScheduledTaskRuns(
  db: Db,
  taskId: string,
  limit = 20,
): ScheduledTaskRunRow[] {
  return db
    .select()
    .from(scheduledTaskRuns)
    .where(eq(scheduledTaskRuns.taskId, taskId))
    .orderBy(desc(scheduledTaskRuns.createdAt))
    .limit(limit)
    .all();
}

/** Mark runs interrupted by a process restart as failed. */
export function failInterruptedScheduledRuns(db: Db, now: number): number {
  return db
    .update(scheduledTaskRuns)
    .set({
      status: "failed",
      error: "服务重启导致运行中断",
      finishedAt: now,
    })
    .where(eq(scheduledTaskRuns.status, "running"))
    .run().changes;
}
