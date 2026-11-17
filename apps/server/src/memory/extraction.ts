import type { Db } from "../db/client.js";
import { findConversation } from "../db/repositories/conversations.js";
import { findRun } from "../db/repositories/runs.js";
import { findRunEvent } from "../db/repositories/run-events.js";
import {
  countMemoriesBySourceRun,
  isMemoryEnabled,
  markRunMemoryExtracted,
  upsertUserMemory,
} from "../db/repositories/user-memories.js";
import type { MemoryKind } from "../db/repositories/user-memories.js";
import { hasSensitiveMemory } from "./secrets.js";

export const EXTRACTION_SYSTEM_PROMPT = `你是 DataChat 的记忆提取器。只提取跨会话仍然成立的用户信息，不要提取查询结果、具体数字、临时筛选条件、SQL、表名清单或密码/Token。
只输出 JSON，不要 Markdown：
{"memories":[{"kind":"profile|instruction|preference|fact","title":"不超过60字","content":"不超过300字","scope":"global|datasource","core":false,"confidence":0-100}]}
最多 3 条；没有可沉淀内容返回 {"memories":[]}。不确定时降低 confidence。`;

const KINDS = new Set<MemoryKind>(["profile", "instruction", "preference", "fact"]);

export interface ExtractMemoryInput {
  kind: MemoryKind;
  title: string;
  content: string;
  scope: "global" | "datasource";
  core: boolean;
  confidence: number;
}

export interface MemoryExtractionOptions {
  db: Db;
  runId: string;
  generate: (prompt: string) => Promise<string>;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface MemoryExtractionResult {
  status: "skipped" | "extracted" | "failed";
  saved: number;
  reason?: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function parseExtractedMemories(raw: string): unknown[] {
  const object = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!object) return [];
  try {
    const parsed = JSON.parse(object) as { memories?: unknown };
    return Array.isArray(parsed.memories) ? parsed.memories.slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function validateExtractedMemory(raw: unknown): ExtractMemoryInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const kind = value.kind;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const content = typeof value.content === "string" ? value.content.trim() : "";
  if (!KINDS.has(kind as MemoryKind) || !title || !content) return undefined;
  if (title.length > 60 || content.length > 300) return undefined;
  if (hasSensitiveMemory(`${title}\n${content}`)) return undefined;
  const scope = value.scope === "datasource" ? "datasource" : "global";
  const core =
    kind === "profile" || kind === "instruction" ? value.core === true : false;
  const confidence =
    typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? Math.max(0, Math.min(100, Math.round(value.confidence)))
      : 60;
  return { kind: kind as MemoryKind, title, content, scope, core, confidence };
}

/**
 * Best-effort extraction after a successful run. The marker is written even when
 * extraction fails so one run cannot retry a paid model call forever.
 */
export async function extractMemoriesForRun(
  options: MemoryExtractionOptions,
): Promise<MemoryExtractionResult> {
  const run = findRun(options.db, options.runId);
  if (!run || run.status !== "ok" || run.memoryExtractedAt) {
    return { status: "skipped", saved: 0, reason: "not_eligible" };
  }
  if (!isMemoryEnabled(options.db, run.userId)) {
    return { status: "skipped", saved: 0, reason: "disabled" };
  }
  if (countMemoriesBySourceRun(options.db, run.id) > 0) {
    markRunMemoryExtracted(options.db, run.id, (options.now ?? Date.now)());
    return { status: "skipped", saved: 0, reason: "already_saved" };
  }

  const userEvent = findRunEvent(options.db, run.id, "user_message");
  const assistantEvent = findRunEvent(options.db, run.id, "assistant_message");
  const readContent = (event: typeof userEvent): string => {
    if (!event) return "";
    try {
      const payload = JSON.parse(event.payloadJson) as { content?: unknown };
      return typeof payload.content === "string" ? payload.content : "";
    } catch {
      return "";
    }
  };
  const userText = readContent(userEvent);
  const assistantText = readContent(assistantEvent);
  if (!userText.trim() || !assistantText.trim()) {
    markRunMemoryExtracted(options.db, run.id, (options.now ?? Date.now)());
    return { status: "skipped", saved: 0, reason: "empty" };
  }

  const prompt = [
    "用户消息：",
    truncate(userText, 4000),
    "",
    "助手最终回答：",
    truncate(assistantText, 4000),
  ].join("\n");
  try {
    const raw = await options.generate(prompt);
    const memories = parseExtractedMemories(raw)
      .map((entry) => validateExtractedMemory(entry))
      .filter((entry): entry is ExtractMemoryInput => Boolean(entry));
    const datasourceId = findConversation(options.db, run.conversationId)?.datasourceId ?? "";
    let saved = 0;
    for (const entry of memories) {
      upsertUserMemory(options.db, {
        userId: run.userId,
        kind: entry.kind,
        title: entry.title,
        content: entry.content,
        scope: entry.scope,
        datasourceId: entry.scope === "datasource" ? datasourceId : null,
        core: entry.core,
        confidence: entry.confidence,
        sourceConversationId: run.conversationId,
        sourceRunId: run.id,
      });
      saved += 1;
    }
    markRunMemoryExtracted(options.db, run.id, (options.now ?? Date.now)());
    options.log?.("memory_extracted", { runId: run.id, saved });
    return { status: "extracted", saved };
  } catch (error) {
    markRunMemoryExtracted(options.db, run.id, (options.now ?? Date.now)());
    options.log?.("memory_extraction_failed", {
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", saved: 0, reason: "generate_failed" };
  }
}
