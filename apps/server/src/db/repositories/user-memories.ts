import { and, asc, desc, eq, gte, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { runs, userMemories, userMemorySettings } from "../schema.js";
import { readSettingRows } from "./settings.js";

export type UserMemoryRow = typeof userMemories.$inferSelect;
export type MemoryKind = "profile" | "instruction" | "preference" | "fact";

export interface MemoryFilters {
  query?: string;
  kind?: MemoryKind;
  scope?: "global" | "datasource";
  datasourceId?: string;
}

export interface UpsertMemoryInput {
  userId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  scope: "global" | "datasource";
  datasourceId?: string | null;
  core?: boolean;
  confidence?: number;
  sourceConversationId?: string | null;
  sourceRunId?: string | null;
  now?: number;
}

export class MemoryValidationError extends Error {}
export class MemoryDuplicateError extends Error {
  constructor(
    message: string,
    readonly existingId: string,
  ) {
    super(message);
  }
}

/** Canonical title for dedupe: punctuation/whitespace/case are not meaningful. */
export function normalizeMemoryTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

export function memoryDedupeKey(input: {
  kind: MemoryKind;
  title: string;
  scope: "global" | "datasource";
  datasourceId?: string | null;
}): string {
  const scope = input.scope === "datasource" ? `datasource:${input.datasourceId ?? ""}` : "global";
  return `${input.kind}|${scope}|${normalizeMemoryTitle(input.title)}`;
}

function requireText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text) throw new MemoryValidationError(`${label}不能为空`);
  if (text.length > max) throw new MemoryValidationError(`${label}不能超过 ${max} 个字符`);
  return text;
}

export function listUserMemories(db: Db, userId: string, filters: MemoryFilters = {}): UserMemoryRow[] {
  const conditions = [eq(userMemories.userId, userId)];
  if (filters.kind) conditions.push(eq(userMemories.kind, filters.kind));
  if (filters.scope === "global") conditions.push(isNull(userMemories.datasourceId));
  if (filters.scope === "datasource") conditions.push(sql`${userMemories.datasourceId} is not null`);
  if (filters.datasourceId) conditions.push(eq(userMemories.datasourceId, filters.datasourceId));
  if (filters.query?.trim()) {
    const pattern = `%${filters.query.trim()}%`;
    conditions.push(or(like(userMemories.title, pattern), like(userMemories.content, pattern))!);
  }
  return db
    .select()
    .from(userMemories)
    .where(and(...conditions))
    .orderBy(desc(userMemories.core), desc(userMemories.updatedAt))
    .all();
}

export function findUserMemory(db: Db, userId: string, id: string): UserMemoryRow | null {
  return (
    db
      .select()
      .from(userMemories)
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
      .get() ?? null
  );
}

export function upsertUserMemory(
  db: Db,
  input: UpsertMemoryInput,
): { memory: UserMemoryRow; merged: boolean } {
  const title = requireText(input.title, "标题", 60);
  const content = requireText(input.content, "内容", 1000);
  const datasourceId = input.scope === "datasource" ? (input.datasourceId ?? null) : null;
  if (input.scope === "datasource" && !datasourceId) {
    throw new MemoryValidationError("数据源记忆必须指定数据源");
  }
  const now = input.now ?? Date.now();
  const confidence = Math.max(0, Math.min(100, Math.round(input.confidence ?? 80)));
  const core = input.core ?? false;
  const dedupeKey = memoryDedupeKey({
    kind: input.kind,
    title,
    scope: input.scope,
    datasourceId,
  });
  const existing = db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.userId, input.userId), eq(userMemories.dedupeKey, dedupeKey)))
    .get();

  if (existing) {
    const row = db
      .update(userMemories)
      .set({
        title,
        content,
        confidence: Math.max(existing.confidence, confidence),
        core: core ? 1 : existing.core,
        datasourceId,
        sourceConversationId: input.sourceConversationId ?? existing.sourceConversationId,
        sourceRunId: input.sourceRunId ?? existing.sourceRunId,
        updatedAt: now,
      })
      .where(eq(userMemories.id, existing.id))
      .returning()
      .get();
    return { memory: row!, merged: true };
  }

  const row = db
    .insert(userMemories)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      datasourceId,
      kind: input.kind,
      title,
      content,
      core: core ? 1 : 0,
      enabled: 1,
      confidence,
      dedupeKey,
      sourceConversationId: input.sourceConversationId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0,
    })
    .returning()
    .get();
  archiveExcessMemories(db, input.userId, now);
  return { memory: row!, merged: false };
}

export function updateUserMemory(
  db: Db,
  userId: string,
  id: string,
  patch: {
    title?: string;
    content?: string;
    core?: boolean;
    enabled?: boolean;
    confidence?: number;
    now?: number;
  },
): UserMemoryRow | null {
  const existing = findUserMemory(db, userId, id);
  if (!existing) return null;
  const title =
    patch.title === undefined ? existing.title : requireText(patch.title, "标题", 60);
  const content =
    patch.content === undefined ? existing.content : requireText(patch.content, "内容", 1000);
  if (patch.core && existing.kind !== "profile" && existing.kind !== "instruction") {
    throw new MemoryValidationError("只有画像或固定指令可以设为核心记忆");
  }
  const datasourceId = existing.datasourceId;
  const scope = datasourceId ? "datasource" : "global";
  const dedupeKey = memoryDedupeKey({
    kind: existing.kind,
    title,
    scope,
    datasourceId,
  });
  try {
    const row = db
      .update(userMemories)
      .set({
        title,
        content,
        dedupeKey,
        core: patch.core === undefined ? existing.core : patch.core ? 1 : 0,
        enabled: patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
        confidence:
          patch.confidence === undefined
            ? existing.confidence
            : Math.max(0, Math.min(100, Math.round(patch.confidence))),
        updatedAt: patch.now ?? Date.now(),
      })
      .where(and(eq(userMemories.id, id), eq(userMemories.userId, userId)))
      .returning()
      .get();
    return row ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      const duplicate = db
        .select({ id: userMemories.id })
        .from(userMemories)
        .where(and(eq(userMemories.userId, userId), eq(userMemories.dedupeKey, dedupeKey)))
        .get();
      throw new MemoryDuplicateError("已存在同名记忆", duplicate?.id ?? "");
    }
    throw error;
  }
}

export function deleteUserMemory(db: Db, userId: string, id: string): boolean {
  return (
    db
      .delete(userMemories)
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
      .run().changes > 0
  );
}

export function clearUserMemories(db: Db, userId: string): number {
  return db.delete(userMemories).where(eq(userMemories.userId, userId)).run().changes;
}

export function listInjectionCandidates(
  db: Db,
  userId: string,
  datasourceId?: string | null,
): UserMemoryRow[] {
  const scope = datasourceId
    ? or(isNull(userMemories.datasourceId), eq(userMemories.datasourceId, datasourceId))
    : isNull(userMemories.datasourceId);
  return db
    .select()
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, userId),
        eq(userMemories.enabled, 1),
        gte(userMemories.confidence, 60),
        scope,
      ),
    )
    .limit(300)
    .all();
}

export function touchUserMemories(db: Db, userId: string, ids: string[], now: number): void {
  if (ids.length === 0) return;
  db.update(userMemories)
    .set({ lastUsedAt: now, useCount: sql`${userMemories.useCount} + 1` })
    .where(and(eq(userMemories.userId, userId), inArray(userMemories.id, ids)))
    .run();
}

export function getUserMemorySettings(db: Db, userId: string): { enabled: boolean } {
  const row = db
    .select()
    .from(userMemorySettings)
    .where(eq(userMemorySettings.userId, userId))
    .get();
  return { enabled: row ? row.enabled === 1 : true };
}

export function setUserMemorySettings(
  db: Db,
  userId: string,
  enabled: boolean,
): { enabled: boolean } {
  const now = Date.now();
  db.insert(userMemorySettings)
    .values({ userId, enabled: enabled ? 1 : 0, updatedAt: now })
    .onConflictDoUpdate({
      target: userMemorySettings.userId,
      set: { enabled: enabled ? 1 : 0, updatedAt: now },
    })
    .run();
  return { enabled };
}

/** Global admin switch AND the user's own switch. */
export function isMemoryEnabled(db: Db, userId: string): boolean {
  const raw = readSettingRows(db).get("memoryEnabled");
  let globalEnabled = true;
  if (raw !== undefined) {
    try {
      globalEnabled = JSON.parse(raw) !== false;
    } catch {
      globalEnabled = true;
    }
  }
  if (!globalEnabled) return false;
  return getUserMemorySettings(db, userId).enabled;
}

export function countMemoriesBySourceRun(db: Db, runId: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(userMemories)
    .where(eq(userMemories.sourceRunId, runId))
    .get();
  return Number(row?.count ?? 0);
}

export function markRunMemoryExtracted(db: Db, runId: string, at: number): void {
  db.update(runs).set({ memoryExtractedAt: at }).where(eq(runs.id, runId)).run();
}

function archiveExcessMemories(db: Db, userId: string, now: number): void {
  const enabled = db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.userId, userId), eq(userMemories.enabled, 1)))
    .all();
  const excess = enabled.length - 200;
  if (excess <= 0) return;
  const victims = enabled
    .filter((row) => row.core === 0)
    .sort(
      (a, b) =>
        a.confidence - b.confidence ||
        a.useCount - b.useCount ||
        a.updatedAt - b.updatedAt,
    )
    .slice(0, excess);
  if (victims.length === 0) return;
  db.update(userMemories)
    .set({ enabled: 0, updatedAt: now })
    .where(inArray(userMemories.id, victims.map((row) => row.id)))
    .run();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Core memories eligible for the always-on block (see spec §7.1). */
export function listCoreMemories(
  db: Db,
  userId: string,
  datasourceId?: string | null,
): UserMemoryRow[] {
  const scope = datasourceId
    ? or(isNull(userMemories.datasourceId), eq(userMemories.datasourceId, datasourceId))
    : isNull(userMemories.datasourceId);
  return db
    .select()
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, userId),
        eq(userMemories.enabled, 1),
        eq(userMemories.core, 1),
        gte(userMemories.confidence, 60),
        scope,
      ),
    )
    .orderBy(asc(userMemories.updatedAt))
    .all();
}
