import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { reports } from "../schema.js";

export type ReportRow = typeof reports.$inferSelect;

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
