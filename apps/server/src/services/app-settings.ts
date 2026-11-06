import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { listChatModels } from "../agent/model-runtime.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  deleteSetting,
  readSettingRows,
  upsertSetting,
} from "../db/repositories/settings.js";
import { SHARE_MAX_EXPIRES_IN_DAYS } from "./shares.js";

export const SETTING_KEYS = [
  "defaultModelId",
  "queryMaxRows",
  "queryPreviewRows",
  "queryTimeoutMs",
  "shareMaxDays",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export const settingValueSchemas = {
  defaultModelId: z.string().trim().min(1).max(200),
  queryMaxRows: z.number().int().min(1).max(100_000),
  queryPreviewRows: z.number().int().min(1).max(1_000),
  queryTimeoutMs: z.number().int().min(1_000).max(300_000),
  shareMaxDays: z.number().int().min(1).max(365),
} satisfies Record<SettingKey, z.ZodType<unknown>>;

/** Hard upper bounds applied to query limits, whatever their source (env or settings). */
export const QUERY_LIMIT_CAPS = {
  maxRows: 100_000,
  previewRows: 1_000,
  timeoutMs: 300_000,
} as const;

export interface QueryLimits {
  maxRows: number;
  previewRows: number;
  timeoutMs: number;
}

export interface AppSettings {
  defaultModelId: string | null;
  queryMaxRows: number;
  queryPreviewRows: number;
  queryTimeoutMs: number;
  shareMaxDays: number;
}

/** Values used when a key has never been saved (or was reset). */
export function defaultSettings(config: AppConfig): AppSettings {
  return {
    defaultModelId: null,
    queryMaxRows: config.queryMaxRows,
    queryPreviewRows: config.queryPreviewRows,
    queryTimeoutMs: config.queryTimeoutMs,
    shareMaxDays: SHARE_MAX_EXPIRES_IN_DAYS,
  };
}

function parseStored<T>(raw: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function clampLimit(value: number, max: number): number {
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

/**
 * Limits for one query run, read per run so admin changes apply without a restart.
 * Config/env defaults are clamped as well: env input is positive but unbounded.
 */
export function resolveQueryLimits(db: Db, config: AppConfig): QueryLimits {
  const stored = effectiveSettings(db, config);
  return {
    maxRows: clampLimit(stored.queryMaxRows, QUERY_LIMIT_CAPS.maxRows),
    previewRows: clampLimit(stored.queryPreviewRows, QUERY_LIMIT_CAPS.previewRows),
    timeoutMs: clampLimit(stored.queryTimeoutMs, QUERY_LIMIT_CAPS.timeoutMs),
  };
}

/**
 * Stored overrides merged over the config defaults. Invalid values (hand-edited DB,
 * a value that no longer fits its bounds) are ignored and fall back to the default.
 */
export function effectiveSettings(db: Db, config: AppConfig): AppSettings {
  const rows = readSettingRows(db);
  const defaults = defaultSettings(config);
  return {
    defaultModelId:
      parseStored(rows.get("defaultModelId"), settingValueSchemas.defaultModelId) ??
      defaults.defaultModelId,
    queryMaxRows:
      parseStored(rows.get("queryMaxRows"), settingValueSchemas.queryMaxRows) ??
      defaults.queryMaxRows,
    queryPreviewRows:
      parseStored(rows.get("queryPreviewRows"), settingValueSchemas.queryPreviewRows) ??
      defaults.queryPreviewRows,
    queryTimeoutMs:
      parseStored(rows.get("queryTimeoutMs"), settingValueSchemas.queryTimeoutMs) ??
      defaults.queryTimeoutMs,
    shareMaxDays:
      parseStored(rows.get("shareMaxDays"), settingValueSchemas.shareMaxDays) ??
      defaults.shareMaxDays,
  };
}

/** `null` removes the override so the key falls back to its default. */
export function saveSettings(
  db: Db,
  patch: Partial<Record<SettingKey, unknown | null>>,
): void {
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) {
      deleteSetting(db, key);
    } else {
      upsertSetting(db, key, JSON.stringify(value));
    }
  }
}

/**
 * The stored default model, but only when it is still whitelisted and the runtime is
 * configured; otherwise `null` so callers fall back to the first available model.
 */
export async function resolveDefaultModelId(input: {
  db: Db;
  config: AppConfig;
  getRuntime: () => Promise<ModelRuntime>;
}): Promise<string | null> {
  const stored = effectiveSettings(input.db, input.config).defaultModelId;
  if (!stored || !input.config.siliconflowApiKey) return null;
  try {
    const models = listChatModels(await input.getRuntime());
    return models.some((model) => model.id === stored) ? stored : null;
  } catch {
    return null;
  }
}
