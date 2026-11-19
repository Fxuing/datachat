import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db/client.js";
import { z } from "zod";
import { canAccessDatasource } from "../auth/access.js";
import {
  MemoryDuplicateError,
  MemoryValidationError,
  clearUserMemories,
  deleteUserMemory,
  findUserMemory,
  isGlobalMemoryEnabled,
  listUserMemories,
  supportsCoreMemory,
  updateUserMemory,
  upsertUserMemory,
  type MemoryKind,
} from "../db/repositories/user-memories.js";
import { getUserMemorySettings, setUserMemorySettings } from "../db/repositories/user-memories.js";
import { hasSensitiveMemory } from "../memory/secrets.js";

const kindSchema = z.enum(["profile", "instruction", "preference", "fact"]);
const scopeSchema = z.enum(["global", "datasource"]);

const createBodySchema = z.object({
  kind: kindSchema,
  title: z.string().min(1).max(60),
  content: z.string().min(1).max(1000),
  scope: scopeSchema.default("global"),
  datasourceId: z.string().min(1).optional(),
  core: z.boolean().optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});

const updateBodySchema = z.object({
  title: z.string().min(1).max(60).optional(),
  content: z.string().min(1).max(1000).optional(),
  core: z.boolean().optional(),
  enabled: z.boolean().optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});

function memoryPayload(row: ReturnType<typeof findUserMemory>) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    scope: row.datasourceId ? "datasource" : "global",
    datasourceId: row.datasourceId,
    core: row.core === 1,
    enabled: row.enabled === 1,
    confidence: row.confidence,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sendMemoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof MemoryValidationError) {
    return reply.code(400).send({ error: { code: "INVALID_MEMORY", message: error.message } });
  }
  if (error instanceof MemoryDuplicateError) {
    return reply.code(409).send({
      error: { code: "MEMORY_DUPLICATE", message: error.message, existingId: error.existingId },
    });
  }
  throw error;
}

export function memoryRoutes(app: FastifyInstance, opts: { db: Db }): void {
  const db = opts.db;
  app.get(
    "/api/memories",
    { preHandler: app.requirePermission("chat.use") },
    async (request) => {
      const query = z
        .object({
          q: z.string().max(100).optional(),
          kind: kindSchema.optional(),
          scope: scopeSchema.optional(),
          datasourceId: z.string().optional(),
        })
        .parse(request.query);
      const rows = listUserMemories(db, request.user!.sub, {
        query: query.q,
        kind: query.kind,
        scope: query.scope,
        datasourceId: query.datasourceId,
      });
      const settings = getUserMemorySettings(db, request.user!.sub);
      return {
        memories: rows.map((row) => memoryPayload(row)),
        settings: { enabled: settings.enabled },
        globalEnabled: isGlobalMemoryEnabled(db),
      };
    },
  );

  app.post(
    "/api/memories",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const body = createBodySchema.parse(request.body);
      if (body.scope === "datasource") {
        if (!body.datasourceId || !canAccessDatasource(request.access!, body.datasourceId)) {
          return reply.code(403).send({
            error: { code: "DATASOURCE_FORBIDDEN", message: "没有该数据源的访问权限" },
          });
        }
      }
      if (body.core === true && !supportsCoreMemory(body.kind)) {
        return reply.code(400).send({
          error: { code: "INVALID_MEMORY", message: "只有画像、固定指令或偏好可以设为核心记忆" },
        });
      }
      if (hasSensitiveMemory(`${body.title}\n${body.content}`)) {
        return reply.code(400).send({
          error: { code: "MEMORY_SECRET_DETECTED", message: "记忆内容包含疑似密钥或敏感信息" },
        });
      }
      try {
        const { memory, merged } = upsertUserMemory(db, {
          userId: request.user!.sub,
          kind: body.kind,
          title: body.title,
          content: body.content,
          scope: body.scope,
          datasourceId: body.scope === "datasource" ? body.datasourceId : null,
          core: body.core,
          confidence: body.confidence,
        });
        return reply.code(merged ? 200 : 201).send({ memory: memoryPayload(memory), merged });
      } catch (error) {
        return sendMemoryError(reply, error);
      }
    },
  );

  app.patch(
    "/api/memories/:id",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = updateBodySchema.parse(request.body);
      if (body.title || body.content) {
        const existing = findUserMemory(db, request.user!.sub, params.id);
        if (!existing) return reply.code(404).send({ error: { code: "MEMORY_NOT_FOUND", message: "记忆不存在" } });
        if (hasSensitiveMemory(`${body.title ?? existing.title}\n${body.content ?? existing.content}`)) {
          return reply.code(400).send({
            error: { code: "MEMORY_SECRET_DETECTED", message: "记忆内容包含疑似密钥或敏感信息" },
          });
        }
      }
      try {
        const row = updateUserMemory(db, request.user!.sub, params.id, body);
        if (!row) return reply.code(404).send({ error: { code: "MEMORY_NOT_FOUND", message: "记忆不存在" } });
        return { memory: memoryPayload(row) };
      } catch (error) {
        return sendMemoryError(reply, error);
      }
    },
  );

  app.delete(
    "/api/memories/:id",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      if (!deleteUserMemory(db, request.user!.sub, params.id)) {
        return reply.code(404).send({ error: { code: "MEMORY_NOT_FOUND", message: "记忆不存在" } });
      }
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/memories/clear",
    { preHandler: app.requirePermission("chat.use") },
    async (request) => ({ cleared: clearUserMemories(db, request.user!.sub) }),
  );

  app.get(
    "/api/memories/settings",
    { preHandler: app.requirePermission("chat.use") },
    async (request) => ({
      ...getUserMemorySettings(db, request.user!.sub),
      globalEnabled: isGlobalMemoryEnabled(db),
    }),
  );

  app.patch(
    "/api/memories/settings",
    { preHandler: app.requirePermission("chat.use") },
    async (request) => {
      const body = z.object({ enabled: z.boolean() }).parse(request.body);
      return setUserMemorySettings(db, request.user!.sub, body.enabled);
    },
  );
}
