import { rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  createConversation,
  findOwnedConversation,
  parseConversationCursor,
  updateConversation,
  deleteConversation,
  touchConversation,
} from "../db/repositories/conversations.js";
import { findDatasource, userCanAccess } from "../db/repositories/datasources.js";
import { appendRunEvent, findRunEvent } from "../db/repositories/run-events.js";
import {
  createRun,
  findOwnedRun,
  hasRetriedRun,
  markRun,
} from "../db/repositories/runs.js";
import {
  createAgentModelRuntime,
  listChatModels,
  modelKey,
  resolveChatModel,
  type ChatModelInfo,
} from "../agent/model-runtime.js";
import type { RuntimeManager } from "../agent/runtime.js";
import { composeSkillInstruction, findApplicableSkill, listApplicableSkills } from "../agent/skills.js";

import type { ArtifactStore } from "../services/artifacts.js";
import { resolveDefaultModelId } from "../services/app-settings.js";
import { enabledProviderIds } from "../services/llm-catalog.js";
import {
  deleteConversationFiles,
  getConversationDetail,
  listConversationPage,
  toConversationResponse,
} from "../services/conversation-service.js";

export interface ConversationRouteOptions {
  config: AppConfig;
  db: Db;
  artifacts: ArtifactStore;
  runtime: RuntimeManager;
  /** Test seam; production lazily creates the runtime on first model check. */
  getRuntime?: () => Promise<ModelRuntime>;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().trim().min(1).optional(),
});
const createBodySchema = z.object({
  datasourceId: z.string().uuid(),
  title: z.string().trim().min(1).max(100).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
});
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const updateBodySchema = z.object({
  title: z.string().trim().max(100).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});
const messageBodySchema = z.object({
  content: z.string().trim().min(1).max(8_000),
  skill: z.string().trim().min(1).max(100).optional(),
});

function error(code: string, message: string) {
  return { error: { code, message } };
}

type ConversationRecord = NonNullable<ReturnType<typeof findOwnedConversation>>;
type ConversationRuntime = Awaited<ReturnType<RuntimeManager["getOrCreate"]>>;

/**
 * Enqueues a prepared turn and records a terminal error when the runtime rejects it.
 * Callers translate the thrown error into a 500 response.
 */
function enqueueOrFail(
  opts: ConversationRouteOptions,
  conversation: ConversationRecord,
  runtime: ConversationRuntime,
  input: Parameters<ConversationRuntime["enqueue"]>[0],
): number {
  try {
    return runtime.enqueue(input);
  } catch (enqueueError) {
    const message =
      enqueueError instanceof Error ? enqueueError.message : String(enqueueError);
    markRun(opts.db, input.runId, {
      status: "error",
      error: message,
      endedAt: Date.now(),
    });
    try {
      const { seq, createdAt } = appendRunEvent(opts.db, {
        runId: input.runId,
        conversationId: conversation.id,
        type: "run_end",
        payload: { status: "error", error: message },
      });
      opts.runtime.bus.publish({
        runId: input.runId,
        conversationId: conversation.id,
        seq,
        createdAt,
        event: { type: "run_end", payload: { status: "error", error: message } },
      });
    } catch {
      // The run row already records the failure.
    }
    throw enqueueError;
  }
}

export async function conversationRoutes(
  app: FastifyInstance,
  opts: ConversationRouteOptions,
): Promise<void> {
  let runtimePromise: Promise<ModelRuntime> | undefined;
  const getRuntime =
    opts.getRuntime ??
    (() =>
      (runtimePromise = (runtimePromise ?? createAgentModelRuntime(opts.config)).catch(
        (error: unknown) => {
          runtimePromise = undefined;
          throw error;
        },
      )));

  app.get(
    "/api/conversations",
    { preHandler: app.authenticate },
    async (request) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return error("VALIDATION", "参数不合法");
      }
      const before = query.data.before ? parseConversationCursor(query.data.before) : undefined;
      if (query.data.before && !before) {
        return error("VALIDATION", "参数不合法");
      }
      return listConversationPage(opts.db, request.user!.sub, {
        limit: query.data.limit,
        before: before ?? undefined,
      });
    },
  );

  app.post(
    "/api/conversations",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = createBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const user = request.user!;
      const datasource = findDatasource(opts.db, body.data.datasourceId);
      if (
        !datasource ||
        !userCanAccess(opts.db, user.sub, datasource.id, user.role === "admin")
      ) {
        return reply.code(404).send(error("NOT_FOUND", "数据源不存在"));
      }
      let modelId = body.data.modelId;
      if (modelId !== undefined) {
        const providerIds = enabledProviderIds(opts.db);
        let model: ReturnType<typeof resolveChatModel>;
        try {
          model = resolveChatModel(await getRuntime(), modelId, providerIds);
        } catch {
          return reply.code(503).send(error("MODEL_RUNTIME_UNAVAILABLE", "模型服务不可用"));
        }
        if (!model) {
          return reply.code(400).send(error("VALIDATION", "模型不在白名单中"));
        }
        // Legacy bare ids are normalized to the canonical provider::model key.
        modelId = modelKey(model);
      } else {
        // New conversations start on the admin default when it is still usable; a
        // missing/unavailable default leaves modelId null so the runner falls back.
        modelId =
          (await resolveDefaultModelId({
            db: opts.db,
            config: opts.config,
            getRuntime,
          })) ?? undefined;
      }

      const conversation = createConversation(opts.db, {
        userId: user.sub,
        datasourceId: datasource.id,
        title: body.data.title ?? null,
        modelId: modelId ?? null,
      });
      return reply.code(201).send({ conversation: toConversationResponse(conversation) });
    },
  );

  app.get(
    "/api/conversations/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const conversation = findOwnedConversation(
        opts.db,
        params.data.id,
        request.user!.sub,
      );
      if (!conversation) {
        return reply.code(404).send(error("NOT_FOUND", "会话不存在"));
      }
      return getConversationDetail(opts.db, opts.artifacts, conversation);
    },
  );

  app.get(
    "/api/conversations/:id/skills",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const conversation = findOwnedConversation(
        opts.db,
        params.data.id,
        request.user!.sub,
      );
      if (!conversation) {
        return reply.code(404).send(error("NOT_FOUND", "会话不存在"));
      }
      return {
        skills: listApplicableSkills(opts.db, conversation.datasourceId).map((skill) => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
        })),
      };
    },
  );

  app.patch(
    "/api/conversations/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = updateBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const conversation = findOwnedConversation(
        opts.db,
        params.data.id,
        request.user!.sub,
      );
      if (!conversation) {
        return reply.code(404).send(error("NOT_FOUND", "会话不存在"));
      }

      let nextModelId: string | undefined;
      if (body.data.modelId !== undefined) {
        const providerIds = enabledProviderIds(opts.db);
        let model: ReturnType<typeof resolveChatModel>;
        try {
          model = resolveChatModel(await getRuntime(), body.data.modelId, providerIds);
        } catch {
          return reply.code(503).send(error("MODEL_RUNTIME_UNAVAILABLE", "模型服务不可用"));
        }
        if (!model) {
          return reply.code(400).send(error("VALIDATION", "模型不在白名单中"));
        }
        nextModelId = modelKey(model);
      }

      updateConversation(opts.db, conversation.id, {
        ...(body.data.title !== undefined
          ? { title: body.data.title.length > 0 ? body.data.title : null }
          : {}),
        ...(nextModelId !== undefined ? { modelId: nextModelId } : {}),
        ...(body.data.thinkingLevel !== undefined
          ? { thinkingLevel: body.data.thinkingLevel }
          : {}),
      });
      const updated = findOwnedConversation(
        opts.db,
        conversation.id,
        request.user!.sub,
      );
      return {
        conversation: toConversationResponse(updated ?? conversation),
      };
    },
  );

  app.delete(
    "/api/conversations/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const conversation = findOwnedConversation(
        opts.db,
        params.data.id,
        request.user!.sub,
      );
      if (!conversation) {
        return reply.code(404).send(error("NOT_FOUND", "会话不存在"));
      }

      if (opts.runtime.isBusy(conversation.id)) {
        return reply
          .code(409)
          .send(error("CONFLICT", "请先停止当前回答"));
      }

      await opts.runtime.remove(conversation.id);
      await deleteConversationFiles(opts.artifacts, conversation);
      if (conversation.piSessionFile) {
        const dataRoot = path.resolve(opts.config.dataDir);
        const sessionFile = path.resolve(conversation.piSessionFile);
        if (sessionFile === dataRoot || sessionFile.startsWith(dataRoot + path.sep)) {
          await rm(sessionFile, { force: true });
        }
      }
      deleteConversation(opts.db, conversation.id);
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/conversations/:id/messages",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = messageBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const user = request.user!;
      const conversation = findOwnedConversation(opts.db, params.data.id, user.sub);
      if (!conversation) {
        return reply.code(404).send(error("NOT_FOUND", "会话不存在"));
      }

      const content = body.data.content;
      const skill = body.data.skill
        ? findApplicableSkill(opts.db, conversation.datasourceId, body.data.skill)
        : undefined;
      if (body.data.skill && !skill) {
        return reply.code(400).send(error("UNKNOWN_SKILL", "技能不存在或未启用"));
      }
      const promptContent = skill ? composeSkillInstruction(skill, content) : content;
      const runtime = await opts.runtime.getOrCreate(conversation, user.sub);
      if (runtime.queueLength >= 5) {
        return reply.code(429).send(error("RATE_LIMITED", "当前会话排队消息过多，请稍后再试"));
      }

      const run = createRun(opts.db, {
        conversationId: conversation.id,
        userId: user.sub,
        modelId: conversation.modelId,
      });
      touchConversation(opts.db, conversation.id);

      if (!conversation.title) {
        updateConversation(opts.db, conversation.id, {
          title: content.replace(/\s+/g, " ").slice(0, 40),
        });
      }

      let position: number;
      try {
        position = enqueueOrFail(opts, conversation, runtime, {
          runId: run.id,
          content: promptContent,
          displayContent: content,
          ...(skill ? { skill: skill.name } : {}),
        });
      } catch (enqueueError) {
        request.log.error({ err: enqueueError, runId: run.id }, "failed to enqueue run");
        return reply.code(500).send(error("ENQUEUE_FAILED", "无法开始运行"));
      }

      return reply.code(202).send({ runId: run.id, position });
    },
  );

  app.post(
    "/api/runs/:runId/retry",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const user = request.user!;
      const failed = findOwnedRun(opts.db, params.data.runId, user.sub);
      if (!failed) {
        return reply.code(404).send(error("NOT_FOUND", "运行不存在"));
      }
      const conversation = findOwnedConversation(opts.db, failed.conversationId, user.sub);
      if (!conversation) {
        return reply.code(404).send(error("NOT_FOUND", "会话不存在"));
      }
      if (failed.status !== "error" && failed.status !== "aborted") {
        return reply.code(409).send(error("RUN_NOT_RETRYABLE", "只有失败或已停止的运行可以重试"));
      }
      if (hasRetriedRun(opts.db, failed.id)) {
        return reply.code(409).send(error("ALREADY_RETRIED", "这次运行已经重试过"));
      }

      const event = findRunEvent(opts.db, failed.id, "user_message");
      let payload: { content?: unknown; skill?: unknown } | null = null;
      try {
        payload = event
          ? (JSON.parse(event.payloadJson) as { content?: unknown; skill?: unknown })
          : null;
      } catch {
        payload = null;
      }
      const content = typeof payload?.content === "string" ? payload.content : null;
      if (!content) {
        return reply.code(409).send(error("RUN_NOT_RETRYABLE", "找不到原始问题，无法重试"));
      }
      const skillName = typeof payload?.skill === "string" ? payload.skill : undefined;
      const skill = skillName
        ? findApplicableSkill(opts.db, conversation.datasourceId, skillName)
        : undefined;
      if (skillName && !skill) {
        return reply.code(400).send(error("UNKNOWN_SKILL", "技能不存在或未启用"));
      }
      const promptContent = skill ? composeSkillInstruction(skill, content) : content;

      const runtime = await opts.runtime.getOrCreate(conversation, user.sub);
      if (runtime.queueLength >= 5) {
        return reply.code(429).send(error("RATE_LIMITED", "当前会话排队消息过多，请稍后再试"));
      }

      const run = createRun(opts.db, {
        conversationId: conversation.id,
        userId: user.sub,
        modelId: conversation.modelId,
        retryOfRunId: failed.id,
      });
      touchConversation(opts.db, conversation.id);

      let position: number;
      try {
        position = enqueueOrFail(opts, conversation, runtime, {
          runId: run.id,
          content: promptContent,
          displayContent: content,
          ...(skill ? { skill: skill.name } : {}),
        });
      } catch (enqueueError) {
        request.log.error({ err: enqueueError, runId: run.id }, "failed to enqueue retry");
        return reply.code(500).send(error("ENQUEUE_FAILED", "无法开始运行"));
      }

      return reply.code(202).send({ runId: run.id, position });
    },
  );
}
