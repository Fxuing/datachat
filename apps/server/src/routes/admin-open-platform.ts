import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { openAppScopeSchema, openEndUserSchema } from "@datachat/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { encryptSecret, deriveSecretKey } from "../agent/datasource/crypto.js";
import { findDatasource } from "../db/repositories/datasources.js";
import { findUserById } from "../db/repositories/users.js";
import { resolveUserAccess } from "../auth/access.js";
import {
  DuplicateOpenAppNameError,
  createOpenApiKey,
  createOpenApp,
  deleteOpenApp,
  findOpenApp,
  getOpenPlatformStats,
  listOpenApiAudit,
  listOpenApiKeys,
  listOpenApps,
  listWebhookDeliveries,
  parseAllowedDatasourceIds,
  parseOpenAppScopes,
  revokeOpenApiKey,
  toOpenApiKeySummary,
  toOpenAppSummary,
  updateOpenApp,
} from "../db/repositories/open-platform.js";
import {
  OpenPlatformAuthError,
  generateOpenApiKey,
  type OpenApiPrincipal,
} from "../services/open-platform-auth.js";
import type { OpenExecutionService } from "../services/open-platform-execution.js";
import { validateWebhookUrl, type OpenWebhookService } from "../services/open-platform-webhook.js";

export interface AdminOpenPlatformRouteOptions {
  db: Db;
  config: AppConfig;
  execution: OpenExecutionService;
  webhooks: OpenWebhookService;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const keyParamsSchema = z.object({ id: z.string().uuid(), keyId: z.string().uuid() });
const deliveryParamsSchema = z.object({ deliveryId: z.string().uuid() });

const createAppBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["active", "disabled"]).default("active"),
  serviceUserId: z.string().min(1).max(128),
  allowedDatasourceIds: z.array(z.string().uuid()).nullable().default(null),
  scopes: z.array(openAppScopeSchema).min(1).default(["ask", "report", "semantic", "mcp", "feedback"]),
  allowEndUserOverride: z.boolean().default(false),
  exposeSql: z.boolean().default(true),
  defaultModelId: z.string().trim().min(1).max(200).nullable().optional(),
  systemPromptExtra: z.string().trim().max(4_000).nullable().optional(),
  rateLimitRpm: z.number().int().min(1).max(10_000).default(60),
  maxRowsOverride: z.number().int().min(1).max(100_000).nullable().optional(),
  timeoutMsOverride: z.number().int().min(1_000).max(600_000).nullable().optional(),
  webhookUrl: z.string().trim().max(1_000).nullable().optional(),
  webhookSecret: z.string().trim().min(8).max(256).nullable().optional(),
});

const updateAppBodySchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  serviceUserId: z.string().min(1).max(128).optional(),
  allowedDatasourceIds: z.array(z.string().uuid()).nullable().optional(),
  scopes: z.array(openAppScopeSchema).min(1).optional(),
  allowEndUserOverride: z.boolean().optional(),
  exposeSql: z.boolean().optional(),
  defaultModelId: z.string().trim().min(1).max(200).nullable().optional(),
  systemPromptExtra: z.string().trim().max(4_000).nullable().optional(),
  rateLimitRpm: z.number().int().min(1).max(10_000).optional(),
  maxRowsOverride: z.number().int().min(1).max(100_000).nullable().optional(),
  timeoutMsOverride: z.number().int().min(1_000).max(600_000).nullable().optional(),
  webhookUrl: z.string().trim().max(1_000).nullable().optional(),
  /** Pass null/empty string to clear secret, non-empty string (>=8 chars) to replace, omit to keep. */
  webhookSecret: z.string().trim().max(256).nullable().optional(),
});

const createKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  expiresInDays: z.number().int().min(1).max(3_650).nullable().optional(),
});

const auditQuerySchema = z.object({
  appId: z.string().uuid().optional(),
  status: z.enum(["ok", "error", "rejected", "rate_limited"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  days: z.coerce.number().int().min(1).max(90).optional(),
});

const webhookQuerySchema = z.object({
  appId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const playgroundBodySchema = z.object({
  action: z.enum(["ask", "report"]).default("ask"),
  datasourceId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(8_000),
  title: z.string().trim().min(1).max(120).optional(),
  sections: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  endUser: openEndUserSchema.optional(),
});

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export async function adminOpenPlatformRoutes(
  app: FastifyInstance,
  opts: AdminOpenPlatformRouteOptions,
): Promise<void> {
  const guard = app.requirePermission("admin.open_platform");

  function toSummary(row: NonNullable<ReturnType<typeof findOpenApp>>) {
    const user = findUserById(opts.db, row.serviceUserId);
    const now = Date.now();
    const activeKeyCount = listOpenApiKeys(opts.db, row.id).filter(
      (k) => k.revokedAt === null && (k.expiresAt === null || k.expiresAt > now),
    ).length;
    return toOpenAppSummary(row, {
      serviceUsername: user?.username ?? "unknown",
      serviceUserDisplayName: user?.displayName ?? null,
      activeKeyCount,
    });
  }

  app.get("/api/admin/open-platform/apps", { preHandler: guard }, async () => {
    return { items: listOpenApps(opts.db) };
  });

  app.post("/api/admin/open-platform/apps", { preHandler: guard }, async (request, reply) => {
    const body = createAppBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(errorBody("VALIDATION", "应用配置参数不合法", body.error.flatten()));
    }

    const serviceUser = findUserById(opts.db, body.data.serviceUserId);
    if (!serviceUser || serviceUser.status !== "active") {
      return reply.code(400).send(errorBody("INVALID_SERVICE_USER", "绑定的服务账号不存在或已禁用"));
    }

    if (body.data.allowedDatasourceIds) {
      for (const dsId of body.data.allowedDatasourceIds) {
        if (!findDatasource(opts.db, dsId)) {
          return reply.code(400).send(errorBody("INVALID_DATASOURCE", `数据源 ${dsId} 不存在`));
        }
      }
    }

    const webhookUrl = body.data.webhookUrl?.trim() || null;
    if (webhookUrl) {
      const urlErr = validateWebhookUrl(webhookUrl);
      if (urlErr) return reply.code(400).send(errorBody("INVALID_WEBHOOK_URL", urlErr));
    }

    let webhookSecretCipher: string | null = null;
    if (body.data.webhookSecret) {
      webhookSecretCipher = encryptSecret(
        body.data.webhookSecret,
        deriveSecretKey(opts.config.appSecret),
      );
    }

    try {
      const created = createOpenApp(opts.db, {
        name: body.data.name,
        description: body.data.description ?? null,
        status: body.data.status,
        serviceUserId: serviceUser.id,
        allowedDatasourceIds: body.data.allowedDatasourceIds,
        scopes: [...new Set(body.data.scopes)],
        allowEndUserOverride: body.data.allowEndUserOverride,
        exposeSql: body.data.exposeSql,
        defaultModelId: body.data.defaultModelId ?? null,
        systemPromptExtra: body.data.systemPromptExtra ?? null,
        rateLimitRpm: body.data.rateLimitRpm,
        maxRowsOverride: body.data.maxRowsOverride ?? null,
        timeoutMsOverride: body.data.timeoutMsOverride ?? null,
        webhookUrl,
        webhookSecretCipher,
        createdBy: request.user!.sub,
      });
      return reply.code(201).send({ app: toSummary(created) });
    } catch (error) {
      if (error instanceof DuplicateOpenAppNameError) {
        return reply.code(409).send(errorBody("DUPLICATE_NAME", error.message));
      }
      throw error;
    }
  });

  app.patch("/api/admin/open-platform/apps/:id", { preHandler: guard }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = updateAppBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
    }

    const existing = findOpenApp(opts.db, params.data.id);
    if (!existing) {
      return reply.code(404).send(errorBody("NOT_FOUND", "开放应用不存在"));
    }

    if (body.data.serviceUserId !== undefined) {
      const serviceUser = findUserById(opts.db, body.data.serviceUserId);
      if (!serviceUser || serviceUser.status !== "active") {
        return reply.code(400).send(errorBody("INVALID_SERVICE_USER", "绑定的服务账号不存在或已禁用"));
      }
    }

    if (body.data.allowedDatasourceIds) {
      for (const dsId of body.data.allowedDatasourceIds) {
        if (!findDatasource(opts.db, dsId)) {
          return reply.code(400).send(errorBody("INVALID_DATASOURCE", `数据源 ${dsId} 不存在`));
        }
      }
    }

    let normalizedWebhookUrl: string | null | undefined;
    if (body.data.webhookUrl !== undefined) {
      normalizedWebhookUrl = body.data.webhookUrl?.trim() || null;
      if (normalizedWebhookUrl) {
        const urlErr = validateWebhookUrl(normalizedWebhookUrl);
        if (urlErr) return reply.code(400).send(errorBody("INVALID_WEBHOOK_URL", urlErr));
      }
    }

    let webhookSecretCipher: string | null | undefined;
    if (body.data.webhookSecret !== undefined) {
      if (body.data.webhookSecret === null || body.data.webhookSecret === "") {
        webhookSecretCipher = null;
      } else if (body.data.webhookSecret.length < 8) {
        return reply.code(400).send(errorBody("VALIDATION", "Webhook 密钥至少需要 8 个字符"));
      } else {
        webhookSecretCipher = encryptSecret(
          body.data.webhookSecret,
          deriveSecretKey(opts.config.appSecret),
        );
      }
    }

    try {
      const updated = updateOpenApp(opts.db, params.data.id, {
        ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        ...(body.data.description !== undefined ? { description: body.data.description } : {}),
        ...(body.data.status !== undefined ? { status: body.data.status } : {}),
        ...(body.data.serviceUserId !== undefined ? { serviceUserId: body.data.serviceUserId } : {}),
        ...(body.data.allowedDatasourceIds !== undefined
          ? { allowedDatasourceIds: body.data.allowedDatasourceIds }
          : {}),
        ...(body.data.scopes !== undefined ? { scopes: [...new Set(body.data.scopes)] } : {}),
        ...(body.data.allowEndUserOverride !== undefined
          ? { allowEndUserOverride: body.data.allowEndUserOverride }
          : {}),
        ...(body.data.exposeSql !== undefined ? { exposeSql: body.data.exposeSql } : {}),
        ...(body.data.defaultModelId !== undefined
          ? { defaultModelId: body.data.defaultModelId }
          : {}),
        ...(body.data.systemPromptExtra !== undefined
          ? { systemPromptExtra: body.data.systemPromptExtra }
          : {}),
        ...(body.data.rateLimitRpm !== undefined ? { rateLimitRpm: body.data.rateLimitRpm } : {}),
        ...(body.data.maxRowsOverride !== undefined
          ? { maxRowsOverride: body.data.maxRowsOverride }
          : {}),
        ...(body.data.timeoutMsOverride !== undefined
          ? { timeoutMsOverride: body.data.timeoutMsOverride }
          : {}),
        ...(normalizedWebhookUrl !== undefined ? { webhookUrl: normalizedWebhookUrl } : {}),
        ...(webhookSecretCipher !== undefined ? { webhookSecretCipher } : {}),
      });
      if (!updated) {
        return reply.code(404).send(errorBody("NOT_FOUND", "开放应用不存在"));
      }
      return { app: toSummary(updated) };
    } catch (error) {
      if (error instanceof DuplicateOpenAppNameError) {
        return reply.code(409).send(errorBody("DUPLICATE_NAME", error.message));
      }
      throw error;
    }
  });

  app.delete("/api/admin/open-platform/apps/:id", { preHandler: guard }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
    }
    const deleted = deleteOpenApp(opts.db, params.data.id);
    if (!deleted) {
      return reply.code(404).send(errorBody("NOT_FOUND", "开放应用不存在"));
    }
    return reply.code(204).send();
  });

  app.get("/api/admin/open-platform/apps/:id/keys", { preHandler: guard }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
    }
    if (!findOpenApp(opts.db, params.data.id)) {
      return reply.code(404).send(errorBody("NOT_FOUND", "开放应用不存在"));
    }
    return { items: listOpenApiKeys(opts.db, params.data.id) };
  });

  app.post("/api/admin/open-platform/apps/:id/keys", { preHandler: guard }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = createKeyBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
    }
    if (!findOpenApp(opts.db, params.data.id)) {
      return reply.code(404).send(errorBody("NOT_FOUND", "开放应用不存在"));
    }

    const generated = generateOpenApiKey();
    const expiresAt = body.data.expiresInDays
      ? Date.now() + body.data.expiresInDays * 24 * 60 * 60 * 1000
      : null;

    const row = createOpenApiKey(opts.db, {
      appId: params.data.id,
      name: body.data.name,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      expiresAt,
      createdBy: request.user!.sub,
    });

    // Raw API key is returned strictly once at creation and never persisted in plaintext.
    return reply.code(201).send({
      key: toOpenApiKeySummary(row),
      rawKey: generated.rawKey,
    });
  });

  app.post(
    "/api/admin/open-platform/apps/:id/keys/:keyId/revoke",
    { preHandler: guard },
    async (request, reply) => {
      const params = keyParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const revoked = revokeOpenApiKey(opts.db, params.data.id, params.data.keyId);
      if (!revoked) {
        return reply.code(404).send(errorBody("NOT_FOUND", "API Key 不存在或已吊销"));
      }
      return { key: toOpenApiKeySummary(revoked) };
    },
  );

  app.get("/api/admin/open-platform/audit", { preHandler: guard }, async (request, reply) => {
    const query = auditQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(errorBody("VALIDATION", "筛选参数不合法"));
    }
    const items = listOpenApiAudit(opts.db, {
      appId: query.data.appId,
      status: query.data.status,
      limit: query.data.limit,
    });
    const stats = getOpenPlatformStats(opts.db, {
      appId: query.data.appId,
      days: query.data.days,
    });
    return { items, stats };
  });

  app.get("/api/admin/open-platform/webhooks", { preHandler: guard }, async (request, reply) => {
    const query = webhookQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(errorBody("VALIDATION", "筛选参数不合法"));
    }
    return {
      items: listWebhookDeliveries(opts.db, {
        appId: query.data.appId,
        limit: query.data.limit,
      }),
    };
  });

  app.post(
    "/api/admin/open-platform/webhooks/:deliveryId/replay",
    { preHandler: guard },
    async (request, reply) => {
      const params = deliveryParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      try {
        const delivery = await opts.webhooks.replay(params.data.deliveryId);
        return {
          delivery: {
            id: delivery.id,
            appId: delivery.appId,
            event: delivery.event,
            targetUrl: delivery.targetUrl,
            status: delivery.status,
            attempts: delivery.attempts,
            httpStatus: delivery.httpStatus,
            responseSnippet: delivery.responseSnippet,
            error: delivery.error,
            createdAt: delivery.createdAt,
            lastAttemptAt: delivery.lastAttemptAt,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "重放失败";
        return reply.code(404).send(errorBody("NOT_FOUND", message));
      }
    },
  );

  // Admin Playground: executes an app's Ask or Report flow with optional simulated endUser
  // through the exact same guarded OpenExecutionService + RLS pipeline.
  app.post(
    "/api/admin/open-platform/apps/:id/playground",
    { preHandler: guard },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = playgroundBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "调试参数不合法"));
      }

      const openApp = findOpenApp(opts.db, params.data.id);
      if (!openApp) {
        return reply.code(404).send(errorBody("NOT_FOUND", "开放应用不存在"));
      }
      if (openApp.status !== "active") {
        return reply.code(403).send(errorBody("APP_DISABLED", "开放应用已停用"));
      }
      const serviceUser = findUserById(opts.db, openApp.serviceUserId);
      if (!serviceUser || serviceUser.status !== "active") {
        return reply.code(403).send(errorBody("SERVICE_USER_DISABLED", "应用绑定的服务账号不可用"));
      }

      const allowedList = parseAllowedDatasourceIds(openApp.allowedDatasourceIdsJson);
      const principal: OpenApiPrincipal = {
        app: openApp,
        key: {
          id: "playground",
          appId: openApp.id,
          name: "Admin Playground",
          keyPrefix: "playground",
          keyHash: "",
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          createdBy: request.user!.sub,
          createdAt: Date.now(),
        },
        scopes: new Set(parseOpenAppScopes(openApp.scopesJson)),
        allowedDatasourceIds: allowedList === null ? null : new Set(allowedList),
        serviceUser,
        serviceAccess: resolveUserAccess(opts.db, serviceUser),
      };

      try {
        if (body.data.action === "report") {
          if (!principal.scopes.has("report")) {
            return reply.code(403).send(errorBody("SCOPE_DENIED", "当前应用未开通「report」能力权限"));
          }
          const { result } = await opts.execution.generateReport({
            principal,
            datasourceId: body.data.datasourceId,
            prompt: body.data.prompt,
            title: body.data.title,
            sections: body.data.sections,
            mode: "sync",
            endUser: body.data.endUser,
            endpoint: "Playground report",
          });
          return { action: "report", result };
        }

        if (!principal.scopes.has("ask")) {
          return reply.code(403).send(errorBody("SCOPE_DENIED", "当前应用未开通「ask」能力权限"));
        }
        const { result } = await opts.execution.ask({
          principal,
          datasourceId: body.data.datasourceId,
          question: body.data.prompt,
          mode: "sync",
          endUser: body.data.endUser,
          endpoint: "Playground ask",
        });
        return { action: "ask", result };
      } catch (error) {
        if (error instanceof OpenPlatformAuthError) {
          return reply.code(error.httpStatus).send(errorBody(error.code, error.message));
        }
        const message = error instanceof Error ? error.message : "调试执行失败";
        return reply.code(500).send(errorBody("PLAYGROUND_FAILED", message));
      }
    },
  );
}
