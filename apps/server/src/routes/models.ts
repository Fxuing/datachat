import type { FastifyInstance } from "fastify";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import {
  createAgentModelRuntime,
  DEFAULT_MODEL_CANDIDATE,
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
    opts.getRuntime ?? (() => (runtimePromise ??= createAgentModelRuntime(opts.config)));

  app.get("/api/models", { preHandler: app.authenticate }, async (): Promise<ModelsResponse> => {
    // No key: report the missing configuration instead of failing the page with a 500.
    if (!opts.config.siliconflowApiKey) {
      return { configured: false, models: [], defaultId: null };
    }
    const runtime = await getRuntime();
    const models = listChatModels(runtime);
    const defaultId =
      models.find((model) => model.id === DEFAULT_MODEL_CANDIDATE)?.id ?? models[0]?.id ?? null;
    return { configured: true, models, defaultId };
  });
}
