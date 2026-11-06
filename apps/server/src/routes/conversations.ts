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
import { appendRunEvent } from "../db/repositories/run-events.js";
import { createRun, markRun } from "../db/repositories/runs.js";
import { createAgentModelRuntime, listChatModels } from "../agent/model-runtime.js";
import type { RuntimeManager } from "../agent/runtime.js";
import type { ArtifactStore } from "../services/artifacts.js";
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
});
const updateBodySchema = z.object({
  title: z.string().trim().max(100).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
});
const messageBodySchema = z.object({
  content: z.string().trim().min(1).max(8_000),
});

function error(code: string, message: string) {
  return { error: { code, message } };
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
      const conversation = createConversation(opts.db, {
        userId: user.sub,
        datasourceId: datasource.id,
        title: body.data.title ?? null,
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

      if (body.data.modelId !== undefined) {
        const runtime = await getRuntime();
        const models = listChatModels(runtime);
        if (models.length === 0) {
          return reply.code(503).send(error("MODEL_RUNTIME_UNAVAILABLE", "没有可用的模型"));
        }
        if (!models.some((model) => model.id === body.data.modelId)) {
          return reply.code(400).send(error("VALIDATION", "模型不在白名单中"));
        }
      }

      updateConversation(opts.db, conversation.id, {
        ...(body.data.title !== undefined
          ? { title: body.data.title.length > 0 ? body.data.title : null }
          : {}),
        ...(body.data.modelId !== undefined ? { modelId: body.data.modelId } : {}),
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
        position = runtime.enqueue({ runId: run.id, content });
      } catch (enqueueError) {
        request.log.error({ err: enqueueError, runId: run.id }, "failed to enqueue run");
        const message =
          enqueueError instanceof Error ? enqueueError.message : String(enqueueError);
        markRun(opts.db, run.id, {
          status: "error",
          error: message,
          endedAt: Date.now(),
        });
        try {
          const { seq, createdAt } = appendRunEvent(opts.db, {
            runId: run.id,
            conversationId: conversation.id,
            type: "run_end",
            payload: { status: "error", error: message },
          });
          opts.runtime.bus.publish({
            runId: run.id,
            conversationId: conversation.id,
            seq,
            createdAt,
            event: { type: "run_end", payload: { status: "error", error: message } },
          });
        } catch {
          // The run row already records the failure.
        }
        return reply.code(500).send(error("ENQUEUE_FAILED", "无法开始运行"));
      }

      return reply.code(202).send({ runId: run.id, position });
    },
  );
}
