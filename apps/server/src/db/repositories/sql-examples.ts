import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  conversations,
  queryAudit,
  runEvents,
  runFeedback,
  runs,
  sqlExamples,
  users,
} from "../schema.js";
import type { FeedbackReviewStatus } from "./run-feedback.js";

export type SqlExampleSource = "manual" | "feedback_up" | "feedback_fix";

export interface SqlExampleDto {
  id: string;
  datasourceId: string;
  question: string;
  sqlText: string;
  notes: string | null;
  tables: string[];
  source: SqlExampleSource;
  sourceRunId: string | null;
  enabled: boolean;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface InsertSqlExampleInput {
  datasourceId: string;
  question: string;
  sqlText: string;
  notes?: string | null;
  tables: string[];
  source?: SqlExampleSource;
  sourceRunId?: string | null;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface UpdateSqlExampleInput {
  question?: string;
  sqlText?: string;
  notes?: string | null;
  tables?: string[];
  enabled?: boolean;
}

export interface FeedbackSqlEntry {
  sql: string;
  status: string;
  rowCount: number | null;
  errorMessage: string | null;
}

export interface DatasourceFeedbackItem {
  id: string;
  runId: string;
  conversationId: string;
  conversationTitle: string | null;
  username: string;
  displayName: string | null;
  rating: 1 | -1;
  comment: string | null;
  reviewStatus: FeedbackReviewStatus;
  reviewedAt: number | null;
  prompt: string;
  runStatus: string;
  sqlQueries: FeedbackSqlEntry[];
  promotedExampleId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DatasourceFeedbackSummary {
  pendingNegative: number;
  pendingPositive: number;
  totalExamples: number;
  enabledExamples: number;
}

function parseTables(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function toDto(row: typeof sqlExamples.$inferSelect): SqlExampleDto {
  return {
    id: row.id,
    datasourceId: row.datasourceId,
    question: row.question,
    sqlText: row.sqlText,
    notes: row.notes,
    tables: parseTables(row.tablesJson),
    source: row.source,
    sourceRunId: row.sourceRunId,
    enabled: row.enabled === 1,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listSqlExamples(
  db: Db,
  datasourceId: string,
  options?: { onlyEnabled?: boolean },
): SqlExampleDto[] {
  const where = options?.onlyEnabled
    ? and(eq(sqlExamples.datasourceId, datasourceId), eq(sqlExamples.enabled, 1))
    : eq(sqlExamples.datasourceId, datasourceId);
  return db
    .select()
    .from(sqlExamples)
    .where(where)
    .orderBy(desc(sqlExamples.updatedAt), asc(sqlExamples.id))
    .all()
    .map(toDto);
}

export function findSqlExample(
  db: Db,
  datasourceId: string,
  id: string,
): SqlExampleDto | undefined {
  const row = db
    .select()
    .from(sqlExamples)
    .where(and(eq(sqlExamples.datasourceId, datasourceId), eq(sqlExamples.id, id)))
    .get();
  return row ? toDto(row) : undefined;
}

export function insertSqlExample(db: Db, input: InsertSqlExampleInput): SqlExampleDto {
  const now = Date.now();
  const row = db
    .insert(sqlExamples)
    .values({
      id: randomUUID(),
      datasourceId: input.datasourceId,
      question: input.question.trim(),
      sqlText: input.sqlText.trim(),
      notes: input.notes?.trim() || null,
      tablesJson: JSON.stringify([...new Set(input.tables.map((t) => t.toLowerCase()))]),
      source: input.source ?? "manual",
      sourceRunId: input.sourceRunId ?? null,
      enabled: input.enabled === false ? 0 : 1,
      useCount: 0,
      lastUsedAt: null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toDto(row);
}

export function updateSqlExample(
  db: Db,
  datasourceId: string,
  id: string,
  patch: UpdateSqlExampleInput,
): SqlExampleDto | undefined {
  const values: Partial<typeof sqlExamples.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (patch.question !== undefined) values.question = patch.question.trim();
  if (patch.sqlText !== undefined) values.sqlText = patch.sqlText.trim();
  if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;
  if (patch.tables !== undefined) {
    values.tablesJson = JSON.stringify([...new Set(patch.tables.map((t) => t.toLowerCase()))]);
  }
  if (patch.enabled !== undefined) values.enabled = patch.enabled ? 1 : 0;

  const row = db
    .update(sqlExamples)
    .set(values)
    .where(and(eq(sqlExamples.datasourceId, datasourceId), eq(sqlExamples.id, id)))
    .returning()
    .get();
  return row ? toDto(row) : undefined;
}

export function deleteSqlExample(db: Db, datasourceId: string, id: string): boolean {
  const res = db
    .delete(sqlExamples)
    .where(and(eq(sqlExamples.datasourceId, datasourceId), eq(sqlExamples.id, id)))
    .run();
  return res.changes > 0;
}

export function recordSqlExampleUsage(db: Db, ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  db.update(sqlExamples)
    .set({
      useCount: sql`${sqlExamples.useCount} + 1`,
      lastUsedAt: now,
    })
    .where(inArray(sqlExamples.id, ids))
    .run();
}

export function markRunFeedbackPromoted(db: Db, runId: string): void {
  db.update(runFeedback)
    .set({ reviewStatus: "promoted", reviewedAt: Date.now() })
    .where(eq(runFeedback.runId, runId))
    .run();
}

export function updateDatasourceFeedbackStatus(
  db: Db,
  datasourceId: string,
  feedbackId: string,
  reviewStatus: FeedbackReviewStatus,
): boolean {
  const match = db
    .select({ id: runFeedback.id })
    .from(runFeedback)
    .innerJoin(runs, eq(runs.id, runFeedback.runId))
    .innerJoin(conversations, eq(conversations.id, runs.conversationId))
    .where(and(eq(runFeedback.id, feedbackId), eq(conversations.datasourceId, datasourceId)))
    .get();
  if (!match) return false;
  db.update(runFeedback)
    .set({
      reviewStatus,
      reviewedAt: reviewStatus === "pending" ? null : Date.now(),
    })
    .where(eq(runFeedback.id, feedbackId))
    .run();
  return true;
}

export function getDatasourceFeedbackSummary(
  db: Db,
  datasourceId: string,
): DatasourceFeedbackSummary {
  const feedbackRows = db
    .select({
      rating: runFeedback.rating,
      reviewStatus: runFeedback.reviewStatus,
    })
    .from(runFeedback)
    .innerJoin(runs, eq(runs.id, runFeedback.runId))
    .innerJoin(conversations, eq(conversations.id, runs.conversationId))
    .where(eq(conversations.datasourceId, datasourceId))
    .all();

  let pendingNegative = 0;
  let pendingPositive = 0;
  for (const row of feedbackRows) {
    if (row.reviewStatus !== "pending") continue;
    if (row.rating === -1) pendingNegative += 1;
    else if (row.rating === 1) pendingPositive += 1;
  }

  const examples = db
    .select({ enabled: sqlExamples.enabled })
    .from(sqlExamples)
    .where(eq(sqlExamples.datasourceId, datasourceId))
    .all();

  return {
    pendingNegative,
    pendingPositive,
    totalExamples: examples.length,
    enabledExamples: examples.filter((e) => e.enabled === 1).length,
  };
}

export function listDatasourceFeedback(
  db: Db,
  datasourceId: string,
  options?: {
    rating?: 1 | -1 | "all";
    status?: FeedbackReviewStatus | "all";
    limit?: number;
  },
): DatasourceFeedbackItem[] {
  const conditions = [eq(conversations.datasourceId, datasourceId)];
  if (options?.rating === 1 || options?.rating === -1) {
    conditions.push(eq(runFeedback.rating, options.rating));
  }
  if (options?.status && options.status !== "all") {
    conditions.push(eq(runFeedback.reviewStatus, options.status));
  }

  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const rows = db
    .select({
      id: runFeedback.id,
      runId: runFeedback.runId,
      conversationId: runs.conversationId,
      conversationTitle: conversations.title,
      username: users.username,
      displayName: users.displayName,
      rating: runFeedback.rating,
      comment: runFeedback.comment,
      reviewStatus: runFeedback.reviewStatus,
      reviewedAt: runFeedback.reviewedAt,
      runStatus: runs.status,
      createdAt: runFeedback.createdAt,
      updatedAt: runFeedback.updatedAt,
    })
    .from(runFeedback)
    .innerJoin(runs, eq(runs.id, runFeedback.runId))
    .innerJoin(conversations, eq(conversations.id, runs.conversationId))
    .leftJoin(users, eq(users.id, runFeedback.userId))
    .where(and(...conditions))
    .orderBy(desc(runFeedback.updatedAt), desc(runFeedback.createdAt))
    .limit(limit)
    .all();

  if (rows.length === 0) return [];
  const runIds = [...new Set(rows.map((r) => r.runId))];

  const promptRows = db
    .select({ runId: runEvents.runId, payloadJson: runEvents.payloadJson })
    .from(runEvents)
    .where(and(inArray(runEvents.runId, runIds), eq(runEvents.type, "user_message")))
    .orderBy(asc(runEvents.seq))
    .all();
  const promptByRun = new Map<string, string>();
  for (const ev of promptRows) {
    if (promptByRun.has(ev.runId)) continue;
    try {
      const payload = JSON.parse(ev.payloadJson) as { content?: unknown };
      if (typeof payload.content === "string") {
        promptByRun.set(ev.runId, payload.content);
      }
    } catch {
      // Ignore malformed payload.
    }
  }

  const auditRows = db
    .select({
      runId: queryAudit.runId,
      sqlText: queryAudit.sqlText,
      detailJson: queryAudit.detailJson,
      status: queryAudit.status,
      rowCount: queryAudit.rowCount,
      errorMessage: queryAudit.errorMessage,
      createdAt: queryAudit.createdAt,
    })
    .from(queryAudit)
    .where(and(inArray(queryAudit.runId, runIds), eq(queryAudit.action, "query")))
    .orderBy(asc(queryAudit.createdAt))
    .all();

  const sqlsByRun = new Map<string, FeedbackSqlEntry[]>();
  for (const audit of auditRows) {
    if (!audit.runId) continue;
    let displaySql = audit.sqlText;
    if (audit.detailJson) {
      try {
        const detail = JSON.parse(audit.detailJson) as Record<string, unknown>;
        if (typeof detail.originalSql === "string" && detail.originalSql.trim()) {
          displaySql = detail.originalSql;
        }
      } catch {
        // Keep audit.sqlText.
      }
    }
    const list = sqlsByRun.get(audit.runId) ?? [];
    list.push({
      sql: displaySql,
      status: audit.status,
      rowCount: audit.rowCount,
      errorMessage: audit.errorMessage,
    });
    sqlsByRun.set(audit.runId, list);
  }

  const promotedRows = db
    .select({ id: sqlExamples.id, sourceRunId: sqlExamples.sourceRunId })
    .from(sqlExamples)
    .where(
      and(
        eq(sqlExamples.datasourceId, datasourceId),
        inArray(sqlExamples.sourceRunId, runIds),
      ),
    )
    .all();
  const promotedByRun = new Map<string, string>();
  for (const row of promotedRows) {
    if (row.sourceRunId && !promotedByRun.has(row.sourceRunId)) {
      promotedByRun.set(row.sourceRunId, row.id);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    conversationId: row.conversationId,
    conversationTitle: row.conversationTitle,
    username: row.username ?? "unknown",
    displayName: row.displayName ?? null,
    rating: row.rating === -1 ? -1 : 1,
    comment: row.comment,
    reviewStatus: row.reviewStatus,
    reviewedAt: row.reviewedAt,
    prompt: promptByRun.get(row.runId) ?? row.conversationTitle ?? "",
    runStatus: row.runStatus,
    sqlQueries: sqlsByRun.get(row.runId) ?? [],
    promotedExampleId: promotedByRun.get(row.runId) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}
