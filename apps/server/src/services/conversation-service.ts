import { rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Column } from "@datachat/shared";
import { runEventSchema, type RunEvent, type RunMemory } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import {
  listConversationFiles,
  listConversationFileTables,
  type ConversationFileSummary,
  type ConversationFileTableSummary,
} from "../db/repositories/conversation-files.js";
import {
  encodeConversationCursor,
  listConversations,
  type ConversationRow,
  type ConversationSourceKind,
} from "../db/repositories/conversations.js";
import { listConversationEvents } from "../db/repositories/run-events.js";
import {
  findActiveRunForConversation,
  findRun,
  listReplacedRunIds,
  type RunRow,
  type RunStatus,
} from "../db/repositories/runs.js";
import { listFeedbackForRuns } from "../db/repositories/run-feedback.js";
import type { ArtifactStore } from "./artifacts.js";
import { parseScopeSnapshot } from "./data-scope.js";
import { removeConversationFileDir } from "./file-store.js";
import { artifactRunVisible, runScopeVisible } from "./scope-access.js";
import { parseStoredSuggestions } from "./suggestions.js";

export interface ConversationResponse {
  id: string;
  sourceKind: ConversationSourceKind;
  datasourceId: string | null;
  title: string | null;
  modelId: string | null;
  thinkingLevel: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

export interface ConversationListPage {
  items: ConversationResponse[];
  nextCursor: string | null;
}

export interface ToolMessage {
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  durationMs?: number;
  summary?: string;
  url?: string;
}

export interface ConversationReportMessage {
  reportId: string;
  title: string;
}

export interface ConversationResultMessage {
  artifactId: string;
  columns: Column[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  sql?: string;
}

export interface SqlMessage {
  sql: string;
  auditId: string;
  status: "ok" | "rejected" | "error";
}

export interface ConversationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ConversationFeedback {
  rating: 1 | -1;
  comment: string | null;
}

export interface ConversationMessage {
  runId: string;
  status: RunStatus;
  user: { content: string; skill?: string | null };
  assistant: { content: string } | null;
  /** Full thinking transcript, when the model produced one. */
  thinking: string | null;
  /** The same transcript split where tool calls interrupted the reasoning. */
  thinkingSegments: string[] | null;
  /** Memories that were injected into this turn, for the trace. */
  memories: RunMemory[] | null;
  usage: ConversationUsage | null;
  /** Wall-clock duration of the run, excluding queue time. */
  durationMs: number | null;
  /** The current user's rating for this run, if any. */
  feedback: ConversationFeedback | null;
  tools: ToolMessage[];
  results: ConversationResultMessage[];
  sqls: SqlMessage[];
  reports?: ConversationReportMessage[];
  /** Department range that filtered this run; null when nothing was rewritten. */
  scope: { departments: string[] } | null;
  /** Cached follow-up suggestions; null means completed turn can fetch lazily. */
  suggestions?: string[] | null;
  /** Terminal run error, so a reloaded history can explain what went wrong. */
  error: string | null;
  createdAt: number;
}

export interface ConversationArtifact {
  id: string;
  runId: string | null;
  kind: "result" | "chart" | "excel";
  columns: Column[];
  rowCount: number;
  truncated: boolean;
  spec: unknown;
  createdAt: number;
}

export interface ConversationDetail {
  conversation: ConversationResponse;
  messages: ConversationMessage[];
  artifacts: ConversationArtifact[];
  files?: ConversationFileSummary[];
  tables?: ConversationFileTableSummary[];
  /** Set while a run is queued/running, so a reloaded page can resume streaming. */
  activeRun: { id: string; status: "queued" | "running" } | null;
  /** Latest context usage reported by the agent session, if any. */
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
}

interface MessageGroup {
  runId: string;
  createdAt: number;
  user: { content: string; skill?: string } | null;
  assistant: string | null;
  thinking: string | null;
  thinkingSegments: string[] | null;
  memories: RunMemory[];
  deltas: string[];
  tools: ToolMessage[];
  results: ConversationResultMessage[];
  sqls: SqlMessage[];
  reports: ConversationReportMessage[];
}

export function toConversationResponse(row: ConversationRow): ConversationResponse {
  return {
    id: row.id,
    sourceKind: row.sourceKind,
    datasourceId: row.datasourceId,
    title: row.title,
    modelId: row.modelId,
    thinkingLevel: row.thinkingLevel,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
  };
}

export function listConversationPage(
  db: Db,
  userId: string,
  opts: { limit?: number; before?: { sortTime: number; id: string }; q?: string } = {},
): ConversationListPage {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const rows = listConversations(db, userId, { limit, before: opts.before, q: opts.q });
  const items = rows.map(toConversationResponse);
  const last = rows.at(-1);
  const nextCursor =
    rows.length === limit && last
      ? encodeConversationCursor({
          sortTime: last.lastMessageAt ?? last.createdAt,
          id: last.id,
        })
      : null;
  return { items, nextCursor };
}

function toRunStatus(value: string | undefined): RunStatus {
  if (value === "queued" || value === "running" || value === "ok" || value === "error" || value === "aborted") {
    return value;
  }
  return "running";
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

function groupFor(grouped: Map<string, MessageGroup>, runId: string, createdAt: number): MessageGroup {
  const existing = grouped.get(runId);
  if (existing) return existing;
  const group: MessageGroup = {
    runId,
    createdAt,
    user: null,
    assistant: null,
    thinking: null,
    thinkingSegments: null,
    memories: [],
    deltas: [],
    tools: [],
    results: [],
    sqls: [],
    reports: [],
  };
  grouped.set(runId, group);
  return group;
}

function applyEvent(group: MessageGroup, event: RunEvent): void {
  switch (event.type) {
    case "user_message":
      group.user = {
        content: event.payload.content,
        ...(event.payload.skill ? { skill: event.payload.skill } : {}),
      };
      break;
    case "assistant_message":
      group.assistant = event.payload.content;
      break;
    case "thinking":
      group.thinking = event.payload.content;
      // Rows written before segments existed only carry the joined text.
      group.thinkingSegments = event.payload.segments ?? [event.payload.content];
      break;
    case "memory_used":
      group.memories = event.payload.memories;
      break;
    case "text_delta":
      group.deltas.push(event.payload.text);
      break;
    case "tool_start":
      group.tools.push({
        toolCallId: event.payload.toolCallId,
        name: event.payload.name,
        args: event.payload.args,
        status: "running",
      });
      break;
    case "tool_end": {
      const tool = group.tools.find((item) => item.toolCallId === event.payload.toolCallId);
      if (tool) {
        tool.status = event.payload.isError ? "error" : "ok";
        tool.durationMs = event.payload.durationMs;
        tool.summary = event.payload.summary;
        if (event.payload.url) tool.url = event.payload.url;
      }
      break;
    }
    case "result":
      group.results.push(event.payload);
      break;
    case "sql":
      group.sqls.push(event.payload);
      break;
    case "report": {
      const existing = group.reports.findIndex(
        (item) => item.reportId === event.payload.reportId,
      );
      if (existing === -1) group.reports.push(event.payload);
      else group.reports[existing] = event.payload;
      break;
    }
    default:
      break;
  }
}

export interface ConversationViewer {
  userId: string;
  isAdmin: boolean;
}

/** The visible department range for a run that actually rewrote at least one table. */
function toMessageScope(run: RunRow | null | undefined): ConversationMessage["scope"] {
  const snapshot = parseScopeSnapshot(run?.scopeSnapshot ?? null);
  if (!snapshot || snapshot.departments.length === 0) return null;
  if (!snapshot.scopedTables || snapshot.scopedTables.length === 0) return null;
  const names =
    snapshot.departmentNames && snapshot.departmentNames.length > 0
      ? snapshot.departmentNames
      : snapshot.departments;
  return { departments: names };
}

export function getConversationDetail(
  db: Db,
  artifactsStore: ArtifactStore,
  conversation: ConversationRow,
  viewer?: ConversationViewer,
): ConversationDetail {
  const grouped = new Map<string, MessageGroup>();
  const retriedRunIds = listReplacedRunIds(db, conversation.id);
  let contextUsage: ConversationDetail["contextUsage"] = null;
  for (const row of listConversationEvents(db, conversation.id, 20_000)) {
    if (retriedRunIds.has(row.runId)) continue;
    const event = parseEvent(row);
    if (!event) continue;
    if (event.type === "context_usage") {
      contextUsage = event.payload;
      continue;
    }
    applyEvent(groupFor(grouped, row.runId, row.createdAt), event);
  }

  const feedbackByRun = listFeedbackForRuns(
    db,
    [...grouped.keys()],
    conversation.userId,
  );
  const messages: ConversationMessage[] = [];
  for (const group of [...grouped.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    if (group.user === null) continue;
    const run = findRun(db, group.runId);
    if (viewer && run && !runScopeVisible(db, run, viewer.isAdmin)) continue;
    const assistantContent =
      group.assistant !== null
        ? group.assistant
        : group.deltas.length > 0
          ? group.deltas.join("")
          : null;
    const suggestions =
      run?.status === "ok" && assistantContent?.trim()
        ? run.suggestionsJson !== null
          ? parseStoredSuggestions(run.suggestionsJson) ?? []
          : null
        : [];
    messages.push({
      runId: group.runId,
      status: toRunStatus(run?.status),
      user: group.user,
      assistant: assistantContent !== null ? { content: assistantContent } : null,
      thinking: group.thinking,
      thinkingSegments: group.thinkingSegments,
      memories: group.memories.length > 0 ? group.memories : null,
      usage: toUsage(run),
      durationMs:
        run?.startedAt != null && run.endedAt != null
          ? Math.max(0, run.endedAt - run.startedAt)
          : null,
      feedback: toFeedback(feedbackByRun.get(group.runId)),
      tools: group.tools,
      results: group.results,
      sqls: group.sqls,
      ...(group.reports.length > 0 ? { reports: group.reports } : {}),
      scope: toMessageScope(run),
      suggestions,
      error: run?.error ?? null,
      createdAt: group.createdAt,
    });
  }

  const referencedChartIds = new Set<string>();
  const referencedExcelIds = new Set<string>();
  for (const message of messages) {
    const content = message.assistant?.content ?? "";
    for (const match of content.matchAll(/\[\[chart:([^\]\s|]+)\]\]/g)) {
      if (match[1]) referencedChartIds.add(match[1]);
    }
    for (const match of content.matchAll(/\[\[excel:([^\]\s|]+)\]\]/g)) {
      if (match[1]) referencedExcelIds.add(match[1]);
    }
  }

  const artifactRows = db
    .select({
      id: artifacts.id,
      runId: artifacts.runId,
      kind: artifacts.kind,
      columnsJson: artifacts.columnsJson,
      rowCount: artifacts.rowCount,
      truncated: artifacts.truncated,
      specJson: artifacts.specJson,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .where(eq(artifacts.conversationId, conversation.id))
    .orderBy(artifacts.createdAt)
    .all()
    .filter(
      (row) =>
        (row.runId === null ||
          !retriedRunIds.has(row.runId) ||
          (row.kind === "chart" && referencedChartIds.has(row.id)) ||
          (row.kind === "excel" && referencedExcelIds.has(row.id))) &&
        (row.runId === null || !viewer || artifactRunVisible(db, row.runId, viewer.isAdmin)),
    );

  const fileDetails =
    conversation.sourceKind === "file"
      ? {
          files: listConversationFiles(db, conversation.id),
          tables: listConversationFileTables(db, conversation.id),
        }
      : {};

  return {
    conversation: toConversationResponse(conversation),
    messages,
    activeRun: toActiveRun(findActiveRunForConversation(db, conversation.id)),
    artifacts: artifactRows.flatMap((row) => {
      const parsed = parseArtifactRow(row);
      return parsed ? [parsed] : [];
    }),
    ...fileDetails,
    contextUsage,
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function parseArtifactRow(row: {
  id: string;
  runId: string | null;
  kind: "result" | "chart" | "excel";
  columnsJson: string | null;
  rowCount: number;
  truncated: number;
  specJson: string | null;
  createdAt: number;
}): ConversationArtifact | null {
  const columns = row.columnsJson ? parseJson(row.columnsJson) : [];
  if (!Array.isArray(columns)) return null;
  const spec = row.specJson ? parseJson(row.specJson) : null;
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    columns: columns as Column[],
    rowCount: row.rowCount,
    truncated: row.truncated === 1,
    spec: spec ?? null,
    createdAt: row.createdAt,
  };
}

function toActiveRun(run: { id: string; status: string } | undefined): ConversationDetail["activeRun"] {
  if (!run) return null;
  if (run.status !== "queued" && run.status !== "running") return null;
  return { id: run.id, status: run.status };
}

function toUsage(run: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null } | undefined): ConversationUsage | null {
  if (!run) return null;
  if (
    run.inputTokens === null &&
    run.outputTokens === null &&
    run.cacheReadTokens === null &&
    run.cacheWriteTokens === null
  ) {
    return null;
  }
  return {
    input: run.inputTokens ?? 0,
    output: run.outputTokens ?? 0,
    cacheRead: run.cacheReadTokens ?? 0,
    cacheWrite: run.cacheWriteTokens ?? 0,
  };
}

function toFeedback(
  row: { rating: number; comment: string | null } | undefined,
): ConversationFeedback | null {
  if (!row) return null;
  if (row.rating !== 1 && row.rating !== -1) return null;
  return { rating: row.rating, comment: row.comment };
}

export async function deleteConversationFiles(
  artifactsStore: ArtifactStore,
  conversation: ConversationRow,
  dataDir?: string,
): Promise<void> {
  // The store lists at most 100 rows per call; keep draining so a conversation
  // with many results does not leave files/rows behind.
  for (;;) {
    const batch = artifactsStore.list({ conversationId: conversation.id, limit: 100 });
    if (batch.length === 0) break;
    for (const artifact of batch) {
      await artifactsStore.delete(artifact.id);
    }
  }
  if (dataDir) {
    await removeConversationFileDir(dataDir, conversation.id).catch(() => undefined);
    await rm(path.join(dataDir, "workspaces", conversation.id), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}
