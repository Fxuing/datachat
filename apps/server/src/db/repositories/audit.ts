import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.js";
import { queryAudit } from "../schema.js";
import type { AuditAction, AuditStatus } from "../../services/audit.js";

export interface AuditFilters {
  userId?: string;
  datasourceId?: string;
  action?: AuditAction;
  status?: AuditStatus;
  /** Inclusive lower bound on `created_at` (epoch ms). */
  from?: number;
  /** Inclusive upper bound on `created_at` (epoch ms). */
  to?: number;
  limit: number;
  offset: number;
}

export interface AuditListRow {
  id: string;
  runId: string | null;
  conversationId: string | null;
  userId: string | null;
  datasourceId: string | null;
  action: AuditAction;
  sqlText: string;
  status: AuditStatus;
  rowCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  /** Parsed `detail_json`; arrays/scalars collapse to null so the API shape stays stable. */
  detailJson: Record<string, unknown> | null;
  createdAt: number;
}

export interface AuditListResult {
  items: AuditListRow[];
  total: number;
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Admin audit feed. Rows are newest-first with `id` as the tiebreaker so two rows
 * created in the same millisecond still paginate deterministically.
 */
export function listAudit(db: Db, filters: AuditFilters): AuditListResult {
  const conditions: SQL[] = [];
  if (filters.userId) conditions.push(eq(queryAudit.userId, filters.userId));
  if (filters.datasourceId) conditions.push(eq(queryAudit.datasourceId, filters.datasourceId));
  if (filters.action) conditions.push(eq(queryAudit.action, filters.action));
  if (filters.status) conditions.push(eq(queryAudit.status, filters.status));
  if (filters.from !== undefined) conditions.push(gte(queryAudit.createdAt, filters.from));
  if (filters.to !== undefined) conditions.push(lte(queryAudit.createdAt, filters.to));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(queryAudit)
    .where(where)
    .get();
  const total = Number(totalRow?.count ?? 0);

  const rows = db
    .select()
    .from(queryAudit)
    .where(where)
    .orderBy(desc(queryAudit.createdAt), desc(queryAudit.id))
    .limit(filters.limit)
    .offset(filters.offset)
    .all();

  return {
    items: rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      conversationId: row.conversationId,
      userId: row.userId,
      datasourceId: row.datasourceId,
      action: row.action,
      sqlText: row.sqlText,
      status: row.status,
      rowCount: row.rowCount,
      durationMs: row.durationMs,
      errorMessage: row.errorMessage,
      detailJson: parseDetail(row.detailJson),
      createdAt: row.createdAt,
    })),
    total,
  };
}
