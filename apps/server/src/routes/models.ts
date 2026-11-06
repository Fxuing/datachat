import type { FastifyInstance } from "fastify";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import {
  createAgentModelRuntime,
  listChatModels,
  type ChatModelInfo,
} from "../agent/model-runtime.js";

export interface ModelsRouteOptions {
  config: AppConfig;
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
    // The default is the first whitelisted model, matching the run-time fallback in
    // resolveConversationModel() so the selected model and the executed model agree.
    return { configured: true, models, defaultId: models[0]?.id ?? null };
  });
}
