import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Column, RunEvent } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { appendRunEvent } from "../db/repositories/run-events.js";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface EventBridgeInput {
  db: Db;
  runId: string;
  conversationId: string;
  session: AgentSession;
  emit: (event: RunEvent & { seq: number }) => void;
}

export interface EventBridge {
  usage: UsageTotals;
  stop: () => void;
}

interface ToolDetails {
  artifactId?: unknown;
  columns?: unknown;
  rowCount?: unknown;
  truncated?: unknown;
  previewRows?: unknown;
  auditId?: unknown;
  sql?: unknown;
  guard?: unknown;
  code?: unknown;
  message?: unknown;
  durationMs?: unknown;
}

interface ToolResultLike {
  content?: unknown;
  details?: unknown;
}

const MAX_SUMMARY = 200;

function truncate(text: string): string {
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}

function asDetails(value: unknown): ToolDetails | undefined {
  return value !== null && typeof value === "object" ? (value as ToolDetails) : undefined;
}

function toolResultText(result: unknown): string {
  const content = (result as ToolResultLike | undefined)?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      const block = part as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function summarizeToolResult(result: unknown): string {
  const details = asDetails((result as ToolResultLike | undefined)?.details);
  if (details) {
    if (typeof details.message === "string" && details.message) return truncate(details.message);
    if (typeof details.rowCount === "number") return `${details.rowCount} 行`;
  }
  return truncate(toolResultText(result));
}

function sqlStatus(details: ToolDetails): "ok" | "rejected" | "error" {
  if (details.guard === "ok") return "ok";
  const code = typeof details.code === "string" ? details.code : "";
  return code === "SQL_ERROR" || code === "SQL_TIMEOUT" || code === "SQL_ABORTED" || code === "TOOL_ERROR"
    ? "error"
    : "rejected";
}

function previewRowsFromResult(result: unknown): unknown[][] {
  const text = toolResultText(result);
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return [];
    const rows = (parsed as { previewRows?: unknown }).previewRows;
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is unknown[] => Array.isArray(row));
  } catch {
    return [];
  }
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      const block = part as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Translate one Pi session's events into the shared RunEvent union, persisting every
 * event before it reaches the live subscriber. A failed append is deliberately
 * swallowed: losing a stream frame is preferable to killing the agent run.
 */
export function bridgeSessionEvents(input: EventBridgeInput): EventBridge {
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let streamedText = "";
  let completedText = "";
  let ended = false;

  const persist = (event: RunEvent): void => {
    try {
      const { seq } = appendRunEvent(input.db, {
        runId: input.runId,
        conversationId: input.conversationId,
        type: event.type,
        payload: event.payload,
      });
      if (event.type === "run_end") ended = true;
      input.emit({ ...event, seq } as RunEvent & { seq: number });
    } catch {
      // Persistence/streaming must never abort the run.
    }
  };

  const handle = (event: AgentSessionEvent): void => {
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          streamedText += update.delta;
          persist({ type: "text_delta", payload: { text: update.delta } });
        } else if (update.type === "thinking_delta") {
          persist({ type: "thinking_delta", payload: { text: update.delta } });
        }
        return;
      }
      case "message_end": {
        const message = event.message;
        if (message.role !== "assistant") return;
        const text = assistantText(message);
        if (text) completedText += completedText ? `\n\n${text}` : text;
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite;
        return;
      }
      case "tool_execution_start": {
        persist({
          type: "tool_start",
          payload: { toolCallId: event.toolCallId, name: event.toolName, args: event.args },
        });
        return;
      }
      case "tool_execution_end": {
        const details = asDetails(event.result?.details);
        const durationMs = Math.max(0, Math.round(event.durationMs ?? Number(details?.durationMs ?? 0)));
        persist({
          type: "tool_end",
          payload: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            durationMs,
            summary: summarizeToolResult(event.result),
          },
        });

        if (event.toolName !== "db_query") return;
        if (!event.isError && details && details.guard === "ok") {
          const columns = Array.isArray(details.columns) ? details.columns : [];
          const rows = previewRowsFromResult(event.result);
          if (
            typeof details.artifactId === "string" &&
            typeof details.rowCount === "number" &&
            typeof details.truncated === "boolean"
          ) {
            persist({
              type: "result",
              payload: {
                artifactId: details.artifactId,
                columns: columns as Column[],
                rows,
                rowCount: details.rowCount,
                truncated: details.truncated,
              },
            });
          }
        }
        if (typeof details?.sql === "string" && typeof details.auditId === "string" && details.auditId) {
          persist({
            type: "sql",
            payload: {
              sql: details.sql,
              auditId: details.auditId,
              status: sqlStatus(details),
            },
          });
        }
        return;
      }
      case "auto_retry_start": {
        persist({
          type: "retry",
          payload: {
            attempt: event.attempt,
            delayMs: event.delayMs,
            message: event.errorMessage,
          },
        });
        return;
      }
      case "compaction_end": {
        persist({
          type: "compaction",
          payload: {
            reason: event.reason,
            tokensBefore: event.result?.tokensBefore,
            tokensAfter: event.result?.estimatedTokensAfter,
          },
        });
        return;
      }
      case "agent_end": {
        const lastAssistant = [...event.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        const fallback = lastAssistant?.role === "assistant" ? assistantText(lastAssistant) : "";
        const content = completedText || streamedText || fallback;
        if (content) persist({ type: "assistant_message", payload: { content } });
        persist({ type: "usage", payload: { ...usage } });
        if (event.willRetry) return;

        const stopReason = lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined;
        const errorMessage =
          lastAssistant?.role === "assistant" ? lastAssistant.errorMessage : undefined;
        const status =
          stopReason === "aborted"
            ? "aborted"
            : stopReason === "error" || errorMessage
              ? "error"
              : "ok";
        persist({
          type: "run_end",
          payload: errorMessage ? { status, error: errorMessage } : { status },
        });
        return;
      }
      case "agent_settled": {
        if (event.aborted && !ended) {
          persist({ type: "run_end", payload: { status: "aborted" } });
        }
        return;
      }
      default:
        return;
    }
  };

  const unsubscribe = input.session.subscribe(handle);
  return {
    usage,
    stop: () => {
      unsubscribe();
    },
  };
}
