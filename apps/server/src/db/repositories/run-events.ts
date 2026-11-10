import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
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

/** First event of a type in a run, used to replay the original prompt. */
export function findRunEvent(
  db: Db,
  runId: string,
  type: string,
): RunEventRow | undefined {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, type)))
    .orderBy(runEvents.seq)
    .limit(1)
    .get();
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
 * aggregate history in a single pass. Ordering follows global chronology
 * (`createdAt`), not the per-run `seq`, because two runs can interleave.
 *
 * `thinking_delta` frames are excluded: a long reasoning run can emit thousands of
 * them, and retaining them would push the conversation's `user_message` beyond the
 * window, making history render as empty.
 */
export function listConversationEvents(
  db: Db,
  conversationId: string,
  limit: number = 200,
): RunEventRow[] {
  const rows = db
    .select()
    .from(runEvents)
    .where(
      and(
        eq(runEvents.conversationId, conversationId),
        ne(runEvents.type, "thinking_delta"),
      ),
    )
    .orderBy(desc(runEvents.createdAt), desc(runEvents.seq))
    .limit(limit)
    .all();
  return rows.reverse();
}
