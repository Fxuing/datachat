import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { ArtifactStore } from "../../services/artifacts.js";
import type { PoolRegistry } from "../datasource/pool.js";

/**
 * Everything a tool may touch. The ids are captured from the conversation/run
 * that built the tool set, so the model can never choose a datasource itself.
 */
export interface AgentToolContext {
  db: Db;
  config: AppConfig;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
  userId: string;
  conversationId: string;
  datasourceId: string | null;
  sourceKind?: "datasource" | "file";
  runId: string;
  /** Per-conversation materialized skills (`data/skills/<conversationId>`). */
  skillsDir: string;
}

export function isFileToolContext(ctx: AgentToolContext): boolean {
  return ctx.sourceKind === "file" || ctx.datasourceId === null;
}

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}

/**
 * Tool failures are part of the model-visible conversation, so they are
 * returned as `isError` content instead of being thrown into the agent loop.
 */
export function errorResult<TDetails>(
  code: string,
  message: string,
  details: TDetails,
): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text: safeJsonStringify({ code, message }) }],
    details,
    isError: true,
  };
}

/** JSON.stringify with the driver values that would otherwise throw or lose meaning. */
export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Date) return item.toISOString();
    if (Buffer.isBuffer(item)) return item.toString("base64");
    return item;
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
