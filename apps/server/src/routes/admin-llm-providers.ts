import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  deleteLlmProvider,
  findLlmProviderByName,
  getLlmProvider,
  insertLlmProvider,
  listLlmProviders,
  parseProviderModels,
  updateLlmProvider,
  type LlmProviderModel,
  type LlmProviderRow,
  type LlmProtocol,
} from "../db/repositories/llm-providers.js";
import { deriveSecretKey, encryptSecret } from "../agent/datasource/crypto.js";
import type { ModelRuntimeManager } from "../agent/model-runtime.js";
import { effectiveSettings, saveSettings } from "../services/app-settings.js";
import {
  decryptProviderKey,
  maskApiKey,
  normalizeBaseUrl,
  normalizeFetchedModels,
  normalizeSelectedModels,
} from "../services/llm-catalog.js";

const protocolSchema = z.enum(["openai-completions", "anthropic-messages"]);
const modelInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  protocol: protocolSchema,
  baseUrl: z.string().trim().url().max(500),
  apiKey: z.string().trim().min(1).max(500),
  models: z.array(modelInputSchema).min(1).max(500),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  protocol: protocolSchema.optional(),
  baseUrl: z.string().trim().url().max(500).optional(),
  /** Omit or send "" to keep the stored key. */
  apiKey: z.string().trim().max(500).optional(),
  models: z.array(modelInputSchema).min(1).max(500).optional(),
  enabled: z.boolean().optional(),
});

const testSchema = z.object({
  protocol: protocolSchema,
  baseUrl: z.string().trim().url().max(500),
  apiKey: z.string().trim().max(500).optional(),
  /** Use the stored key of this provider when apiKey is empty. */
  providerId: z.string().trim().min(1).max(64).optional(),
});

export interface LlmProviderRoutesOptions {
  db: Db;
  config: AppConfig;
  manager: ModelRuntimeManager;
  fetchImpl?: typeof fetch;
}

export function toPublicProvider(row: LlmProviderRow, config: AppConfig) {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    enabled: row.enabled === 1,
    maskedKey: maskApiKey(row.apiKeyCipher, config.appSecret),
    models: parseProviderModels(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function modelsUrl(protocol: LlmProtocol, baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (protocol === "anthropic-messages") {
    return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

function authHeaders(protocol: LlmProtocol, apiKey: string): Record<string, string> {
  if (protocol === "anthropic-messages") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${apiKey}` };
}

/** Fetches `/models` for the test dialog and the refresh action. */
export async function fetchRemoteModels(input: {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Previously saved rows; their context sizes survive catalogs without metadata. */
  existing?: LlmProviderModel[];
}): Promise<LlmProviderModel[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(modelsUrl(input.protocol, input.baseUrl), {
    headers: { accept: "application/json", ...authHeaders(input.protocol, input.apiKey) },
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`上游返回 ${response.status}${body ? `：${body}` : ""}`);
  }
  const payload: unknown = await response.json();
  const models = normalizeFetchedModels(payload, input.protocol, input.existing ?? []);
  if (models.length === 0) throw new Error("上游没有返回任何模型");
  return models;
}

export async function llmProviderRoutes(
  app: FastifyInstance,
  opts: LlmProviderRoutesOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  app.get(
    "/api/admin/llm-providers",
    { preHandler: app.requirePermission("admin.settings") },
    async () => {
      const settings = effectiveSettings(opts.db, opts.config);
      return {
        providers: listLlmProviders(opts.db).map((row) => toPublicProvider(row, opts.config)),
        defaultModelId: settings.defaultModelId,
      };
    },
  );

  app.post(
    "/api/admin/llm-providers/test",
    { preHandler: app.requirePermission("admin.settings") },
    async (request, reply) => {
      const body = testSchema.parse(request.body);
      let apiKey = body.apiKey?.trim() ?? "";
      let existingModels: LlmProviderModel[] = [];
      if (body.providerId) {
        const stored = getLlmProvider(opts.db, body.providerId);
        if (!stored && !apiKey) {
          return reply
            .code(404)
            .send({ error: { code: "NOT_FOUND", message: "模型服务不存在" } });
        }
        if (stored) {
          existingModels = parseProviderModels(stored);
          if (!apiKey) apiKey = decryptProviderKey(stored, opts.config.appSecret);
        }
      }
      if (!apiKey) {
        return reply
          .code(400)
          .send({ error: { code: "API_KEY_REQUIRED", message: "请填写 API Key" } });
      }
      try {
        const models = await fetchRemoteModels({
          protocol: body.protocol,
          baseUrl: body.baseUrl,
          apiKey,
          fetchImpl,
          existing: existingModels,
        });
        return { models, count: models.length };
      } catch (error) {
        return reply.code(400).send({
          error: {
            code: "LLM_TEST_FAILED",
            message: error instanceof Error ? error.message : "测试失败",
          },
        });
      }
    },
  );

  app.post(
    "/api/admin/llm-providers",
    { preHandler: app.requirePermission("admin.settings") },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      if (findLlmProviderByName(opts.db, body.name)) {
        return reply
          .code(409)
          .send({ error: { code: "DUPLICATE_NAME", message: "模型服务名称已存在" } });
      }
      const now = Date.now();
      const row = insertLlmProvider(opts.db, {
        id: randomUUID(),
        name: body.name,
        protocol: body.protocol,
        baseUrl: normalizeBaseUrl(body.baseUrl),
        apiKeyCipher: encryptSecret(body.apiKey, deriveSecretKey(opts.config.appSecret)),
        models: normalizeSelectedModels(body.models, body.protocol),
        enabled: true,
        now,
      });
      opts.manager.invalidate();
      return reply.code(201).send({ provider: toPublicProvider(row, opts.config) });
    },
  );

  app.patch(
    "/api/admin/llm-providers/:id",
    { preHandler: app.requirePermission("admin.settings") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const existing = getLlmProvider(opts.db, id);
      if (!existing) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "模型服务不存在" } });
      }
      const body = updateSchema.parse(request.body);
      if (body.name && body.name !== existing.name && findLlmProviderByName(opts.db, body.name)) {
        return reply
          .code(409)
          .send({ error: { code: "DUPLICATE_NAME", message: "模型服务名称已存在" } });
      }
      const protocol = body.protocol ?? existing.protocol;
      const patch: Parameters<typeof updateLlmProvider>[2] = { now: Date.now() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.protocol !== undefined) patch.protocol = body.protocol;
      if (body.baseUrl !== undefined) patch.baseUrl = normalizeBaseUrl(body.baseUrl);
      if (body.apiKey) {
        patch.apiKeyCipher = encryptSecret(body.apiKey, deriveSecretKey(opts.config.appSecret));
      }
      if (body.models !== undefined) patch.models = normalizeSelectedModels(body.models, protocol);
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      const row = updateLlmProvider(opts.db, id, patch);
      opts.manager.invalidate();
      return { provider: toPublicProvider(row!, opts.config) };
    },
  );

  app.post(
    "/api/admin/llm-providers/:id/refresh",
    { preHandler: app.requirePermission("admin.settings") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const existing = getLlmProvider(opts.db, id);
      if (!existing) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "模型服务不存在" } });
      }
      const apiKey = decryptProviderKey(existing, opts.config.appSecret);
      if (!apiKey) {
        return reply
          .code(400)
          .send({ error: { code: "API_KEY_REQUIRED", message: "请先填写 API Key" } });
      }
      try {
        const models = await fetchRemoteModels({
          protocol: existing.protocol,
          baseUrl: existing.baseUrl,
          apiKey,
          fetchImpl,
          existing: parseProviderModels(existing),
        });
        const row = updateLlmProvider(opts.db, id, { models, now: Date.now() });
        opts.manager.invalidate();
        return { provider: toPublicProvider(row!, opts.config) };
      } catch (error) {
        return reply.code(400).send({
          error: {
            code: "LLM_TEST_FAILED",
            message: error instanceof Error ? error.message : "获取模型失败",
          },
        });
      }
    },
  );

  app.delete(
    "/api/admin/llm-providers/:id",
    { preHandler: app.requirePermission("admin.settings") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!getLlmProvider(opts.db, id)) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "模型服务不存在" } });
      }
      deleteLlmProvider(opts.db, id);
      const defaultId = effectiveSettings(opts.db, opts.config).defaultModelId;
      if (defaultId?.startsWith(`${id}::`)) {
        saveSettings(opts.db, { defaultModelId: null });
      }
      opts.manager.invalidate();
      return reply.code(204).send();
    },
  );
}
