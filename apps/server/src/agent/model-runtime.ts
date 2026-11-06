import fs from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";

/** DataChat only ever talks to its own provider; other Pi providers stay hidden. */
export const CHAT_PROVIDER_ID = "siliconflow";

/** Suggested default when it is present in the catalog. */
export const DEFAULT_MODEL_CANDIDATE = "deepseek-ai/DeepSeek-V3.2";

export interface ChatModelInfo {
  id: string;
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

/**
 * Builds the Pi model runtime from repo-level `agent/models.json`.
 *
 * The credential store lives under `dataDir/agent/auth.json`; Pi expects the file
 * (or its directory) to exist, so create an empty store on first use.
 */
export async function createAgentModelRuntime(config: AppConfig): Promise<ModelRuntime> {
  fs.mkdirSync(path.dirname(config.agentAuthPath), { recursive: true });
  if (!fs.existsSync(config.agentAuthPath)) {
    fs.writeFileSync(config.agentAuthPath, "{}\n", { mode: 0o600 });
  }
  return ModelRuntime.create({
    authPath: config.agentAuthPath,
    modelsPath: path.join(config.agentDir, "models.json"),
  });
}

/** Whitelisted chat models in `models.json` order. */
export function listChatModels(runtime: ModelRuntime): ChatModelInfo[] {
  return runtime.getModels(CHAT_PROVIDER_ID).map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

/** Resolves a whitelisted model id; unknown ids return undefined (route answers 400). */
export function resolveChatModel(runtime: ModelRuntime, id: string): ChatModel | undefined {
  return runtime.getModel(CHAT_PROVIDER_ID, id);
}
