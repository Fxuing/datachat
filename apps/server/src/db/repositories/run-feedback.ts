import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import { runFeedback } from "../schema.js";

export type FeedbackRating = 1 | -1;

export interface RunFeedbackRow {
  id: string;
  runId: string;
  userId: string;
  rating: number;
  comment: string | null;
  createdAt: number;
  updatedAt: number;
}

export function upsertRunFeedback(
  db: Db,
  input: { runId: string; userId: string; rating: FeedbackRating; comment?: string | null },
): RunFeedbackRow {
  const now = Date.now();
  return db
    .insert(runFeedback)
    .values({
      id: randomUUID(),
      runId: input.runId,
      userId: input.userId,
      rating: input.rating,
      comment: input.comment ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [runFeedback.runId, runFeedback.userId],
      set: {
        rating: input.rating,
        comment: input.comment ?? null,
        updatedAt: now,
      },
    })
    .returning()
    .get();
}

export function deleteRunFeedback(db: Db, runId: string, userId: string): void {
  db.delete(runFeedback)
    .where(and(eq(runFeedback.runId, runId), eq(runFeedback.userId, userId)))
    .run();
}

export function listFeedbackForRuns(
  db: Db,
  runIds: string[],
  userId: string,
): Map<string, Pick<RunFeedbackRow, "rating" | "comment" | "updatedAt">> {
  if (runIds.length === 0) return new Map();
  const rows = db
    .select({
      runId: runFeedback.runId,
      rating: runFeedback.rating,
      comment: runFeedback.comment,
      updatedAt: runFeedback.updatedAt,
    })
    .from(runFeedback)
    .where(and(inArray(runFeedback.runId, runIds), eq(runFeedback.userId, userId)))
    .all();
  return new Map(rows.map((row) => [row.runId, row]));
}
