import { and, desc, eq } from "drizzle-orm";
import {
  REPORT_MAX_ARTIFACTS,
  type ReportDetail,
  type ReportSummary,
} from "@datachat/shared";
import type { Db } from "../db/client.js";
import { findConversation } from "../db/repositories/conversations.js";
import {
  findReport,
  insertReport,
  parseReportArtifactIds,
  type ReportRow,
} from "../db/repositories/reports.js";
import { queryAudit } from "../db/schema.js";
import type { ArtifactRecord, ArtifactStore } from "./artifacts.js";

export type ReportErrorCode =
  | "EMPTY_ARTIFACTS"
  | "TOO_MANY_ARTIFACTS"
  | "CONVERSATION_NOT_FOUND"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_CONVERSATION_MISMATCH"
  | "INVALID_ARTIFACT_KIND";

export type CreateReportResult =
  | { ok: true; report: ReportDetail }
  | { ok: false; code: ReportErrorCode; message: string };

export interface CreateReportInput {
  db: Db;
  artifacts: ArtifactStore;
  userId: string;
  conversationId: string;
  artifactIds: string[];
  title?: string;
  /** Model-authored body; omitted for the deterministic `POST /api/reports` path. */
  markdown?: string;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** Local-time title, e.g. `分析报告 2026-11-06 16:55`. */
export function formatReportTitle(date: Date | number = Date.now()): string {
  const value = date instanceof Date ? date : new Date(date);
  return `分析报告 ${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
    value.getHours(),
  )}:${pad(value.getMinutes())}`;
}

export function toReportSummary(row: ReportRow): ReportSummary {
  return {
    id: row.id,
    conversationId: row.conversationId,
    title: row.title,
    artifactIds: parseReportArtifactIds(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toReportDetail(row: ReportRow): ReportDetail {
  return { ...toReportSummary(row), markdown: row.markdown };
}

function chartTitle(specJson: string | null): string {
  if (!specJson) return "图表";
  try {
    const spec = JSON.parse(specJson) as { chart?: { title?: unknown } };
    const title = spec.chart?.title;
    if (typeof title === "string" && title.trim().length > 0) return title.trim();
  } catch {
    // A malformed spec only loses the title.
  }
  return "图表";
}

/** Latest executed SQL for the run that produced the artifact, if any. */
function findArtifactSql(db: Db, runId: string | null): string | null {
  if (!runId) return null;
  const row = db
    .select({ sqlText: queryAudit.sqlText })
    .from(queryAudit)
    .where(and(eq(queryAudit.runId, runId), eq(queryAudit.action, "query")))
    .orderBy(desc(queryAudit.createdAt))
    .limit(1)
    .get();
  return row?.sqlText ?? null;
}

function artifactSection(db: Db, artifact: ArtifactRecord, index: number): string {
  const label =
    artifact.kind === "chart" ? `图表：${chartTitle(artifact.specJson)}` : "查询结果";
  const lines = [`## ${index + 1}. ${label}`, ""];
  lines.push(`- 行数：${artifact.rowCount}${artifact.truncated ? "（已截断）" : ""}`);
  if (artifact.columns.length > 0) {
    lines.push(`- 列：${artifact.columns.map((column) => column.name).join("、")}`);
  }

  const sql = findArtifactSql(db, artifact.runId);
  if (sql) {
    const fence = "```";
    lines.push("", `${fence}sql`, sql, fence);
  }

  lines.push("", `[[artifact:${artifact.id}]]`);
  return lines.join("\n");
}

/**
 * Deterministic report body: one section per artifact with metadata, the SQL that
 * produced it (when recoverable) and a placeholder the client replaces with the
 * rendered table/chart.
 */
export function buildReportMarkdown(db: Db, artifacts: ArtifactRecord[]): string {
  return artifacts
    .map((artifact, index) => artifactSection(db, artifact, index))
    .join("\n\n");
}

export function createReport(input: CreateReportInput): CreateReportResult {
  const conversation = findConversation(input.db, input.conversationId);
  if (!conversation || conversation.userId !== input.userId) {
    return { ok: false, code: "CONVERSATION_NOT_FOUND", message: "会话不存在" };
  }

  const artifactIds = [...new Set(input.artifactIds)];
  if (artifactIds.length === 0) {
    return { ok: false, code: "EMPTY_ARTIFACTS", message: "请至少选择一个查询结果" };
  }
  if (artifactIds.length > REPORT_MAX_ARTIFACTS) {
    return {
      ok: false,
      code: "TOO_MANY_ARTIFACTS",
      message: `一次最多引用 ${REPORT_MAX_ARTIFACTS} 个查询结果`,
    };
  }

  const records: ArtifactRecord[] = [];
  for (const id of artifactIds) {
    const artifact = input.artifacts.get(id);
    if (!artifact || artifact.userId !== input.userId) {
      return { ok: false, code: "ARTIFACT_NOT_FOUND", message: "查询结果不存在" };
    }
    if (artifact.conversationId !== input.conversationId) {
      return {
        ok: false,
        code: "ARTIFACT_CONVERSATION_MISMATCH",
        message: "查询结果不属于该会话",
      };
    }
    if (artifact.kind === "excel") {
      return {
        ok: false,
        code: "INVALID_ARTIFACT_KIND",
        message: "报告只能引用查询结果或图表，不能直接引用 Excel 文件",
      };
    }
    records.push(artifact);
  }

  const row = insertReport(input.db, {
    conversationId: input.conversationId,
    userId: input.userId,
    title: input.title?.trim() || formatReportTitle(),
    markdown: input.markdown?.trim() ? input.markdown : buildReportMarkdown(input.db, records),
    artifactIds,
  });
  return { ok: true, report: toReportDetail(row) };
}

/** Owner or admin; missing and foreign reports look the same to the caller. */
export function canReadReport(
  report: ReportRow,
  userId: string,
  isAdmin: boolean,
): boolean {
  return isAdmin || report.userId === userId;
}

export function getReportForUser(
  db: Db,
  id: string,
  userId: string,
  isAdmin: boolean,
): ReportDetail | null {
  const row = findReport(db, id);
  if (!row || !canReadReport(row, userId, isAdmin)) return null;
  return toReportDetail(row);
}
