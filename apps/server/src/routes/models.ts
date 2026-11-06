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

  app.get("/api/models", { preHandler: app.authenticate }, async (): Promise<ModelsResponse> => {
    // No key: report the missing configuration instead of failing the page with a 500.
    if (!opts.config.siliconflowApiKey) {
      return { configured: false, models: [], defaultId: null };
    }
    const runtime = await getRuntime();
    const models = listChatModels(runtime);
    // An admin-selected default wins while it is still whitelisted; otherwise fall
    // back to the first model, matching resolveConversationModel().
    const storedDefault = effectiveSettings(opts.db, opts.config).defaultModelId;
    const defaultId =
      storedDefault && models.some((model) => model.id === storedDefault)
        ? storedDefault
        : (models[0]?.id ?? null);
    return { configured: true, models, defaultId };
  });
}
