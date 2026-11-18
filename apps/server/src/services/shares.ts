import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { runEventSchema, type RunEvent } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { conversations, reports, shares } from "../db/schema.js";
import {
  findConversation,
  type ConversationRow,
} from "../db/repositories/conversations.js";
import {
  findReport,
  parseReportArtifactIds,
  type ReportRow,
} from "../db/repositories/reports.js";
import { listConversationEvents } from "../db/repositories/run-events.js";
import { findDatasource } from "../db/repositories/datasources.js";
import type { ArtifactStore, ColumnInfo } from "./artifacts.js";

export const SHARE_MIN_EXPIRES_IN_DAYS = 1;
export const SHARE_MAX_EXPIRES_IN_DAYS = 365;
export const SHARE_DEFAULT_EXPIRES_IN_DAYS = 7;
/** Public payloads never carry more than this many result rows per artifact. */
export const SHARE_MAX_ROWS = 100;

const DAY_MS = 86_400_000;

export interface CreatedShare {
  id: string;
  token: string;
  /** Relative public path; the client turns it into an absolute URL. */
  url: string;
  expiresAt: number;
}

export interface PublicShareMessage {
  role: "user" | "assistant";
  text: string;
  sql?: string;
  columns?: ColumnInfo[];
  rows?: unknown[][];
  chart?: unknown;
}

export interface PublicConversationShare {
  type: "conversation";
  title: string;
  messages: PublicShareMessage[];
  createdAt: number;
}

export interface PublicReportArtifact {
  id: string;
  kind: "result" | "chart";
  columns?: ColumnInfo[];
  rows?: unknown[][];
  spec?: unknown;
}

export interface PublicReportShare {
  type: "report";
  title: string;
  markdown: string;
  artifacts: PublicReportArtifact[];
  createdAt: number;
}

export type PublicShare = PublicConversationShare | PublicReportShare;

export type ShareErrorCode = "VALIDATION" | "NOT_FOUND" | "SHARE_DISABLED_BY_SCOPE";

export type CreateShareResult =
  | { ok: true; share: CreatedShare }
  | { ok: false; code: ShareErrorCode; message: string };

export type ResolveShareResult =
  | { ok: true; share: PublicShare }
  | { ok: false; code: "SHARE_GONE" | "SHARE_DISABLED_BY_SCOPE"; message: string };

export type RevokeShareResult =
  | { ok: true }
  | { ok: false; code: ShareErrorCode; message: string };

export interface CreateShareInput {
  db: Db;
  userId: string;
  conversationId?: string;
  reportId?: string;
  expiresInDays?: number;
  /** Admin-configured ceiling (`shareMaxDays`); defaults to the built-in maximum. */
  maxExpiresInDays?: number;
  /** Clock seam for tests. */
  now?: number;
}

export interface ResolveShareInput {
  db: Db;
  artifacts: ArtifactStore;
  token: string;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface RevokeShareInput {
  db: Db;
  shareId: string;
  userId: string;
  role: "user" | "admin";
  now?: number;
}

/** Only the SHA-256 hex digest is persisted; the plaintext token lives once in the response. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function error(code: ShareErrorCode, message: string): { ok: false; code: ShareErrorCode; message: string } {
  return { ok: false, code, message };
}

function validateExpiry(expiresInDays: number, maxDays: number): boolean {
  return (
    Number.isInteger(expiresInDays) &&
    expiresInDays >= SHARE_MIN_EXPIRES_IN_DAYS &&
    expiresInDays <= maxDays
  );
}

function isTargetFound(
  db: Db,
  userId: string,
  conversationId: string | undefined,
  reportId: string | undefined,
): boolean {
  if (conversationId) {
    const conversation = findConversation(db, conversationId);
    return Boolean(conversation && conversation.userId === userId);
  }
  const report = findReport(db, reportId!);
  return Boolean(report && report.userId === userId);
}

/** Public projection is refused once a datasource enforces department scope. */
function shareTargetScopeEnforced(
  db: Db,
  conversationId: string | undefined,
  reportId: string | undefined,
): boolean {
  const conversation = conversationId
    ? findConversation(db, conversationId)
    : reportId
      ? (() => {
          const report = findReport(db, reportId);
          return report?.conversationId ? findConversation(db, report.conversationId) : undefined;
        })()
      : undefined;
  if (!conversation) return false;
  return findDatasource(db, conversation.datasourceId)?.dataScopeMode === "enabled";
}

export function createShare(input: CreateShareInput): CreateShareResult {
  const targetCount = (input.conversationId ? 1 : 0) + (input.reportId ? 1 : 0);
  if (targetCount !== 1) {
    return error("VALIDATION", "必须且只能指定会话或报告");
  }

  const maxDays = input.maxExpiresInDays ?? SHARE_MAX_EXPIRES_IN_DAYS;
  const expiresInDays =
    input.expiresInDays ?? Math.min(SHARE_DEFAULT_EXPIRES_IN_DAYS, maxDays);
  if (!validateExpiry(expiresInDays, maxDays)) {
    return error("VALIDATION", `有效期必须为 1 到 ${maxDays} 天`);
  }

  if (!isTargetFound(input.db, input.userId, input.conversationId, input.reportId)) {
    return error("NOT_FOUND", "分享目标不存在");
  }

  if (shareTargetScopeEnforced(input.db, input.conversationId, input.reportId)) {
    return error("SHARE_DISABLED_BY_SCOPE", "该数据源已启用部门数据权限，不能公开分享");
  }

  const now = input.now ?? Date.now();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + expiresInDays * DAY_MS;
  const id = randomUUID();
  input.db
    .insert(shares)
    .values({
      id,
      tokenHash: hashShareToken(token),
      conversationId: input.conversationId ?? null,
      reportId: input.reportId ?? null,
      createdBy: input.userId,
      expiresAt,
      revokedAt: null,
      createdAt: now,
    })
    .run();

  return { ok: true, share: { id, token, url: `/s/${token}`, expiresAt } };
}

export function revokeShare(input: RevokeShareInput): RevokeShareResult {
  const share = input.db.select().from(shares).where(eq(shares.id, input.shareId)).get();
  if (!share || (share.createdBy !== input.userId && input.role !== "admin")) {
    return error("NOT_FOUND", "分享不存在");
  }
  input.db
    .update(shares)
    .set({ revokedAt: input.now ?? Date.now() })
    .where(eq(shares.id, share.id))
    .run();
  return { ok: true };
}

const SHARE_GONE_MESSAGE = "分享链接已过期或已撤销";

export async function resolveShare(input: ResolveShareInput): Promise<ResolveShareResult> {
  const now = input.now?.() ?? Date.now();
  const share = input.db
    .select()
    .from(shares)
    .where(eq(shares.tokenHash, hashShareToken(input.token)))
    .get();

  if (!share || share.revokedAt !== null || share.expiresAt <= now) {
    return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
  }

  if (shareTargetScopeEnforced(input.db, share.conversationId ?? undefined, share.reportId ?? undefined)) {
    return {
      ok: false,
      code: "SHARE_DISABLED_BY_SCOPE",
      message: "该数据源已启用部门数据权限，分享已失效",
    };
  }

  if (share.conversationId) {
    const conversation = findConversation(input.db, share.conversationId);
    if (!conversation) {
      return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
    }
    return { ok: true, share: buildConversationShare(input.db, conversation) };
  }

  if (share.reportId) {
    const report = findReport(input.db, share.reportId);
    if (!report) {
      return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
    }
    return { ok: true, share: await buildReportShare(input.artifacts, report) };
  }

  return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
}

interface MessageGroup {
  createdAt: number;
  user: string | null;
  assistant: string | null;
  deltas: string[];
  sqls: string[];
  results: { columns: ColumnInfo[]; rows: unknown[][] }[];
  charts: unknown[];
}

function parseEvent(row: { type: string; payloadJson: string }): RunEvent | null {
  try {
    return runEventSchema.parse({
      type: row.type,
      payload: JSON.parse(row.payloadJson) as unknown,
    });
  } catch {
    return null;
  }
}

function groupFor(groups: Map<string, MessageGroup>, runId: string, createdAt: number): MessageGroup {
  const existing = groups.get(runId);
  if (existing) return existing;
  const group: MessageGroup = {
    createdAt,
    user: null,
    assistant: null,
    deltas: [],
    sqls: [],
    results: [],
    charts: [],
  };
  groups.set(runId, group);
  return group;
}

function applyEvent(group: MessageGroup, event: RunEvent): void {
  switch (event.type) {
    case "user_message":
      group.user = event.payload.content;
      break;
    case "assistant_message":
      group.assistant = event.payload.content;
      break;
    case "text_delta":
      group.deltas.push(event.payload.text);
      break;
    case "sql":
      group.sqls.push(event.payload.sql);
      break;
    case "result":
      group.results.push({ columns: event.payload.columns, rows: event.payload.rows });
      break;
    case "chart":
      group.charts.push(event.payload.spec);
      break;
    default:
      break;
  }
}

/**
 * Rebuild the conversation as a whitelisted public transcript. Run ids, audit ids,
 * datasource ids, storage paths and tool details are intentionally never copied.
 */
function buildConversationShare(db: Db, conversation: ConversationRow): PublicConversationShare {
  const groups = new Map<string, MessageGroup>();
  for (const row of listConversationEvents(db, conversation.id, 20_000)) {
    const event = parseEvent(row);
    if (!event) continue;
    applyEvent(groupFor(groups, row.runId, row.createdAt), event);
  }

  const messages: PublicShareMessage[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    // Stray tool events without a user prompt are not part of the transcript.
    if (group.user === null) continue;
    messages.push({ role: "user", text: group.user });
    for (const result of group.results) {
      messages.push({
        role: "assistant",
        text: "",
        columns: result.columns,
        rows: result.rows.slice(0, SHARE_MAX_ROWS),
      });
    }
    for (const chart of group.charts) {
      messages.push({ role: "assistant", text: "", chart });
    }
    const text = group.assistant ?? group.deltas.join("");
    const sql = group.sqls.at(-1);
    if (text || sql) {
      messages.push({ role: "assistant", text, ...(sql !== undefined ? { sql } : {}) });
    }
  }

  return {
    type: "conversation",
    title: conversation.title ?? "未命名会话",
    messages,
    createdAt: conversation.createdAt,
  };
}

async function buildReportShare(
  artifacts: ArtifactStore,
  report: ReportRow,
): Promise<PublicReportShare> {
  const items: PublicReportArtifact[] = [];
  for (const id of parseReportArtifactIds(report)) {
    const meta = artifacts.get(id);
    if (!meta) continue;
    if (meta.kind === "chart") {
      let spec: unknown;
      if (meta.specJson) {
        try {
          spec = JSON.parse(meta.specJson) as unknown;
        } catch {
          spec = undefined;
        }
      }
      items.push({ id, kind: "chart", ...(spec !== undefined ? { spec } : {}) });
      continue;
    }
    try {
      const read = await artifacts.readRowsStream(id, SHARE_MAX_ROWS);
      items.push({
        id,
        kind: "result",
        columns: meta.columns,
        rows: (read?.rows ?? []).slice(0, SHARE_MAX_ROWS),
      });
    } catch {
      // A missing/corrupt result file still leaves the artifact's columns visible.
      items.push({ id, kind: "result", columns: meta.columns, rows: [] });
    }
  }

  return {
    type: "report",
    title: report.title,
    markdown: report.markdown,
    artifacts: items,
    createdAt: report.createdAt,
  };
}

/**
 * Enabling department scope revokes every public link that could expose rows from
 * the datasource. Returns the number of links revoked.
 */
export function revokeSharesForDatasource(db: Db, datasourceId: string): number {
  const conversationIds = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.datasourceId, datasourceId))
    .all()
    .map((row) => row.id);
  if (conversationIds.length === 0) return 0;
  const reportIds = db
    .select({ id: reports.id })
    .from(reports)
    .where(inArray(reports.conversationId, conversationIds))
    .all()
    .map((row) => row.id);
  const target =
    reportIds.length > 0
      ? or(
          inArray(shares.conversationId, conversationIds),
          inArray(shares.reportId, reportIds),
        )
      : inArray(shares.conversationId, conversationIds);
  const result = db
    .update(shares)
    .set({ revokedAt: Date.now() })
    .where(and(isNull(shares.revokedAt), target))
    .run();
  return Number(result.changes ?? 0);
}
