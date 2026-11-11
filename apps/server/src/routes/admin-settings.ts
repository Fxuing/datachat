import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAgentModelRuntime,
  listChatModels,
  modelKey,
  resolveChatModel,
} from "../agent/model-runtime.js";

import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  effectiveSettings,
  resolveDefaultModelId,
  saveSettings,
  settingValueSchemas,
  type AppSettings,
  type SettingKey,
} from "../services/app-settings.js";
import { hasUsableProvider } from "../services/llm-catalog.js";
import { enabledProviderIds } from "../services/llm-catalog.js";

export interface AdminSettingsRouteOptions {
  db: Db;
  config: AppConfig;
  /** Test seam; production lazily creates the runtime on first whitelist check. */
  getRuntime?: () => Promise<ModelRuntime>;
}

/** `null` resets a key to its default, so the UI can offer “恢复默认”. */
const putBodySchema = z
  .object({
    defaultModelId: settingValueSchemas.defaultModelId.nullable().optional(),
    queryMaxRows: settingValueSchemas.queryMaxRows.nullable().optional(),
    queryPreviewRows: settingValueSchemas.queryPreviewRows.nullable().optional(),
    queryTimeoutMs: settingValueSchemas.queryTimeoutMs.nullable().optional(),
    shareMaxDays: settingValueSchemas.shareMaxDays.nullable().optional(),
    retentionConversationDays: settingValueSchemas.retentionConversationDays.nullable().optional(),
    retentionAuditDays: settingValueSchemas.retentionAuditDays.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "至少修改一项设置" });

function error(code: string, message: string) {
  return { error: { code, message } };
}

export async function adminSettingsRoutes(
  app: FastifyInstance,
  opts: AdminSettingsRouteOptions,
): Promise<void> {
  let runtimePromise: Promise<ModelRuntime> | undefined;
  const getRuntime =
    opts.getRuntime ??
    (() =>
      (runtimePromise = (runtimePromise ?? createAgentModelRuntime(opts.config)).catch(
        (runtimeError: unknown) => {
          runtimePromise = undefined;
          throw runtimeError;
        },
      )));

  const snapshot = async (): Promise<AppSettings> => ({
    ...effectiveSettings(opts.db, opts.config),
    defaultModelId: await resolveDefaultModelId({ db: opts.db, config: opts.config, getRuntime }),
  });

  app.get("/api/admin/settings", { preHandler: app.requireAdmin }, async () => ({
    settings: await snapshot(),
  }));

  app.put("/api/admin/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = putBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION", message: "参数不合法", details: parsed.error.flatten() },
      });
    }
    const patch = parsed.data;

    if (patch.defaultModelId !== undefined && patch.defaultModelId !== null) {
      if (!hasUsableProvider(opts.db, opts.config)) {
        return reply.code(400).send(error("VALIDATION", "未配置模型服务，无法设置默认模型"));
      }
      let models;
      try {
        models = listChatModels(
          await getRuntime(),
          enabledProviderIds(opts.db),
        );
      } catch {
        return reply.code(503).send(error("MODEL_RUNTIME_UNAVAILABLE", "模型服务不可用"));
      }
      const model = resolveChatModel(
        await getRuntime(),
        patch.defaultModelId,
        enabledProviderIds(opts.db),
      );
      if (!model) {
        return reply.code(400).send(error("VALIDATION", "模型不在白名单中"));
      }
      patch.defaultModelId = modelKey(model);
    }

    saveSettings(opts.db, patch as Partial<Record<SettingKey, unknown | null>>);
    return { settings: await snapshot() };
  });
}
