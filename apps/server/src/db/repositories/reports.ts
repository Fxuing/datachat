import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { conversations, datasources, reports } from "../schema.js";

export type ReportRow = typeof reports.$inferSelect;

export interface UserReportListRow extends ReportRow {
  conversationKind: "chat" | "scheduled" | null;
  conversationTitle: string | null;
  sourceKind: "datasource" | "file" | null;
  datasourceId: string | null;
  datasourceName: string | null;
}

export interface ListReportsForUserOptions {
  q?: string;
  source?: "chat" | "scheduled";
  datasourceId?: string;
}

export interface InsertReportInput {
  conversationId: string;
  userId: string;
  title: string;
  markdown: string;
  artifactIds: string[];
}

export function insertReport(db: Db, input: InsertReportInput): ReportRow {
  const now = Date.now();
  return db
    .insert(reports)
    .values({
      id: randomUUID(),
      conversationId: input.conversationId,
      userId: input.userId,
      title: input.title,
      markdown: input.markdown,
      artifactIdsJson: JSON.stringify(input.artifactIds),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function findReport(db: Db, id: string): ReportRow | undefined {
  return db.select().from(reports).where(eq(reports.id, id)).get();
}

export function listReportsForUser(
  db: Db,
  userId: string,
  opts: ListReportsForUserOptions = {},
): UserReportListRow[] {
  const conditions = [eq(reports.userId, userId)];
  const q = opts.q?.trim();
  if (q) {
    conditions.push(sql`instr(lower(${reports.title}), lower(${q})) > 0`);
  }
  if (opts.source) {
    conditions.push(eq(conversations.kind, opts.source));
  }
  if (opts.datasourceId) {
    conditions.push(eq(conversations.datasourceId, opts.datasourceId));
  }

  return db
    .select({
      id: reports.id,
      conversationId: reports.conversationId,
      userId: reports.userId,
      title: reports.title,
      markdown: reports.markdown,
      artifactIdsJson: reports.artifactIdsJson,
      createdAt: reports.createdAt,
      updatedAt: reports.updatedAt,
      conversationKind: conversations.kind,
      conversationTitle: conversations.title,
      sourceKind: conversations.sourceKind,
      datasourceId: conversations.datasourceId,
      datasourceName: datasources.name,
    })
    .from(reports)
    .leftJoin(conversations, eq(reports.conversationId, conversations.id))
    .leftJoin(datasources, eq(conversations.datasourceId, datasources.id))
    .where(and(...conditions))
    .orderBy(desc(reports.updatedAt), desc(reports.createdAt))
    .all();
}

/** Newest first; the owner filter is optional for admin-side listings. */
export function listReportsByConversation(
  db: Db,
  conversationId: string,
  opts: { userId?: string; limit?: number } = {},
): ReportRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const where = opts.userId
    ? and(eq(reports.conversationId, conversationId), eq(reports.userId, opts.userId))
    : eq(reports.conversationId, conversationId);
  return db
    .select()
    .from(reports)
    .where(where)
    .orderBy(desc(reports.createdAt))
    .limit(limit)
    .all();
}

export function updateReport(
  db: Db,
  id: string,
  patch: { title?: string; markdown?: string },
): ReportRow | undefined {
  const values: Partial<typeof reports.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.markdown !== undefined) values.markdown = patch.markdown;
  return db
    .update(reports)
    .set(values)
    .where(eq(reports.id, id))
    .returning()
    .get();
}

export function deleteReport(db: Db, id: string): boolean {
  return db.delete(reports).where(eq(reports.id, id)).run().changes > 0;
}

/** Never let a malformed JSON column break a report read. */
export function parseReportArtifactIds(row: { artifactIdsJson: string }): string[] {
  try {
    const parsed = JSON.parse(row.artifactIdsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
