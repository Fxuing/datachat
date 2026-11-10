import { eq } from "drizzle-orm";
import type { Column } from "@datachat/shared";
import { runEventSchema, type RunEvent } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import {
  encodeConversationCursor,
  listConversations,
  type ConversationRow,
} from "../db/repositories/conversations.js";
import { listConversationEvents } from "../db/repositories/run-events.js";
import {
  findActiveRunForConversation,
  findRun,
  type RunStatus,
} from "../db/repositories/runs.js";
import { listFeedbackForRuns } from "../db/repositories/run-feedback.js";
import type { ArtifactStore } from "./artifacts.js";

export interface ConversationResponse {
  id: string;
  datasourceId: string;
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
  user: { content: string };
  assistant: { content: string } | null;
  /** Full thinking transcript, when the model produced one. */
  thinking: string | null;
  usage: ConversationUsage | null;
  /** Wall-clock duration of the run, excluding queue time. */
  durationMs: number | null;
  /** The current user's rating for this run, if any. */
  feedback: ConversationFeedback | null;
  tools: ToolMessage[];
  results: ConversationResultMessage[];
  sqls: SqlMessage[];
  /** Terminal run error, so a reloaded history can explain what went wrong. */
  error: string | null;
  createdAt: number;
}

export interface ConversationArtifact {
  id: string;
  runId: string | null;
  kind: "result" | "chart";
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
  user: string | null;
  assistant: string | null;
  thinking: string | null;
  deltas: string[];
  tools: ToolMessage[];
  results: ConversationResultMessage[];
  sqls: SqlMessage[];
}

export function toConversationResponse(row: ConversationRow): ConversationResponse {
  return {
    id: row.id,
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
  opts: { limit?: number; before?: { sortTime: number; id: string } } = {},
): ConversationListPage {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const rows = listConversations(db, userId, { limit, before: opts.before });
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
    deltas: [],
    tools: [],
    results: [],
    sqls: [],
  };
  grouped.set(runId, group);
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
    case "thinking":
      group.thinking = event.payload.content;
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
      }
      break;
    }
    case "result":
      group.results.push(event.payload);
      break;
    case "sql":
      group.sqls.push(event.payload);
      break;
    default:
      break;
  }
}

export function getConversationDetail(
  db: Db,
  artifactsStore: ArtifactStore,
  conversation: ConversationRow,
): ConversationDetail {
  const grouped = new Map<string, MessageGroup>();
  let contextUsage: ConversationDetail["contextUsage"] = null;
  for (const row of listConversationEvents(db, conversation.id, 20_000)) {
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
    messages.push({
      runId: group.runId,
      status: toRunStatus(run?.status),
      user: { content: group.user },
      assistant: group.assistant !== null
        ? { content: group.assistant }
        : group.deltas.length > 0
          ? { content: group.deltas.join("") }
          : null,
      thinking: group.thinking,
      usage: toUsage(run),
      durationMs:
        run?.startedAt != null && run.endedAt != null
          ? Math.max(0, run.endedAt - run.startedAt)
          : null,
      feedback: toFeedback(feedbackByRun.get(group.runId)),
      tools: group.tools,
      results: group.results,
      sqls: group.sqls,
      error: run?.error ?? null,
      createdAt: group.createdAt,
    });
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
    .all();

  return {
    conversation: toConversationResponse(conversation),
    messages,
    activeRun: toActiveRun(findActiveRunForConversation(db, conversation.id)),
    artifacts: artifactRows.flatMap((row) => {
      const parsed = parseArtifactRow(row);
      return parsed ? [parsed] : [];
    }),
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
  kind: "result" | "chart";
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
): Promise<void> {
  for (const artifact of artifactsStore.list({ conversationId: conversation.id })) {
    await artifactsStore.delete(artifact.id);
  }
}
