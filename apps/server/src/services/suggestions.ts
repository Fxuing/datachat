import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { listConversationFileTables } from "../db/repositories/conversation-files.js";
import { findConversation } from "../db/repositories/conversations.js";
import { findDatasource } from "../db/repositories/datasources.js";
import { findRunEvent } from "../db/repositories/run-events.js";
import { findRun, saveRunSuggestions } from "../db/repositories/runs.js";
import { hasSensitiveMemory } from "../memory/secrets.js";
import { listChatModels, resolveChatModel, type ChatModel } from "../agent/model-runtime.js";
import { enabledProviderIds } from "./llm-catalog.js";

const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_LENGTH = 80;
const DEFAULT_TIMEOUT_MS = 15_000;

export const SUGGESTIONS_SYSTEM_PROMPT = `你是 DataChat 的追问建议生成器。根据本轮用户问题与助手回答，生成 2～3 个用户最可能紧接着继续追问的下一步问题。

要求：
1. 用简体中文，直接给用户视角的简短问题或指令（每条尽量不超过 18 字，方便单行展示），不要加序号、引号或“你可以问：”等前缀。
2. 紧扣本轮提到的指标、维度、时间范围、异常点或局限进行下钻、对比、拆解或验证，不要凭空编造当前对话未涉及的表或字段，也不要重复用户原问题。
3. 若本轮属于寒暄、闲聊、权限拒绝、无可用数据或报错而无进一步可分析线索，返回 {"suggestions":[]}。
4. 只输出 JSON，不要 Markdown 代码块或其他说明：
{"suggestions":["问题1","问题2","问题3"]}`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Remove internal inline placeholder markers so raw artifact ids never appear in prompts/suggestions. */
export function stripPlaceholders(text: string): string {
  return text
    .replace(/\[\[(?:artifact|chart|result):[^\]\r\n]*\]\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeQuestionText(raw: string): string {
  return raw
    .trim()
    .replace(/^[“"「『]+|[”"」』]+$/g, "")
    .replace(/^(?:[-*•·]|\d+[.)、。])\s*/, "")
    .replace(/^[“"「『]+|[”"」』]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSuggestedQuestions(raw: string, userQuestion?: string): string[] {
  let candidates: unknown[] = [];
  const objectMatch = raw.match(/\{[\s\S]*\}/)?.[0];
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch) as { suggestions?: unknown };
      if (Array.isArray(parsed.suggestions)) {
        candidates = parsed.suggestions;
      }
    } catch {
      // Fall through to bare JSON array parsing below.
    }
  }
  if (candidates.length === 0) {
    const arrayMatch = raw.match(/\[[\s\S]*\]/)?.[0];
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch) as unknown;
        if (Array.isArray(parsed)) {
          candidates = parsed;
        }
      } catch {
        return [];
      }
    }
  }
  if (candidates.length === 0) return [];

  const seen = new Set<string>();
  const normalizedUser = userQuestion ? normalizeQuestionText(userQuestion).toLowerCase() : "";
  if (normalizedUser) seen.add(normalizedUser);

  const suggestions: string[] = [];
  for (const item of candidates) {
    if (typeof item !== "string") continue;
    const text = normalizeQuestionText(item);
    if (!text || text.length > MAX_SUGGESTION_LENGTH) continue;
    if (text.includes("[[")) continue;
    if (hasSensitiveMemory(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(text);
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return suggestions;
}

export function parseStoredSuggestions(json: string | null | undefined): string[] | null {
  if (json === null || json === undefined) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const items: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const text = item.trim();
      if (!text) continue;
      items.push(text);
      if (items.length >= MAX_SUGGESTIONS) break;
    }
    return items;
  } catch {
    return [];
  }
}

export interface SuggestionsGeneratorOptions {
  config: AppConfig;
  runtime: ModelRuntime;
  model: ChatModel;
  timeoutMs?: number;
}

/** Tool-less, non-thinking session to keep follow-up generation fast and isolated from transcript. */
export function createSuggestionsGenerator(
  options: SuggestionsGeneratorOptions,
): (prompt: string) => Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (prompt) => {
    const loader = new DefaultResourceLoader({
      cwd: options.config.dataDir,
      agentDir: options.config.agentDir,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      systemPrompt: SUGGESTIONS_SYSTEM_PROMPT,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: options.config.dataDir,
      agentDir: options.config.agentDir,
      modelRuntime: options.runtime,
      model: options.model,
      thinkingLevel: "off",
      noTools: "all",
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void session.abort().catch(() => undefined);
        reject(new Error(`suggestions generation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    const promptPromise = session.prompt(prompt);
    // Avoid unhandled rejection if timeoutPromise settles first and prompt rejects on abort.
    promptPromise.catch(() => undefined);
    try {
      await Promise.race([promptPromise, timeoutPromise]);
      return session.getLastAssistantText() ?? "";
    } finally {
      if (timer) clearTimeout(timer);
      session.dispose();
    }
  };
}

export interface RunSuggestionsService {
  getForRun(runId: string): Promise<string[]>;
}

export interface RunSuggestionsServiceOptions {
  db: Db;
  config: AppConfig;
  getModelRuntime: () => Promise<ModelRuntime>;
  generateOverride?: (prompt: string) => Promise<string>;
  timeoutMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

function readEventContent(event: { payloadJson: string } | undefined): string {
  if (!event) return "";
  try {
    const payload = JSON.parse(event.payloadJson) as { content?: unknown };
    return typeof payload.content === "string" ? payload.content : "";
  } catch {
    return "";
  }
}

export function createRunSuggestionsService(
  options: RunSuggestionsServiceOptions,
): RunSuggestionsService {
  const inFlight = new Map<string, Promise<string[]>>();

  const generateForRun = async (runId: string): Promise<string[]> => {
    const run = findRun(options.db, runId);
    if (!run || run.status !== "ok") return [];
    if (run.suggestionsJson !== null) {
      return parseStoredSuggestions(run.suggestionsJson) ?? [];
    }

    const userText = readEventContent(findRunEvent(options.db, runId, "user_message"));
    const assistantText = readEventContent(findRunEvent(options.db, runId, "assistant_message"));
    const cleanedAssistant = stripPlaceholders(assistantText);
    if (!userText.trim() || !cleanedAssistant.trim()) {
      saveRunSuggestions(options.db, runId, "[]");
      return [];
    }

    const conversation = findConversation(options.db, run.conversationId);
    const contextLines: string[] = [];
    if (conversation?.sourceKind === "file") {
      const tableNames = listConversationFileTables(options.db, conversation.id)
        .map((table) => table.displayName || table.tableName)
        .filter(Boolean);
      contextLines.push(
        tableNames.length > 0
          ? `当前分析来源：上传文件（表：${tableNames.slice(0, 8).join("、")}）`
          : "当前分析来源：上传文件",
      );
    } else if (conversation?.datasourceId) {
      const datasource = findDatasource(options.db, conversation.datasourceId);
      if (datasource) {
        contextLines.push(`当前分析来源：数据源「${datasource.name}」`);
      }
    }

    const prompt = [
      ...contextLines,
      ...(contextLines.length > 0 ? [""] : []),
      "用户问题：",
      truncate(userText.trim(), 1_500),
      "",
      "助手回答：",
      truncate(cleanedAssistant, 3_500),
    ].join("\n");

    let generate = options.generateOverride;
    if (!generate) {
      let runtime: ModelRuntime;
      try {
        runtime = await options.getModelRuntime();
      } catch (error) {
        options.log?.("run_suggestions_failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
      const providerIds = enabledProviderIds(options.db);
      const preferredId = run.modelId ?? conversation?.modelId ?? "";
      const fallbackId = listChatModels(runtime, providerIds)[0]?.id;
      const model =
        (preferredId ? resolveChatModel(runtime, preferredId, providerIds) : undefined) ??
        (fallbackId ? resolveChatModel(runtime, fallbackId, providerIds) : undefined);
      if (!model) {
        return [];
      }
      generate = createSuggestionsGenerator({
        config: options.config,
        runtime,
        model,
        timeoutMs: options.timeoutMs,
      });
    }

    try {
      const raw = await generate(prompt);
      const suggestions = parseSuggestedQuestions(raw, userText);
      saveRunSuggestions(options.db, runId, JSON.stringify(suggestions));
      options.log?.("run_suggestions_generated", { runId, count: suggestions.length });
      return suggestions;
    } catch (error) {
      saveRunSuggestions(options.db, runId, "[]");
      options.log?.("run_suggestions_failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  return {
    getForRun(runId: string): Promise<string[]> {
      const run = findRun(options.db, runId);
      if (!run || run.status !== "ok") return Promise.resolve([]);
      if (run.suggestionsJson !== null) {
        return Promise.resolve(parseStoredSuggestions(run.suggestionsJson) ?? []);
      }
      const existing = inFlight.get(runId);
      if (existing) return existing;

      const task = generateForRun(runId).finally(() => {
        inFlight.delete(runId);
      });
      inFlight.set(runId, task);
      return task;
    },
  };
}
