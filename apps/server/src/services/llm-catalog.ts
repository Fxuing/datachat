import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  insertLlmProvider,
  listLlmProviders,
  parseProviderModels,
  type LlmProviderModel,
  type LlmProviderRow,
  type LlmProtocol,
} from "../db/repositories/llm-providers.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../agent/datasource/crypto.js";

export const LLM_PROTOCOLS: LlmProtocol[] = ["openai-completions", "anthropic-messages"];

export function isLlmProtocol(value: unknown): value is LlmProtocol {
  return value === "openai-completions" || value === "anthropic-messages";
}

/** Per-protocol defaults for catalogs that only expose model ids. */
export function modelDefaults(protocol: LlmProtocol): { contextWindow: number; maxTokens: number } {
  return protocol === "anthropic-messages"
    ? { contextWindow: 200_000, maxTokens: 8_192 }
    : { contextWindow: 128_000, maxTokens: 8_192 };
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function positiveInt(...candidates: unknown[]): number | undefined {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (parsed > 0) return parsed;
    }
  }
  return undefined;
}

/** Reads a context window from the metadata shapes used by common providers. */
export function readContextWindow(record: Record<string, unknown>): number | undefined {
  const top = record.top_provider as Record<string, unknown> | undefined;
  const details = record.details as Record<string, unknown> | undefined;
  const meta = record.meta as Record<string, unknown> | undefined;
  return positiveInt(
    record.context_length,
    record.context_window,
    record.max_context_length,
    record.max_input_tokens,
    record.input_token_limit,
    record.max_model_len,
    top?.context_length,
    details?.context_length,
    meta?.n_ctx_train,
  );
}

function readMaxOutputTokens(record: Record<string, unknown>): number | undefined {
  const top = record.top_provider as Record<string, unknown> | undefined;
  return positiveInt(
    record.max_output_tokens,
    record.max_completion_tokens,
    record.max_tokens,
    top?.max_completion_tokens,
  );
}

/** Maps `/models` responses (OpenAI `data[].id`, Anthropic `data[].id/display_name`). */
export function normalizeFetchedModels(
  payload: unknown,
  protocol: LlmProtocol,
  existing: LlmProviderModel[] = [],
): LlmProviderModel[] {
  const defaults = modelDefaults(protocol);
  const previous = new Map(existing.map((model) => [model.id, model]));
  const data =
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : [];
  const seen = new Set<string>();
  const models: LlmProviderModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      (typeof record.display_name === "string" && record.display_name.trim()) ||
      (typeof record.name === "string" && record.name.trim()) ||
      id;
    const contextWindow =
      readContextWindow(record) ?? previous.get(id)?.contextWindow ?? defaults.contextWindow;
    const maxTokens = Math.min(
      readMaxOutputTokens(record) ?? previous.get(id)?.maxTokens ?? defaults.maxTokens,
      contextWindow,
    );
    models.push({ id, name, contextWindow, maxTokens });
  }
  return models;
}

function clampContextWindow(value: unknown, fallback: number): number {
  const parsed = positiveInt(value) ?? fallback;
  return Math.min(Math.max(parsed, 1_000), 10_000_000);
}

function clampMaxTokens(value: unknown, fallback: number): number {
  const parsed = positiveInt(value) ?? fallback;
  return Math.min(Math.max(parsed, 256), 10_000_000);
}

/** Accepts ids only (from the test dialog) or full model rows (from the editor). */
export function normalizeSelectedModels(
  input: unknown,
  protocol: LlmProtocol,
): LlmProviderModel[] {
  if (!Array.isArray(input)) return [];
  const defaults = modelDefaults(protocol);
  const out: LlmProviderModel[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const id =
      typeof item === "string"
        ? item.trim()
        : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? ((item as { id: string }).id ?? "").trim()
          : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    out.push({
      id,
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
      contextWindow: clampContextWindow(record.contextWindow, defaults.contextWindow),
      maxTokens: clampMaxTokens(record.maxTokens, defaults.maxTokens),
    });
  }
  return out;
}

export function maskApiKey(cipher: string, appSecret: string): string {
  try {
    const value = decryptSecret(cipher, deriveSecretKey(appSecret));
    if (!value) return "";
    return value.length <= 8 ? "••••" : `${value.slice(0, 3)}••••${value.slice(-4)}`;
  } catch {
    return "";
  }
}

export function decryptProviderKey(row: LlmProviderRow, appSecret: string): string {
  try {
    return decryptSecret(row.apiKeyCipher, deriveSecretKey(appSecret));
  } catch {
    return "";
  }
}

/** Seeds the legacy SiliconFlow config once so existing deployments keep working. */
export function seedLegacyLlmProvider(db: Db, config: AppConfig): void {
  if (listLlmProviders(db).length > 0) return;
  let legacy: unknown;
  try {
    legacy = JSON.parse(fs.readFileSync(path.join(config.agentDir, "models.json"), "utf8"));
  } catch {
    return;
  }
  const providers = (legacy as { providers?: Record<string, unknown> }).providers;
  if (!providers || typeof providers !== "object") return;
  const entry = Object.entries(providers)[0];
  if (!entry) return;
  const [legacyId, raw] = entry;
  const provider = (raw ?? {}) as Record<string, unknown>;
  const protocol = isLlmProtocol(provider.api) ? provider.api : "openai-completions";
  const models = normalizeSelectedModels(provider.models, protocol);
  if (models.length === 0) return;
  const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
  if (!baseUrl) return;
  insertLlmProvider(db, {
    id: legacyId.slice(0, 64) || "siliconflow",
    name: typeof provider.name === "string" && provider.name.trim() ? provider.name : legacyId,
    protocol,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKeyCipher: encryptSecret(config.siliconflowApiKey ?? "", deriveSecretKey(config.appSecret)),
    models,
    enabled: true,
    now: Date.now(),
  });
}

export interface ModelCatalog {
  path: string;
  /** provider id -> decrypted key (only providers that have one). */
  keys: Map<string, string>;
}

/**
 * Writes a Pi `models.json` from the database. Provider ids are opaque (uuid), so a
 * model key is `providerId::modelId` throughout the API and conversation rows.
 */
export function enabledProviderIds(db: Db): string[] {
  return listLlmProviders(db)
    .filter((provider) => provider.enabled === 1)
    .map((provider) => provider.id);
}

export function syncModelCatalog(db: Db, config: AppConfig): ModelCatalog {
  const providers = listLlmProviders(db).filter((provider) => provider.enabled === 1);
  const keys = new Map<string, string>();
  const catalog: {
    providers: Record<
      string,
      { name: string; baseUrl: string; api: LlmProtocol; models: unknown[] }
    >;
  } = { providers: {} };

  for (const provider of providers) {
    const models = parseProviderModels(provider);
    const key = decryptProviderKey(provider, config.appSecret);
    if (key) keys.set(provider.id, key);
    catalog.providers[provider.id] = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.protocol,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: false,
        input: ["text"],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    };
  }

  const target = path.join(config.dataDir, "agent", "models.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`);
  return { path: target, keys };
}

/** True when at least one enabled provider has a key and at least one model. */
export function hasUsableProvider(db: Db, config: AppConfig): boolean {
  return listLlmProviders(db).some(
    (provider) =>
      provider.enabled === 1 &&
      parseProviderModels(provider).length > 0 &&
      decryptProviderKey(provider, config.appSecret).length > 0,
  );
}
