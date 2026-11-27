import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { runEventSchema, type RunEvent } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { conversations, dashboards, reports, shares, users } from "../db/schema.js";
import {
  findConversation,
  type ConversationRow,
} from "../db/repositories/conversations.js";
import {
  findReport,
  parseReportArtifactIds,
  type ReportRow,
} from "../db/repositories/reports.js";
import {
  findDashboardById,
  findOwnedDashboard,
  listDashboardCardRows,
  type DashboardRow,
} from "../db/repositories/dashboards.js";
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

export interface PublicDashboardCard {
  id: string;
  title: string;
  width: 1 | 2;
  spec: unknown;
  points: number;
  lastRefreshedAt: number | null;
}

export interface PublicDashboardShare {
  type: "dashboard";
  title: string;
  description: string | null;
  cards: PublicDashboardCard[];
  updatedAt: number;
  createdAt: number;
}

export type PublicShare = PublicConversationShare | PublicReportShare | PublicDashboardShare;

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
  dashboardId?: string;
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

export interface ResolveShareReportInput {
  db: Db;
  artifacts: ArtifactStore;
  token: string;
  reportId: string;
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

export type ShareTargetType = "conversation" | "report" | "dashboard";
export type ShareStatus = "active" | "expired" | "revoked";

export interface ShareListItem {
  id: string;
  targetType: ShareTargetType;
  targetId: string;
  targetTitle: string;
  createdBy: string;
  creatorUsername?: string;
  expiresAt: number;
  revokedAt: number | null;
  status: ShareStatus;
  createdAt: number;
}

export interface ListSharesInput {
  db: Db;
  userId: string;
  isAdmin: boolean;
  scope?: "mine" | "all";
  status?: "active" | "all";
  conversationId?: string;
  reportId?: string;
  dashboardId?: string;
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
  dashboardId: string | undefined,
): boolean {
  if (conversationId) {
    const conversation = findConversation(db, conversationId);
    return Boolean(conversation && conversation.userId === userId);
  }
  if (reportId) {
    const report = findReport(db, reportId);
    return Boolean(report && report.userId === userId);
  }
  if (dashboardId) {
    return Boolean(findOwnedDashboard(db, dashboardId, userId));
  }
  return false;
}

/** Public projection is refused once a datasource enforces department scope. */
function shareTargetScopeEnforced(
  db: Db,
  conversationId: string | undefined,
  reportId: string | undefined,
  dashboardId: string | undefined,
): boolean {
  if (dashboardId) {
    const cards = listDashboardCardRows(db, dashboardId);
    const dsIds = new Set<string>();
    for (const card of cards) {
      if (card.datasourceId) dsIds.add(card.datasourceId);
      if (card.sourceConversationId) {
        const conv = findConversation(db, card.sourceConversationId);
        if (conv?.datasourceId) dsIds.add(conv.datasourceId);
      }
    }
    for (const dsId of dsIds) {
      if (findDatasource(db, dsId)?.dataScopeMode === "enabled") return true;
    }
    return false;
  }
  const conversation = conversationId
    ? findConversation(db, conversationId)
    : reportId
      ? (() => {
          const report = findReport(db, reportId);
          return report?.conversationId ? findConversation(db, report.conversationId) : undefined;
        })()
      : undefined;
  if (!conversation || !conversation.datasourceId) return false;
  return findDatasource(db, conversation.datasourceId)?.dataScopeMode === "enabled";
}

function buildDashboardShare(db: Db, dashboard: DashboardRow): PublicDashboardShare {
  const rows = listDashboardCardRows(db, dashboard.id);
  const cards: PublicDashboardCard[] = rows.map((row) => {
    let spec: unknown = null;
    try {
      spec = JSON.parse(row.specJson);
    } catch {
      spec = null;
    }
    return {
      id: row.id,
      title: row.title,
      width: row.width === 2 ? 2 : 1,
      spec,
      points: row.points,
      lastRefreshedAt: row.lastRefreshedAt,
    };
  });
  return {
    type: "dashboard",
    title: dashboard.name,
    description: dashboard.description,
    cards,
    updatedAt: dashboard.updatedAt,
    createdAt: dashboard.createdAt,
  };
}

export function createShare(input: CreateShareInput): CreateShareResult {
  const targetCount =
    (input.conversationId ? 1 : 0) + (input.reportId ? 1 : 0) + (input.dashboardId ? 1 : 0);
  if (targetCount !== 1) {
    return error("VALIDATION", "必须且只能指定会话、报告或看板之一");
  }

  const maxDays = input.maxExpiresInDays ?? SHARE_MAX_EXPIRES_IN_DAYS;
  const expiresInDays =
    input.expiresInDays ?? Math.min(SHARE_DEFAULT_EXPIRES_IN_DAYS, maxDays);
  if (!validateExpiry(expiresInDays, maxDays)) {
    return error("VALIDATION", `有效期必须为 1 到 ${maxDays} 天`);
  }

  if (
    !isTargetFound(
      input.db,
      input.userId,
      input.conversationId,
      input.reportId,
      input.dashboardId,
    )
  ) {
    return error("NOT_FOUND", "分享目标不存在");
  }

  if (
    shareTargetScopeEnforced(
      input.db,
      input.conversationId,
      input.reportId,
      input.dashboardId,
    )
  ) {
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
      dashboardId: input.dashboardId ?? null,
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

  if (
    shareTargetScopeEnforced(
      input.db,
      share.conversationId ?? undefined,
      share.reportId ?? undefined,
      share.dashboardId ?? undefined,
    )
  ) {
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
    return { ok: true, share: buildConversationShare(input.db, input.artifacts, conversation) };
  }

  if (share.reportId) {
    const report = findReport(input.db, share.reportId);
    if (!report) {
      return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
    }
    return { ok: true, share: await buildReportShare(input.artifacts, report) };
  }

  if (share.dashboardId) {
    const dashboard = findDashboardById(input.db, share.dashboardId);
    if (!dashboard) {
      return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
    }
    return { ok: true, share: buildDashboardShare(input.db, dashboard) };
  }

  return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
}

/**
 * Resolve a report inside a shared conversation without authentication, enforcing
 * active share token checks, department scope restrictions, and strict same-conversation
 * ownership so arbitrary report IDs cannot be probed across conversations.
 */
export async function resolveShareReport(
  input: ResolveShareReportInput,
): Promise<ResolveShareResult> {
  const now = input.now?.() ?? Date.now();
  const share = input.db
    .select()
    .from(shares)
    .where(eq(shares.tokenHash, hashShareToken(input.token)))
    .get();

  if (!share || share.revokedAt !== null || share.expiresAt <= now || !share.conversationId) {
    return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
  }

  if (shareTargetScopeEnforced(input.db, share.conversationId, undefined, undefined)) {
    return {
      ok: false,
      code: "SHARE_DISABLED_BY_SCOPE",
      message: "该数据源已启用部门数据权限，分享已失效",
    };
  }

  const conversation = findConversation(input.db, share.conversationId);
  const report = findReport(input.db, input.reportId);
  if (
    !conversation ||
    !report ||
    report.conversationId !== conversation.id ||
    report.userId !== conversation.userId
  ) {
    return { ok: false, code: "SHARE_GONE", message: SHARE_GONE_MESSAGE };
  }

  return { ok: true, share: await buildReportShare(input.artifacts, report) };
}

interface MessageGroup {
  createdAt: number;
  user: string | null;
  assistant: string | null;
  deltas: string[];
  sqls: string[];
  results: { artifactId: string; columns: ColumnInfo[]; rows: unknown[][] }[];
  charts: { artifactId: string; spec: unknown }[];
  pendingReportTools: Map<string, string[]>;
  reportArtifactIds: Set<string>;
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
    pendingReportTools: new Map(),
    reportArtifactIds: new Set(),
  };
  groups.set(runId, group);
  return group;
}

function extractToolArtifactIds(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const raw = (args as { artifactIds?: unknown }).artifactIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
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
      group.results.push({
        artifactId: event.payload.artifactId,
        columns: event.payload.columns,
        rows: event.payload.rows,
      });
      break;
    case "chart":
      group.charts.push({
        artifactId: event.payload.chartArtifactId,
        spec: event.payload.spec,
      });
      break;
    case "tool_start":
      if (event.payload.name === "create_report") {
        group.pendingReportTools.set(
          event.payload.toolCallId,
          extractToolArtifactIds(event.payload.args),
        );
      }
      break;
    case "tool_end":
      if (event.payload.name === "create_report" && !event.payload.isError) {
        const ids = group.pendingReportTools.get(event.payload.toolCallId) ?? [];
        for (const id of ids) group.reportArtifactIds.add(id);
      }
      break;
    default:
      break;
  }
}

const INLINE_PLACEHOLDER_RE =
  /\[\[(artifact|chart|result|excel|report):([^\]\s|]+)(?:\|([^\]\r\n]*))?\]\]/g;

function cleanShareText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function resolveChartSpecFromStore(
  artifactId: string,
  chartsById: Map<string, unknown>,
  artifacts: ArtifactStore,
  conversationId: string,
): { found: true; spec: unknown } | { found: false } {
  if (chartsById.has(artifactId)) {
    return { found: true, spec: chartsById.get(artifactId) };
  }
  const meta = artifacts.get(artifactId);
  if (!meta || meta.conversationId !== conversationId || meta.kind !== "chart" || !meta.specJson) {
    return { found: false };
  }
  try {
    return { found: true, spec: JSON.parse(meta.specJson) as unknown };
  } catch {
    return { found: false };
  }
}

interface ParsedInlineShareSegment {
  type: "text" | "artifact" | "chart" | "result" | "excel" | "report";
  text?: string;
  artifactId?: string;
  label?: string;
}

function parseInlineShareSegments(rawText: string): ParsedInlineShareSegment[] {
  const segments: ParsedInlineShareSegment[] = [];
  let cursor = 0;
  for (const match of rawText.matchAll(INLINE_PLACEHOLDER_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: "text", text: rawText.slice(cursor, index) });
    }
    const kind = match[1];
    const artifactId = match[2]?.trim();
    const rawLabel = match[3];
    if (!artifactId || (kind !== "result" && rawLabel !== undefined)) {
      segments.push({ type: "text", text: match[0] });
    } else if (kind === "chart" || kind === "excel" || kind === "report" || kind === "artifact") {
      segments.push({ type: kind, artifactId });
    } else if (kind === "result") {
      const label = rawLabel?.trim();
      segments.push({
        type: "result",
        artifactId,
        ...(label ? { label } : {}),
      });
    }
    cursor = index + match[0].length;
  }
  if (cursor < rawText.length) {
    segments.push({ type: "text", text: rawText.slice(cursor) });
  }
  return segments;
}

/**
 * Rebuild the conversation as a whitelisted public transcript. Run ids, audit ids,
 * datasource ids, storage paths and tool details are intentionally never copied.
 */
function buildConversationShare(
  db: Db,
  artifacts: ArtifactStore,
  conversation: ConversationRow,
): PublicConversationShare {
  const groups = new Map<string, MessageGroup>();
  for (const row of listConversationEvents(db, conversation.id, 20_000)) {
    const event = parseEvent(row);
    if (!event) continue;
    applyEvent(groupFor(groups, row.runId, row.createdAt), event);
  }

  const orderedGroups = [...groups.values()].sort((a, b) => a.createdAt - b.createdAt);
  const chartsById = new Map<string, unknown>();
  const resultsById = new Map<string, { columns: ColumnInfo[]; rows: unknown[][] }>();
  for (const group of orderedGroups) {
    for (const result of group.results) {
      resultsById.set(result.artifactId, { columns: result.columns, rows: result.rows });
    }
    for (const chart of group.charts) {
      chartsById.set(chart.artifactId, chart.spec);
    }
  }

  const messages: PublicShareMessage[] = [];
  for (const group of orderedGroups) {
    // Stray tool events without a user prompt are not part of the transcript.
    if (group.user === null) continue;
    messages.push({ role: "user", text: group.user });

    const rawText = group.assistant ?? group.deltas.join("");
    const inlineSegments = rawText ? parseInlineShareSegments(rawText) : [];
    const referencedArtifactIds = new Set<string>();
    for (const segment of inlineSegments) {
      if (
        (segment.type === "chart" ||
          segment.type === "result" ||
          segment.type === "artifact" ||
          segment.type === "excel") &&
        segment.artifactId
      ) {
        referencedArtifactIds.add(segment.artifactId);
      }
    }

    // Emit unreferenced results/charts first (backwards compatibility for turns without markers),
    // skipping charts bundled exclusively into reports.
    for (const result of group.results) {
      if (referencedArtifactIds.has(result.artifactId)) continue;
      messages.push({
        role: "assistant",
        text: "",
        columns: result.columns,
        rows: result.rows.slice(0, SHARE_MAX_ROWS),
      });
    }
    for (const chart of group.charts) {
      if (
        referencedArtifactIds.has(chart.artifactId) ||
        group.reportArtifactIds.has(chart.artifactId)
      ) {
        continue;
      }
      messages.push({ role: "assistant", text: "", chart: chart.spec });
    }

    let textBuffer = "";
    const turnTextMsgIndices: number[] = [];

    const flushTextBuffer = () => {
      const cleaned = cleanShareText(textBuffer);
      textBuffer = "";
      if (!cleaned) return;
      turnTextMsgIndices.push(messages.length);
      messages.push({ role: "assistant", text: cleaned });
    };

    for (const segment of inlineSegments) {
      if (segment.type === "text") {
        textBuffer += segment.text ?? "";
        continue;
      }
      if (segment.type === "excel" || segment.type === "report") {
        continue;
      }
      const artifactId = segment.artifactId ?? "";
      if (segment.type === "chart") {
        const resolved = resolveChartSpecFromStore(
          artifactId,
          chartsById,
          artifacts,
          conversation.id,
        );
        if (resolved.found) {
          flushTextBuffer();
          messages.push({ role: "assistant", text: "", chart: resolved.spec });
        }
        continue;
      }
      if (segment.type === "result") {
        const result = resultsById.get(artifactId);
        if (segment.label) {
          textBuffer += `「${segment.label}」`;
        }
        if (result) {
          flushTextBuffer();
          messages.push({
            role: "assistant",
            text: "",
            columns: result.columns,
            rows: result.rows.slice(0, SHARE_MAX_ROWS),
          });
        }
        continue;
      }
      // segment.type === "artifact"
      const chart = resolveChartSpecFromStore(
        artifactId,
        chartsById,
        artifacts,
        conversation.id,
      );
      if (chart.found) {
        flushTextBuffer();
        messages.push({ role: "assistant", text: "", chart: chart.spec });
        continue;
      }
      const result = resultsById.get(artifactId);
      if (result) {
        flushTextBuffer();
        messages.push({
          role: "assistant",
          text: "",
          columns: result.columns,
          rows: result.rows.slice(0, SHARE_MAX_ROWS),
        });
      }
    }

    flushTextBuffer();
    const sql = group.sqls.at(-1);
    if (sql !== undefined) {
      const lastTextIndex = turnTextMsgIndices.at(-1);
      if (lastTextIndex !== undefined) {
        messages[lastTextIndex] = { ...messages[lastTextIndex]!, sql };
      } else {
        messages.push({ role: "assistant", text: "", sql });
      }
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
    if (meta.kind === "excel") continue;
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

/** Deleting a report revokes its share links so no live rows point at a missing target. */
export function revokeSharesForReport(db: Db, reportId: string): number {
  const result = db
    .update(shares)
    .set({ revokedAt: Date.now() })
    .where(and(isNull(shares.revokedAt), eq(shares.reportId, reportId)))
    .run();
  return Number(result.changes ?? 0);
}

export function listShares(input: ListSharesInput): ShareListItem[] {
  const scope = input.scope === "all" && input.isAdmin ? "all" : "mine";
  const statusFilter = input.status ?? "active";
  const now = input.now ?? Date.now();

  const hasTargetFilter = Boolean(input.conversationId || input.reportId || input.dashboardId);
  if (
    hasTargetFilter &&
    scope !== "all" &&
    !isTargetFound(
      input.db,
      input.userId,
      input.conversationId,
      input.reportId,
      input.dashboardId,
    )
  ) {
    return [];
  }

  const conditions = [];
  if (scope !== "all") {
    conditions.push(eq(shares.createdBy, input.userId));
  }
  if (statusFilter === "active") {
    conditions.push(isNull(shares.revokedAt), gt(shares.expiresAt, now));
  }
  if (input.conversationId) {
    conditions.push(eq(shares.conversationId, input.conversationId));
  } else if (input.reportId) {
    conditions.push(eq(shares.reportId, input.reportId));
  } else if (input.dashboardId) {
    conditions.push(eq(shares.dashboardId, input.dashboardId));
  }

  const rows = input.db
    .select({
      id: shares.id,
      conversationId: shares.conversationId,
      reportId: shares.reportId,
      dashboardId: shares.dashboardId,
      createdBy: shares.createdBy,
      expiresAt: shares.expiresAt,
      revokedAt: shares.revokedAt,
      createdAt: shares.createdAt,
    })
    .from(shares)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(shares.createdAt))
    .limit(100)
    .all();

  if (rows.length === 0) return [];

  const convIds = [...new Set(rows.map((r) => r.conversationId).filter((v): v is string => Boolean(v)))];
  const reportIds = [...new Set(rows.map((r) => r.reportId).filter((v): v is string => Boolean(v)))];
  const dashboardIds = [...new Set(rows.map((r) => r.dashboardId).filter((v): v is string => Boolean(v)))];
  const creatorIds = scope === "all" ? [...new Set(rows.map((r) => r.createdBy))] : [];

  const convTitleMap = new Map(
    convIds.length > 0
      ? input.db
          .select({ id: conversations.id, title: conversations.title })
          .from(conversations)
          .where(inArray(conversations.id, convIds))
          .all()
          .map((row) => [row.id, row.title?.trim() || "未命名会话"])
      : [],
  );
  const reportTitleMap = new Map(
    reportIds.length > 0
      ? input.db
          .select({ id: reports.id, title: reports.title })
          .from(reports)
          .where(inArray(reports.id, reportIds))
          .all()
          .map((row) => [row.id, row.title])
      : [],
  );
  const dashboardTitleMap = new Map(
    dashboardIds.length > 0
      ? input.db
          .select({ id: dashboards.id, name: dashboards.name })
          .from(dashboards)
          .where(inArray(dashboards.id, dashboardIds))
          .all()
          .map((row) => [row.id, row.name])
      : [],
  );
  const creatorMap = new Map(
    creatorIds.length > 0
      ? input.db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.id, creatorIds))
          .all()
          .map((row) => [row.id, row.username])
      : [],
  );

  return rows.map((row) => {
    let targetType: ShareTargetType = "conversation";
    let targetId = row.conversationId ?? "";
    let targetTitle = "已删除的会话";
    if (row.reportId) {
      targetType = "report";
      targetId = row.reportId;
      targetTitle = reportTitleMap.get(row.reportId) ?? "已删除的报告";
    } else if (row.dashboardId) {
      targetType = "dashboard";
      targetId = row.dashboardId;
      targetTitle = dashboardTitleMap.get(row.dashboardId) ?? "已删除的看板";
    } else if (row.conversationId) {
      targetTitle = convTitleMap.get(row.conversationId) ?? "已删除的会话";
    }

    const status: ShareStatus =
      row.revokedAt !== null ? "revoked" : row.expiresAt <= now ? "expired" : "active";

    return {
      id: row.id,
      targetType,
      targetId,
      targetTitle,
      createdBy: row.createdBy,
      ...(scope === "all" ? { creatorUsername: creatorMap.get(row.createdBy) ?? "未知用户" } : {}),
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      status,
      createdAt: row.createdAt,
    };
  });
}
