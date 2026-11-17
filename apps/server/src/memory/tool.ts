import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Db } from "../db/client.js";
import {
  upsertUserMemory,
  type MemoryKind,
} from "../db/repositories/user-memories.js";
import { errorResult, safeJsonStringify, textResult } from "../agent/tools/context.js";
import { hasSensitiveMemory } from "./secrets.js";

const memorySaveParameters = Type.Object({
  kind: Type.Union([
    Type.Literal("profile"),
    Type.Literal("instruction"),
    Type.Literal("preference"),
    Type.Literal("fact"),
  ]),
  title: Type.String({ minLength: 1, maxLength: 60 }),
  content: Type.String({ minLength: 1, maxLength: 1000 }),
  scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("datasource")])),
  core: Type.Optional(Type.Boolean()),
  confidence: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
});

export interface MemorySaveDetails {
  saved: boolean;
  id?: string;
  merged?: boolean;
  code?: string;
  message?: string;
}

export interface MemorySaveContext {
  db: Db;
  userId: string;
  datasourceId: string;
  sourceConversationId?: string;
  sourceRunId?: string;
}

/**
 * The model-facing write path. It can add/merge memories but never delete or disable them;
 * those operations stay in the user's management page.
 */
export function createMemorySaveTool(
  ctx: MemorySaveContext,
): ToolDefinition<typeof memorySaveParameters, MemorySaveDetails> {
  return {
    name: "memory_save",
    label: "记住用户偏好",
    description:
      "当用户表达跨会话仍然稳定的偏好、固定指令或业务口径时调用。不要保存查询结果、具体数字、临时筛选条件、密码/Token。保存前先判断是否长期有效；不确定时降低 confidence。",
    parameters: memorySaveParameters,
    async execute(_toolCallId, params) {
      const kind = params.kind as MemoryKind;
      const content = params.content.trim();
      const title = params.title.trim();
      if (!content || !title) {
        return errorResult("MEMORY_INVALID", "标题和内容不能为空", {
          saved: false,
          code: "MEMORY_INVALID",
          message: "标题和内容不能为空",
        });
      }
      if (params.core === true && kind !== "profile" && kind !== "instruction") {
        return errorResult("MEMORY_CORE_INVALID", "只有画像或固定指令可以设为核心记忆", {
          saved: false,
          code: "MEMORY_CORE_INVALID",
          message: "只有画像或固定指令可以设为核心记忆",
        });
      }
      if (hasSensitiveMemory(`${title}\n${content}`)) {
        return errorResult("MEMORY_SECRET_DETECTED", "内容包含密码、密钥或敏感个人信息，未保存", {
          saved: false,
          code: "MEMORY_SECRET_DETECTED",
          message: "内容包含密码、密钥或敏感个人信息，未保存",
        });
      }

      const { memory, merged } = upsertUserMemory(ctx.db, {
        userId: ctx.userId,
        kind,
        title,
        content,
        scope: params.scope === "datasource" ? "datasource" : "global",
        datasourceId: params.scope === "datasource" ? ctx.datasourceId : null,
        core: params.core === true,
        confidence: params.confidence ?? 80,
        sourceConversationId: ctx.sourceConversationId,
        sourceRunId: ctx.sourceRunId,
      });
      const details: MemorySaveDetails = { saved: true, id: memory.id, merged };
      return textResult(
        `已记住：${memory.title}\n${safeJsonStringify(details)}`,
        details,
      );
    },
  };
}
