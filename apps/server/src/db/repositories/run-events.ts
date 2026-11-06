import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { runEvents } from "../schema.js";

export type RunEventRow = typeof runEvents.$inferSelect;

export interface AppendRunEventInput {
  runId: string;
  conversationId: string;
  type: string;
  payload: unknown;
}

/**
 * Appends the next event of a run. `max(seq)+1` and the insert share one
 * transaction, and `run_events_run_seq_unique` (migration 0001) rejects duplicates.
 */
export function appendRunEvent(
  db: Db,
  input: AppendRunEventInput,
): { seq: number; createdAt: number } {
  return db.transaction((tx) => {
    const row = tx
      .select({ maxSeq: sql<number | null>`max(${runEvents.seq})` })
      .from(runEvents)
      .where(eq(runEvents.runId, input.runId))
      .get();
    const seq = Number(row?.maxSeq ?? 0) + 1;
    const createdAt = Date.now();

    tx.insert(runEvents)
      .values({
        id: randomUUID(),
        runId: input.runId,
        conversationId: input.conversationId,
        seq,
        type: input.type,
        payloadJson: JSON.stringify(input.payload ?? null),
        createdAt,
      })
      .run();

    return { seq, createdAt };
  });
}

/** Replay support: everything after the client's `Last-Event-ID`. */
export function listRunEventsAfter(db: Db, runId: string, seq: number): RunEventRow[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, seq)))
    .orderBy(runEvents.seq)
    .all();
}

/**
 * Most recent `limit` events of a conversation, returned oldest-first so callers can
 * aggregate history in a single pass.
 */
export function listConversationEvents(
  db: Db,
  conversationId: string,
  limit: number = 200,
): RunEventRow[] {
  const rows = db
    .select()
    .from(runEvents)
    .where(eq(runEvents.conversationId, conversationId))
    .orderBy(desc(runEvents.seq), desc(runEvents.createdAt))
    .limit(limit)
    .all();
  return rows.reverse();
}
