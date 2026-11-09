import { eq } from "drizzle-orm";
import { llmProviders } from "../schema.js";
import type { Db } from "../client.js";

export type LlmProtocol = "openai-completions" | "anthropic-messages";

export interface LlmProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export interface LlmProviderRow {
  id: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKeyCipher: string;
  modelsJson: string;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

export interface LlmProviderInput {
  id: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKeyCipher: string;
  models: LlmProviderModel[];
  enabled: boolean;
  now: number;
}

export function listLlmProviders(db: Db): LlmProviderRow[] {
  return db.select().from(llmProviders).orderBy(llmProviders.createdAt).all();
}

export function getLlmProvider(db: Db, id: string): LlmProviderRow | undefined {
  return db.select().from(llmProviders).where(eq(llmProviders.id, id)).get();
}

export function findLlmProviderByName(db: Db, name: string): LlmProviderRow | undefined {
  return db.select().from(llmProviders).where(eq(llmProviders.name, name)).get();
}

export function insertLlmProvider(db: Db, input: LlmProviderInput): LlmProviderRow {
  db.insert(llmProviders)
    .values({
      id: input.id,
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      apiKeyCipher: input.apiKeyCipher,
      modelsJson: JSON.stringify(input.models),
      enabled: input.enabled ? 1 : 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run();
  return getLlmProvider(db, input.id)!;
}

export function updateLlmProvider(
  db: Db,
  id: string,
  patch: {
    name?: string;
    protocol?: LlmProtocol;
    baseUrl?: string;
    apiKeyCipher?: string;
    models?: LlmProviderModel[];
    enabled?: boolean;
    now: number;
  },
): LlmProviderRow | undefined {
  const values: Partial<typeof llmProviders.$inferInsert> = { updatedAt: patch.now };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.protocol !== undefined) values.protocol = patch.protocol;
  if (patch.baseUrl !== undefined) values.baseUrl = patch.baseUrl;
  if (patch.apiKeyCipher !== undefined) values.apiKeyCipher = patch.apiKeyCipher;
  if (patch.models !== undefined) values.modelsJson = JSON.stringify(patch.models);
  if (patch.enabled !== undefined) values.enabled = patch.enabled ? 1 : 0;
  db.update(llmProviders).set(values).where(eq(llmProviders.id, id)).run();
  return getLlmProvider(db, id);
}

export function deleteLlmProvider(db: Db, id: string): void {
  db.delete(llmProviders).where(eq(llmProviders.id, id)).run();
}

export function parseProviderModels(row: LlmProviderRow): LlmProviderModel[] {
  try {
    const parsed: unknown = JSON.parse(row.modelsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LlmProviderModel => {
      if (!item || typeof item !== "object") return false;
      const model = item as Record<string, unknown>;
      return typeof model.id === "string" && model.id.trim().length > 0;
    });
  } catch {
    return [];
  }
}
