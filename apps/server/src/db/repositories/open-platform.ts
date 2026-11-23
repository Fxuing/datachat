import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  OPEN_APP_SCOPES,
  type OpenApiAuditEntry,
  type OpenApiKeySummary,
  type OpenAppScope,
  type OpenAppSummary,
  type OpenPlatformStats,
  type OpenWebhookDeliverySummary,
} from "@datachat/shared";
import type { Db } from "../client.js";
import {
  openApiAudit,
  openApiKeys,
  openApps,
  openAppSessions,
  openWebhookDeliveries,
  users,
} from "../schema.js";

export type OpenAppRow = typeof openApps.$inferSelect;
export type OpenApiKeyRow = typeof openApiKeys.$inferSelect;
export type OpenAppSessionRow = typeof openAppSessions.$inferSelect;
export type OpenApiAuditRow = typeof openApiAudit.$inferSelect;
export type OpenWebhookDeliveryRow = typeof openWebhookDeliveries.$inferSelect;

export class DuplicateOpenAppNameError extends Error {
  constructor(name: string) {
    super(`应用名称「${name}」已存在`);
    this.name = "DuplicateOpenAppNameError";
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT_UNIQUE")) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

const VALID_SCOPES = new Set<string>(OPEN_APP_SCOPES);

export function parseOpenAppScopes(raw: string): OpenAppScope[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is OpenAppScope => typeof item === "string" && VALID_SCOPES.has(item));
  } catch {
    return [];
  }
}

export function parseAllowedDatasourceIds(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

export function toOpenAppSummary(
  row: OpenAppRow,
  meta: {
    serviceUsername: string;
    serviceUserDisplayName: string | null;
    activeKeyCount: number;
  },
): OpenAppSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    serviceUserId: row.serviceUserId,
    serviceUsername: meta.serviceUsername,
    serviceUserDisplayName: meta.serviceUserDisplayName,
    allowedDatasourceIds: parseAllowedDatasourceIds(row.allowedDatasourceIdsJson),
    scopes: parseOpenAppScopes(row.scopesJson),
    allowEndUserOverride: row.allowEndUserOverride === 1,
    exposeSql: row.exposeSql === 1,
    defaultModelId: row.defaultModelId,
    systemPromptExtra: row.systemPromptExtra,
    rateLimitRpm: row.rateLimitRpm,
    maxRowsOverride: row.maxRowsOverride,
    timeoutMsOverride: row.timeoutMsOverride,
    webhookUrl: row.webhookUrl,
    hasWebhookSecret: Boolean(row.webhookSecretCipher),
    activeKeyCount: meta.activeKeyCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateOpenAppInput {
  id?: string;
  name: string;
  description?: string | null;
  status?: "active" | "disabled";
  serviceUserId: string;
  allowedDatasourceIds: string[] | null;
  scopes: OpenAppScope[];
  allowEndUserOverride?: boolean;
  exposeSql?: boolean;
  defaultModelId?: string | null;
  systemPromptExtra?: string | null;
  rateLimitRpm?: number;
  maxRowsOverride?: number | null;
  timeoutMsOverride?: number | null;
  webhookUrl?: string | null;
  webhookSecretCipher?: string | null;
  createdBy: string;
}

export function createOpenApp(db: Db, input: CreateOpenAppInput): OpenAppRow {
  const now = Date.now();
  try {
    return db
      .insert(openApps)
      .values({
        id: input.id ?? randomUUID(),
        name: input.name.trim(),
        description: input.description ?? null,
        status: input.status ?? "active",
        serviceUserId: input.serviceUserId,
        allowedDatasourceIdsJson:
          input.allowedDatasourceIds === null ? null : JSON.stringify(input.allowedDatasourceIds),
        scopesJson: JSON.stringify(input.scopes),
        allowEndUserOverride: input.allowEndUserOverride ? 1 : 0,
        exposeSql: input.exposeSql === false ? 0 : 1,
        defaultModelId: input.defaultModelId ?? null,
        systemPromptExtra: input.systemPromptExtra ?? null,
        rateLimitRpm: input.rateLimitRpm ?? 60,
        maxRowsOverride: input.maxRowsOverride ?? null,
        timeoutMsOverride: input.timeoutMsOverride ?? null,
        webhookUrl: input.webhookUrl ?? null,
        webhookSecretCipher: input.webhookSecretCipher ?? null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new DuplicateOpenAppNameError(input.name.trim());
    }
    throw error;
  }
}

export function findOpenApp(db: Db, id: string): OpenAppRow | undefined {
  return db.select().from(openApps).where(eq(openApps.id, id)).get();
}

export function listOpenApps(db: Db): OpenAppSummary[] {
  const rows = db
    .select({
      app: openApps,
      serviceUsername: users.username,
      serviceUserDisplayName: users.displayName,
    })
    .from(openApps)
    .leftJoin(users, eq(openApps.serviceUserId, users.id))
    .orderBy(desc(openApps.createdAt))
    .all();

  const keyCounts = new Map<string, number>();
  const now = Date.now();
  const keys = db.select().from(openApiKeys).where(isNull(openApiKeys.revokedAt)).all();
  for (const key of keys) {
    if (key.expiresAt !== null && key.expiresAt <= now) continue;
    keyCounts.set(key.appId, (keyCounts.get(key.appId) ?? 0) + 1);
  }

  return rows.map((row) =>
    toOpenAppSummary(row.app, {
      serviceUsername: row.serviceUsername ?? "unknown",
      serviceUserDisplayName: row.serviceUserDisplayName ?? null,
      activeKeyCount: keyCounts.get(row.app.id) ?? 0,
    }),
  );
}

export interface UpdateOpenAppPatch {
  name?: string;
  description?: string | null;
  status?: "active" | "disabled";
  serviceUserId?: string;
  allowedDatasourceIds?: string[] | null;
  scopes?: OpenAppScope[];
  allowEndUserOverride?: boolean;
  exposeSql?: boolean;
  defaultModelId?: string | null;
  systemPromptExtra?: string | null;
  rateLimitRpm?: number;
  maxRowsOverride?: number | null;
  timeoutMsOverride?: number | null;
  webhookUrl?: string | null;
  webhookSecretCipher?: string | null;
}

export function updateOpenApp(db: Db, id: string, patch: UpdateOpenAppPatch): OpenAppRow | undefined {
  const values: Partial<typeof openApps.$inferInsert> = { updatedAt: Date.now() };
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.serviceUserId !== undefined) values.serviceUserId = patch.serviceUserId;
  if (patch.allowedDatasourceIds !== undefined) {
    values.allowedDatasourceIdsJson =
      patch.allowedDatasourceIds === null ? null : JSON.stringify(patch.allowedDatasourceIds);
  }
  if (patch.scopes !== undefined) values.scopesJson = JSON.stringify(patch.scopes);
  if (patch.allowEndUserOverride !== undefined) {
    values.allowEndUserOverride = patch.allowEndUserOverride ? 1 : 0;
  }
  if (patch.exposeSql !== undefined) values.exposeSql = patch.exposeSql ? 1 : 0;
  if (patch.defaultModelId !== undefined) values.defaultModelId = patch.defaultModelId;
  if (patch.systemPromptExtra !== undefined) values.systemPromptExtra = patch.systemPromptExtra;
  if (patch.rateLimitRpm !== undefined) values.rateLimitRpm = patch.rateLimitRpm;
  if (patch.maxRowsOverride !== undefined) values.maxRowsOverride = patch.maxRowsOverride;
  if (patch.timeoutMsOverride !== undefined) values.timeoutMsOverride = patch.timeoutMsOverride;
  if (patch.webhookUrl !== undefined) values.webhookUrl = patch.webhookUrl;
  if (patch.webhookSecretCipher !== undefined) values.webhookSecretCipher = patch.webhookSecretCipher;

  try {
    return db.update(openApps).set(values).where(eq(openApps.id, id)).returning().get();
  } catch (error) {
    if (isUniqueConstraintError(error) && patch.name) {
      throw new DuplicateOpenAppNameError(patch.name.trim());
    }
    throw error;
  }
}

export function deleteOpenApp(db: Db, id: string): boolean {
  const deleted = db.delete(openApps).where(eq(openApps.id, id)).returning({ id: openApps.id }).get();
  return Boolean(deleted);
}

export function toOpenApiKeySummary(row: OpenApiKeyRow): OpenApiKeySummary {
  return {
    id: row.id,
    appId: row.appId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export function createOpenApiKey(
  db: Db,
  input: {
    appId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    expiresAt?: number | null;
    createdBy: string;
  },
): OpenApiKeyRow {
  return db
    .insert(openApiKeys)
    .values({
      id: randomUUID(),
      appId: input.appId,
      name: input.name.trim(),
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      lastUsedAt: null,
      createdBy: input.createdBy,
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

export function listOpenApiKeys(db: Db, appId: string): OpenApiKeySummary[] {
  return db
    .select()
    .from(openApiKeys)
    .where(eq(openApiKeys.appId, appId))
    .orderBy(desc(openApiKeys.createdAt))
    .all()
    .map(toOpenApiKeySummary);
}

export function findOpenApiKeyByHash(db: Db, keyHash: string): OpenApiKeyRow | undefined {
  return db.select().from(openApiKeys).where(eq(openApiKeys.keyHash, keyHash)).get();
}

export function revokeOpenApiKey(db: Db, appId: string, keyId: string): OpenApiKeyRow | undefined {
  return db
    .update(openApiKeys)
    .set({ revokedAt: Date.now() })
    .where(and(eq(openApiKeys.id, keyId), eq(openApiKeys.appId, appId), isNull(openApiKeys.revokedAt)))
    .returning()
    .get();
}

export function touchOpenApiKeyLastUsed(db: Db, keyId: string, at = Date.now()): void {
  db.update(openApiKeys).set({ lastUsedAt: at }).where(eq(openApiKeys.id, keyId)).run();
}

export function createOpenAppSession(
  db: Db,
  input: {
    appId: string;
    conversationId: string;
    datasourceId: string;
    externalSessionId?: string | null;
    externalUserId?: string | null;
    effectiveUserId: string;
    scopeDepartmentIds?: string[] | null;
  },
): OpenAppSessionRow {
  const now = Date.now();
  return db
    .insert(openAppSessions)
    .values({
      id: randomUUID(),
      appId: input.appId,
      conversationId: input.conversationId,
      datasourceId: input.datasourceId,
      externalSessionId: input.externalSessionId ?? null,
      externalUserId: input.externalUserId ?? null,
      effectiveUserId: input.effectiveUserId,
      scopeDepartmentIdsJson:
        input.scopeDepartmentIds ? JSON.stringify(input.scopeDepartmentIds) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function findOpenAppSessionByConversation(
  db: Db,
  appId: string,
  conversationId: string,
): OpenAppSessionRow | undefined {
  return db
    .select()
    .from(openAppSessions)
    .where(and(eq(openAppSessions.appId, appId), eq(openAppSessions.conversationId, conversationId)))
    .get();
}

export function findOpenAppSessionByExternalId(
  db: Db,
  appId: string,
  externalSessionId: string,
): OpenAppSessionRow | undefined {
  return db
    .select()
    .from(openAppSessions)
    .where(
      and(
        eq(openAppSessions.appId, appId),
        eq(openAppSessions.externalSessionId, externalSessionId),
      ),
    )
    .orderBy(desc(openAppSessions.updatedAt))
    .get();
}

export function touchOpenAppSession(db: Db, id: string): void {
  db.update(openAppSessions).set({ updatedAt: Date.now() }).where(eq(openAppSessions.id, id)).run();
}

export function recordOpenApiAudit(
  db: Db,
  input: {
    appId: string;
    keyId?: string | null;
    endpoint: string;
    datasourceId?: string | null;
    conversationId?: string | null;
    runId?: string | null;
    reportId?: string | null;
    externalUserId?: string | null;
    effectiveUserId?: string | null;
    status: "ok" | "error" | "rejected" | "rate_limited";
    httpStatus: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  },
): OpenApiAuditRow {
  return db
    .insert(openApiAudit)
    .values({
      id: randomUUID(),
      appId: input.appId,
      keyId: input.keyId ?? null,
      endpoint: input.endpoint,
      datasourceId: input.datasourceId ?? null,
      conversationId: input.conversationId ?? null,
      runId: input.runId ?? null,
      reportId: input.reportId ?? null,
      externalUserId: input.externalUserId ?? null,
      effectiveUserId: input.effectiveUserId ?? null,
      status: input.status,
      httpStatus: input.httpStatus,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
      inputTokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

export function listOpenApiAudit(
  db: Db,
  filters: {
    appId?: string;
    status?: "ok" | "error" | "rejected" | "rate_limited";
    limit?: number;
  } = {},
): OpenApiAuditEntry[] {
  const conditions = [];
  if (filters.appId) conditions.push(eq(openApiAudit.appId, filters.appId));
  if (filters.status) conditions.push(eq(openApiAudit.status, filters.status));
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = db
    .select({
      row: openApiAudit,
      appName: openApps.name,
    })
    .from(openApiAudit)
    .leftJoin(openApps, eq(openApiAudit.appId, openApps.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(openApiAudit.createdAt), desc(openApiAudit.id))
    .limit(limit)
    .all();

  return rows.map(({ row, appName }) => ({
    ...row,
    appName: appName ?? undefined,
  }));
}

export function getOpenPlatformStats(
  db: Db,
  opts: { appId?: string; days?: number } = {},
): OpenPlatformStats {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const conditions = [gte(openApiAudit.createdAt, since)];
  if (opts.appId) conditions.push(eq(openApiAudit.appId, opts.appId));

  const row = db
    .select({
      totalCalls: sql<number>`count(*)`,
      okCalls: sql<number>`coalesce(sum(case when ${openApiAudit.status} = 'ok' then 1 else 0 end), 0)`,
      errorCalls: sql<number>`coalesce(sum(case when ${openApiAudit.status} = 'error' then 1 else 0 end), 0)`,
      rejectedCalls: sql<number>`coalesce(sum(case when ${openApiAudit.status} = 'rejected' then 1 else 0 end), 0)`,
      rateLimitedCalls: sql<number>`coalesce(sum(case when ${openApiAudit.status} = 'rate_limited' then 1 else 0 end), 0)`,
      totalInputTokens: sql<number>`coalesce(sum(${openApiAudit.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`coalesce(sum(${openApiAudit.outputTokens}), 0)`,
      avgDurationMs: sql<number>`coalesce(avg(${openApiAudit.durationMs}), 0)`,
    })
    .from(openApiAudit)
    .where(and(...conditions))
    .get();

  return {
    totalCalls: Number(row?.totalCalls ?? 0),
    okCalls: Number(row?.okCalls ?? 0),
    errorCalls: Number(row?.errorCalls ?? 0),
    rejectedCalls: Number(row?.rejectedCalls ?? 0),
    rateLimitedCalls: Number(row?.rateLimitedCalls ?? 0),
    totalInputTokens: Number(row?.totalInputTokens ?? 0),
    totalOutputTokens: Number(row?.totalOutputTokens ?? 0),
    avgDurationMs: Math.round(Number(row?.avgDurationMs ?? 0)),
  };
}

export function createWebhookDelivery(
  db: Db,
  input: {
    appId: string;
    event: string;
    targetUrl: string;
    payloadJson: string;
  },
): OpenWebhookDeliveryRow {
  return db
    .insert(openWebhookDeliveries)
    .values({
      id: randomUUID(),
      appId: input.appId,
      event: input.event,
      targetUrl: input.targetUrl,
      payloadJson: input.payloadJson,
      status: "pending",
      attempts: 0,
      httpStatus: null,
      responseSnippet: null,
      error: null,
      createdAt: Date.now(),
      lastAttemptAt: null,
    })
    .returning()
    .get();
}

export function updateWebhookDelivery(
  db: Db,
  id: string,
  patch: {
    status: "pending" | "ok" | "failed";
    attempts: number;
    httpStatus?: number | null;
    responseSnippet?: string | null;
    error?: string | null;
    lastAttemptAt: number;
  },
): OpenWebhookDeliveryRow | undefined {
  return db
    .update(openWebhookDeliveries)
    .set({
      status: patch.status,
      attempts: patch.attempts,
      httpStatus: patch.httpStatus ?? null,
      responseSnippet: patch.responseSnippet ?? null,
      error: patch.error ?? null,
      lastAttemptAt: patch.lastAttemptAt,
    })
    .where(eq(openWebhookDeliveries.id, id))
    .returning()
    .get();
}

export function findWebhookDelivery(db: Db, id: string): OpenWebhookDeliveryRow | undefined {
  return db
    .select()
    .from(openWebhookDeliveries)
    .where(eq(openWebhookDeliveries.id, id))
    .get();
}

export function listWebhookDeliveries(
  db: Db,
  opts: { appId?: string; limit?: number } = {},
): OpenWebhookDeliverySummary[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = db
    .select()
    .from(openWebhookDeliveries)
    .where(opts.appId ? eq(openWebhookDeliveries.appId, opts.appId) : undefined)
    .orderBy(desc(openWebhookDeliveries.createdAt), desc(openWebhookDeliveries.id))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    appId: row.appId,
    event: row.event,
    targetUrl: row.targetUrl,
    status: row.status,
    attempts: row.attempts,
    httpStatus: row.httpStatus,
    responseSnippet: row.responseSnippet,
    error: row.error,
    createdAt: row.createdAt,
    lastAttemptAt: row.lastAttemptAt,
  }));
}
