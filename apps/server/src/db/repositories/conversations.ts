import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { artifacts, conversations, runEvents, runs } from "../schema.js";

export type ConversationRow = typeof conversations.$inferSelect;

export interface ConversationCursor {
  /** `coalesce(lastMessageAt, createdAt)` of the last row on the previous page. */
  sortTime: number;
  id: string;
}

export function encodeConversationCursor(cursor: ConversationCursor): string {
  return `${cursor.sortTime}:${cursor.id}`;
}

export function parseConversationCursor(raw: string): ConversationCursor | null {
  const separator = raw.lastIndexOf(":");
  if (separator <= 0) return null;
  const sortTime = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!Number.isSafeInteger(sortTime) || sortTime < 0 || !id) return null;
  return { sortTime, id };
}

export interface CreateConversationInput {
  userId: string;
  datasourceId: string;
  title?: string | null;
  modelId?: string | null;
  kind?: "chat" | "scheduled";
}

export function createConversation(db: Db, input: CreateConversationInput): ConversationRow {
  const now = Date.now();
  return db
    .insert(conversations)
    .values({
      id: randomUUID(),
      userId: input.userId,
      datasourceId: input.datasourceId,
      title: input.title ?? null,
      modelId: input.modelId ?? null,
      kind: input.kind ?? "chat",
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    })
    .returning()
    .get();
}

/**
 * Newest activity first. The cursor combines the activity timestamp with the id so
 * rows sharing a millisecond (and conversations that never received a message) are
 * all reachable exactly once.
 */
export function listConversations(
  db: Db,
  userId: string,
  opts: { limit?: number; before?: ConversationCursor; q?: string } = {},
): ConversationRow[] {
  const sortTime = sql<number>`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
  const conditions = [eq(conversations.userId, userId), eq(conversations.kind, "chat")];
  const keyword = opts.q?.trim();
  if (keyword) {
    // instr keeps % and _ literal, unlike LIKE; lower() covers ASCII case.
    conditions.push(
      sql<boolean>`instr(lower(coalesce(${conversations.title}, '')), lower(${keyword})) > 0`,
    );
  }
  if (opts.before) {
    conditions.push(
      or(
        lt(sortTime, opts.before.sortTime),
        and(eq(sortTime, opts.before.sortTime), lt(conversations.id, opts.before.id)),
      )!,
    );
  }

  return db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(sortTime), desc(conversations.id))
    .limit(opts.limit ?? 50)
    .all();
}

export function findConversation(db: Db, id: string): ConversationRow | undefined {
  return db.select().from(conversations).where(eq(conversations.id, id)).get();
}

export function findOwnedConversation(
  db: Db,
  id: string,
  userId: string,
): ConversationRow | undefined {
  return db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .get();
}

export interface UpdateConversationPatch {
  title?: string | null;
  modelId?: string | null;
  thinkingLevel?: string;
  piSessionFile?: string | null;
}

export function updateConversation(db: Db, id: string, patch: UpdateConversationPatch): void {
  const changes: Partial<typeof conversations.$inferInsert> = { updatedAt: Date.now() };
  if (patch.title !== undefined) changes.title = patch.title;
  if (patch.modelId !== undefined) changes.modelId = patch.modelId;
  if (patch.thinkingLevel !== undefined) changes.thinkingLevel = patch.thinkingLevel;
  if (patch.piSessionFile !== undefined) changes.piSessionFile = patch.piSessionFile;

  db.update(conversations).set(changes).where(eq(conversations.id, id)).run();
}

/** Bumps the ordering timestamp after a message is appended. */
export function touchConversation(db: Db, id: string, at: number = Date.now()): void {
  db.update(conversations)
    .set({ lastMessageAt: at, updatedAt: at })
    .where(eq(conversations.id, id))
    .run();
}

/**
 * Deletes the conversation and its runs/events/artifacts in one transaction.
 * SQLite has no foreign keys here, so the cascade is explicit. The Pi session file
 * is removed by the service layer, which owns the session directory.
 */
export function deleteConversation(db: Db, id: string): void {
  db.transaction((tx) => {
    tx.delete(runEvents).where(eq(runEvents.conversationId, id)).run();
    tx.delete(runs).where(eq(runs.conversationId, id)).run();
    tx.delete(artifacts).where(eq(artifacts.conversationId, id)).run();
    tx.delete(conversations).where(eq(conversations.id, id)).run();
  });
}
