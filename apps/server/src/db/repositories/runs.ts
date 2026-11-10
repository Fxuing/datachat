import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../client.js";
import { runs } from "../schema.js";

export type RunStatus = "queued" | "running" | "ok" | "error" | "aborted";
export type RunRow = typeof runs.$inferSelect;

export interface CreateRunInput {
  conversationId: string;
  userId: string;
  modelId?: string | null;
  retryOfRunId?: string | null;
}

export function createRun(db: Db, input: CreateRunInput): RunRow {
  return db
    .insert(runs)
    .values({
      id: randomUUID(),
      conversationId: input.conversationId,
      userId: input.userId,
      modelId: input.modelId ?? null,
      retryOfRunId: input.retryOfRunId ?? null,
      status: "queued",
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

export interface MarkRunPatch {
  status?: RunStatus;
  startedAt?: number | null;
  endedAt?: number | null;
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

export function markRun(db: Db, id: string, patch: MarkRunPatch): void {
  const changes: Partial<typeof runs.$inferInsert> = {};
  if (patch.status !== undefined) changes.status = patch.status;
  if (patch.startedAt !== undefined) changes.startedAt = patch.startedAt;
  if (patch.endedAt !== undefined) changes.endedAt = patch.endedAt;
  if (patch.error !== undefined) changes.error = patch.error;
  if (patch.inputTokens !== undefined) changes.inputTokens = patch.inputTokens;
  if (patch.outputTokens !== undefined) changes.outputTokens = patch.outputTokens;
  if (patch.cacheReadTokens !== undefined) changes.cacheReadTokens = patch.cacheReadTokens;
  if (patch.cacheWriteTokens !== undefined) changes.cacheWriteTokens = patch.cacheWriteTokens;

  db.update(runs).set(changes).where(eq(runs.id, id)).run();
}

export function findRun(db: Db, id: string): RunRow | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

export function findOwnedRun(db: Db, id: string, userId: string): RunRow | undefined {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.userId, userId)))
    .get();
}

/** Ids of the original runs that a retry replaced; hide them from history. */
export function listReplacedRunIds(db: Db, conversationId: string): Set<string> {
  return new Set(
    db
      .select({ retryOfRunId: runs.retryOfRunId })
      .from(runs)
      .where(
        and(eq(runs.conversationId, conversationId), isNotNull(runs.retryOfRunId)),
      )
      .all()
      .flatMap((row) => (row.retryOfRunId ? [row.retryOfRunId] : [])),
  );
}

/** FIFO queue for a conversation; the concurrency guard picks the oldest waiting run. */
export function listQueuedRuns(db: Db, conversationId: string): RunRow[] {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), eq(runs.status, "queued")))
    .orderBy(asc(runs.createdAt))
    .all();
}

/** The queued/running run a reloaded client can reattach its SSE stream to. */
export function findActiveRunForConversation(
  db: Db,
  conversationId: string,
): RunRow | undefined {
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.conversationId, conversationId),
        inArray(runs.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .get();
}
