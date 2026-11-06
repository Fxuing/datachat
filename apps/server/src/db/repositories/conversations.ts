import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../client.js";
import { artifacts, conversations, runEvents, runs } from "../schema.js";

export type ConversationRow = typeof conversations.$inferSelect;

export interface CreateConversationInput {
  userId: string;
  datasourceId: string;
  title?: string | null;
  modelId?: string | null;
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
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    })
    .returning()
    .get();
}

/**
 * Newest activity first. `before` is the `lastMessageAt` cursor of the last row of
 * the previous page; conversations that never received a message sort last.
 */
export function listConversations(
  db: Db,
  userId: string,
  opts: { limit?: number; before?: number } = {},
): ConversationRow[] {
  const where =
    opts.before === undefined
      ? eq(conversations.userId, userId)
      : and(eq(conversations.userId, userId), lt(conversations.lastMessageAt, opts.before));

  return db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
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
  piSessionFile?: string | null;
}

export function updateConversation(db: Db, id: string, patch: UpdateConversationPatch): void {
  const changes: Partial<typeof conversations.$inferInsert> = { updatedAt: Date.now() };
  if (patch.title !== undefined) changes.title = patch.title;
  if (patch.modelId !== undefined) changes.modelId = patch.modelId;
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
