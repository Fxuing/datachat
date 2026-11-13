import type { FastifyInstance } from "fastify";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import {
  createAgentModelRuntime,
  listChatModels,
  type ChatModelInfo,
} from "../agent/model-runtime.js";
import type { Db } from "../db/client.js";
import { effectiveSettings } from "../services/app-settings.js";
import { hasUsableProvider } from "../services/llm-catalog.js";
import { enabledProviderIds } from "../services/llm-catalog.js";


export interface ModelsRouteOptions {
  config: AppConfig;
  db: Db;
  /** Test seam; production lazily creates the runtime on first request. */
  getRuntime?: () => Promise<ModelRuntime>;
}

export interface ModelsResponse {
  configured: boolean;
  models: ChatModelInfo[];
  defaultId: string | null;
}

export async function modelsRoutes(
  app: FastifyInstance,
  opts: ModelsRouteOptions,
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

  app.get("/api/models", { preHandler: app.requirePermission("chat.use") }, async (): Promise<ModelsResponse> => {
    // No usable provider yet: report it instead of failing the page with a 500.
    if (!hasUsableProvider(opts.db, opts.config)) {
      return { configured: false, models: [], defaultId: null };
    }
    const runtime = await getRuntime();
    const models = listChatModels(
      runtime,
      enabledProviderIds(opts.db),
    );
    // An admin-selected default wins while it is still whitelisted; otherwise fall
    // back to the first model, matching resolveConversationModel().
    const storedDefault = effectiveSettings(opts.db, opts.config).defaultModelId;
    const defaultId =
      storedDefault && models.some((model) => model.id === storedDefault)
        ? storedDefault
        : (models[0]?.id ?? null);
    return { configured: models.length > 0, models, defaultId };
  });
}
