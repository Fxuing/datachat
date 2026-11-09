import fs from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { seedLegacyLlmProvider, syncModelCatalog } from "../services/llm-catalog.js";

/** Suggested default when it is present in the catalog. */
export const DEFAULT_MODEL_CANDIDATE = "deepseek-ai/DeepSeek-V3.2";

/** Separates provider id and model id in API-facing model keys. */
export const MODEL_KEY_SEPARATOR = "::";

export interface ChatModelInfo {
  /** `providerId::modelId`; what the UI sends back and conversations store. */
  id: string;
  modelId: string;
  providerId: string;
  providerName: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

/**
 * The pi-coding-agent root export does not re-export the pi-ai `Model` type, and
 * pi-ai is a transitive dependency (not directly resolvable under pnpm), so derive
 * the type from the runtime method that produces it.
 */
export type ChatModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** Raised when the catalog has no usable model at all (or the pinned id vanished). */
export class ModelUnavailableError extends Error {
  readonly code = "MODEL_RUNTIME_UNAVAILABLE";

  constructor(message = "没有可用的模型") {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/**
 * Builds the Pi model runtime from database-managed providers. Without a `db`
 * (tests, tooling) it falls back to the repo-level `agent/models.json`.
 */
export async function createAgentModelRuntime(
  config: AppConfig,
  db?: Db,
): Promise<ModelRuntime> {
  fs.mkdirSync(path.dirname(config.agentAuthPath), { recursive: true });
  if (!fs.existsSync(config.agentAuthPath)) {
    fs.writeFileSync(config.agentAuthPath, "{}\n", { mode: 0o600 });
  }
  let modelsPath = path.join(config.agentDir, "models.json");
  let keys: Map<string, string> | undefined;
  if (db) {
    seedLegacyLlmProvider(db, config);
    const catalog = syncModelCatalog(db, config);
    modelsPath = catalog.path;
    keys = catalog.keys;
  }
  const runtime = await ModelRuntime.create({
    authPath: config.agentAuthPath,
    modelsPath,
  });
  if (keys) {
    for (const [providerId, apiKey] of keys) {
      await runtime.setRuntimeApiKey(providerId, apiKey);
    }
  }
  return runtime;
}

/**
 * Per-app runtime cache. Provider edits call `invalidate()` so the next request
 * rebuilds the catalog; live conversations keep the model they already resolved.
 */
export class ModelRuntimeManager {
  private promise: Promise<ModelRuntime> | undefined;
  private version = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
  ) {}

  invalidate(): void {
    this.version += 1;
    this.promise = undefined;
  }

  get(): Promise<ModelRuntime> {
    if (!this.promise) {
      const version = this.version;
      this.promise = createAgentModelRuntime(this.config, this.db).catch((error: unknown) => {
        if (this.version === version) this.promise = undefined;
        throw error;
      });
    }
    return this.promise;
  }
}

/** Canonical API/conversation key for a resolved model. */
export function modelKey(model: ChatModel): string {
  return `${String(model.provider)}${MODEL_KEY_SEPARATOR}${model.id}`;
}

/** Chat models of the given providers, in catalog order. */
export function listChatModels(
  runtime: ModelRuntime,
  providerIds?: readonly string[],
): ChatModelInfo[] {
  const models = providerIds
    ? providerIds.flatMap((providerId) => runtime.getModels(providerId))
    : runtime.getModels();
  return models.map((model) => {
    const providerId = String(model.provider);
    return {
      id: `${providerId}${MODEL_KEY_SEPARATOR}${model.id}`,
      modelId: model.id,
      providerId,
      providerName: runtime.getProvider(providerId)?.name ?? providerId,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    };
  });
}

/** Resolves `providerId::modelId`, plus bare legacy ids within known providers. */
export function resolveChatModel(
  runtime: ModelRuntime,
  id: string,
  providerIds?: readonly string[],
): ChatModel | undefined {
  if (!id) return undefined;
  const separator = id.indexOf(MODEL_KEY_SEPARATOR);
  if (separator > 0) {
    return runtime.getModel(id.slice(0, separator), id.slice(separator + MODEL_KEY_SEPARATOR.length));
  }
  for (const providerId of providerIds ?? []) {
    const model = runtime.getModel(providerId, id);
    if (model) return model;
  }
  return undefined;
}

/**
 * Resolve the model a conversation should run with. A conversation without a pinned
 * model follows `GET /api/models` (first available model), so both paths agree.
 */
export function resolveConversationModel(
  runtime: ModelRuntime,
  modelId: string | null,
  providerIds?: readonly string[],
): ChatModel {
  const id = modelId ?? listChatModels(runtime, providerIds)[0]?.id;
  const model = id ? resolveChatModel(runtime, id, providerIds) : undefined;
  if (!model) throw new ModelUnavailableError(modelId ? `模型不可用：${modelId}` : undefined);
  return model;
}
