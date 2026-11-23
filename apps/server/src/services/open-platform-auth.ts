import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import type { OpenAppScope, OpenEndUserContext, Permission } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { departmentOrgMap, departments } from "../db/schema.js";
import { effectiveDepartmentIds } from "../db/repositories/departments.js";
import { findDatasource, type DatasourceRow } from "../db/repositories/datasources.js";
import {
  findOpenApiKeyByHash,
  findOpenApp,
  parseAllowedDatasourceIds,
  parseOpenAppScopes,
  touchOpenApiKeyLastUsed,
  type OpenApiKeyRow,
  type OpenAppRow,
} from "../db/repositories/open-platform.js";
import { findUserById, findUserByUsername, type UserRow } from "../db/repositories/users.js";
import { canAccessDatasource, resolveUserAccess, type UserAccess } from "../auth/access.js";
import type { ScopeDepartmentOverride } from "./data-scope.js";

export const OPEN_API_KEY_PREFIX = "dc_open_";

export class OpenPlatformAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "OpenPlatformAuthError";
  }
}

export interface GeneratedOpenApiKey {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
}

export function hashOpenApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateOpenApiKey(): GeneratedOpenApiKey {
  const token = randomBytes(32).toString("base64url");
  const rawKey = `${OPEN_API_KEY_PREFIX}${token}`;
  return {
    rawKey,
    keyPrefix: rawKey.slice(0, 16),
    keyHash: hashOpenApiKey(rawKey),
  };
}

export function extractOpenApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const apiKeyHeader = headers["x-api-key"];
  const rawApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (rawApiKey && rawApiKey.trim()) return rawApiKey.trim();

  const authHeader = headers.authorization;
  const rawAuth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (rawAuth && /^bearer\s+/i.test(rawAuth)) {
    const token = rawAuth.replace(/^bearer\s+/i, "").trim();
    if (token) return token;
  }
  return null;
}

export interface OpenApiPrincipal {
  app: OpenAppRow;
  key: OpenApiKeyRow;
  scopes: Set<OpenAppScope>;
  allowedDatasourceIds: Set<string> | null;
  serviceUser: UserRow;
  serviceAccess: UserAccess;
}

/**
 * Re-reads key, app, and bound service user from SQLite on every request so revocations,
 * disables, expirations, and datasource grant changes take effect immediately.
 */
export function authenticateOpenApiKey(
  db: Db,
  rawKey: string | null,
  now = Date.now(),
): OpenApiPrincipal {
  if (!rawKey) {
    throw new OpenPlatformAuthError("API_KEY_REQUIRED", "缺少 API Key（请传入 Authorization: Bearer 或 X-API-Key）", 401);
  }
  const key = findOpenApiKeyByHash(db, hashOpenApiKey(rawKey));
  if (!key) {
    throw new OpenPlatformAuthError("API_KEY_INVALID", "API Key 无效", 401);
  }
  if (key.revokedAt !== null) {
    throw new OpenPlatformAuthError("API_KEY_REVOKED", "API Key 已吊销", 401);
  }
  if (key.expiresAt !== null && key.expiresAt <= now) {
    throw new OpenPlatformAuthError("API_KEY_EXPIRED", "API Key 已过期", 401);
  }
  const app = findOpenApp(db, key.appId);
  if (!app || app.status !== "active") {
    throw new OpenPlatformAuthError("APP_DISABLED", "开放应用已停用或不存在", 403);
  }
  const serviceUser = findUserById(db, app.serviceUserId);
  if (!serviceUser || serviceUser.status !== "active") {
    throw new OpenPlatformAuthError("SERVICE_USER_DISABLED", "应用绑定的服务账号已停用或不存在", 403);
  }
  const serviceAccess = resolveUserAccess(db, serviceUser);
  const allowedList = parseAllowedDatasourceIds(app.allowedDatasourceIdsJson);
  try {
    touchOpenApiKeyLastUsed(db, key.id, now);
  } catch {
    // Non-fatal metadata update.
  }
  return {
    app,
    key,
    scopes: new Set(parseOpenAppScopes(app.scopesJson)),
    allowedDatasourceIds: allowedList === null ? null : new Set(allowedList),
    serviceUser,
    serviceAccess,
  };
}

export function assertOpenScope(principal: OpenApiPrincipal, scope: OpenAppScope): void {
  if (!principal.scopes.has(scope)) {
    throw new OpenPlatformAuthError(
      "SCOPE_DENIED",
      `当前应用未开通「${scope}」能力权限`,
      403,
    );
  }
}

export function isAppDatasourceAllowed(principal: OpenApiPrincipal, datasourceId: string): boolean {
  if (!canAccessDatasource(principal.serviceAccess, datasourceId)) return false;
  if (principal.allowedDatasourceIds !== null && !principal.allowedDatasourceIds.has(datasourceId)) {
    return false;
  }
  return true;
}

export interface ResolvedOpenExecutionIdentity {
  datasource: DatasourceRow;
  effectiveUser: UserRow;
  effectiveAccess: UserAccess;
  externalUserId: string | null;
  scopeDepartmentOverride?: ScopeDepartmentOverride;
}

/**
 * Resolves the effective user, datasource authorization, and optional fail-closed
 * row-level department scope override for an Open Platform execution.
 */
export function resolveOpenExecutionIdentity(
  db: Db,
  input: {
    principal: OpenApiPrincipal;
    datasourceId: string;
    requiredPermissions: Permission[];
    endUser?: OpenEndUserContext;
  },
): ResolvedOpenExecutionIdentity {
  const { principal, datasourceId, requiredPermissions, endUser } = input;
  const datasource = findDatasource(db, datasourceId);
  if (!datasource || !isAppDatasourceAllowed(principal, datasource.id)) {
    throw new OpenPlatformAuthError("DATASOURCE_FORBIDDEN", "数据源不存在或当前应用无权访问", 403);
  }

  let effectiveUser = principal.serviceUser;
  let effectiveAccess = principal.serviceAccess;
  let scopeDepartmentOverride: ScopeDepartmentOverride | undefined;
  const externalUserId = endUser?.externalUserId ?? null;

  const wantsIdentityOverride = Boolean(
    endUser?.username ||
      (endUser?.departmentCodes && endUser.departmentCodes.length > 0) ||
      (endUser?.externalOrgCodes && endUser.externalOrgCodes.length > 0),
  );

  if (wantsIdentityOverride && principal.app.allowEndUserOverride !== 1) {
    throw new OpenPlatformAuthError(
      "END_USER_OVERRIDE_DISABLED",
      "当前应用未开启终端用户/部门上下文透传",
      403,
    );
  }

  if (endUser?.username) {
    const targetUser = findUserByUsername(db, endUser.username);
    if (!targetUser || targetUser.status !== "active") {
      throw new OpenPlatformAuthError(
        "END_USER_NOT_FOUND",
        `终端用户「${endUser.username}」不存在或已禁用`,
        403,
      );
    }
    const targetAccess = resolveUserAccess(db, targetUser);
    if (!canAccessDatasource(targetAccess, datasource.id)) {
      throw new OpenPlatformAuthError(
        "END_USER_DATASOURCE_FORBIDDEN",
        `终端用户「${targetUser.username}」无权访问该数据源`,
        403,
      );
    }
    effectiveUser = targetUser;
    effectiveAccess = targetAccess;
  }

  const deptCodes = [...new Set((endUser?.departmentCodes ?? []).map((code) => code.trim()).filter(Boolean))];
  const extOrgCodes = [...new Set((endUser?.externalOrgCodes ?? []).map((code) => code.trim()).filter(Boolean))];

  if (deptCodes.length > 0 || extOrgCodes.length > 0) {
    const rootIds = new Set<string>();

    if (deptCodes.length > 0) {
      const matchedDepts = db
        .select({ id: departments.id, code: departments.code })
        .from(departments)
        .where(and(eq(departments.status, "active"), inArray(departments.code, deptCodes)))
        .all();
      const matchedByCode = new Map(matchedDepts.map((row) => [row.code, row.id]));
      const missing = deptCodes.filter((code) => !matchedByCode.has(code));
      if (missing.length > 0) {
        throw new OpenPlatformAuthError(
          "DATA_SCOPE_INVALID_DEPARTMENT",
          `部门编码不存在或已归档：${missing.join("、")}`,
          403,
        );
      }
      for (const id of matchedByCode.values()) rootIds.add(id);
    }

    if (extOrgCodes.length > 0) {
      const mappings = db
        .select({
          departmentId: departmentOrgMap.departmentId,
          externalId: departmentOrgMap.externalId,
          externalCode: departmentOrgMap.externalCode,
          externalOrgCode: departmentOrgMap.externalOrgCode,
        })
        .from(departmentOrgMap)
        .innerJoin(departments, eq(departmentOrgMap.departmentId, departments.id))
        .where(
          and(
            eq(departmentOrgMap.datasourceId, datasource.id),
            eq(departments.status, "active"),
            or(
              inArray(departmentOrgMap.externalOrgCode, extOrgCodes),
              inArray(departmentOrgMap.externalCode, extOrgCodes),
              inArray(departmentOrgMap.externalId, extOrgCodes),
            ),
          ),
        )
        .all();

      const resolvedCodes = new Set<string>();
      for (const row of mappings) {
        if (row.externalOrgCode && extOrgCodes.includes(row.externalOrgCode)) {
          resolvedCodes.add(row.externalOrgCode);
          rootIds.add(row.departmentId);
        }
        if (row.externalCode && extOrgCodes.includes(row.externalCode)) {
          resolvedCodes.add(row.externalCode);
          rootIds.add(row.departmentId);
        }
        if (row.externalId && extOrgCodes.includes(row.externalId)) {
          resolvedCodes.add(row.externalId);
          rootIds.add(row.departmentId);
        }
      }
      const missingExt = extOrgCodes.filter((code) => !resolvedCodes.has(code));
      if (missingExt.length > 0) {
        throw new OpenPlatformAuthError(
          "DATA_SCOPE_MAPPING_MISSING",
          `外部组织编码未配置映射或对应部门已归档：${missingExt.join("、")}`,
          403,
        );
      }
    }

    const rootList = [...rootIds];
    const expanded = effectiveDepartmentIds(db, rootList);
    if (expanded.size === 0) {
      throw new OpenPlatformAuthError(
        "DATA_SCOPE_NO_DEPARTMENT",
        "未能解析出有效的部门数据范围",
        403,
      );
    }

    // Never allow privilege escalation beyond the bound service account (or mapped user)
    // unless the acting service account is an admin delegating narrower department scopes.
    if (!principal.serviceAccess.isAdmin && principal.serviceAccess.departmentIds !== null) {
      for (const id of expanded) {
        if (!principal.serviceAccess.departmentIds.has(id)) {
          throw new OpenPlatformAuthError(
            "DATA_SCOPE_OUT_OF_BOUNDS",
            "传入的部门范围超出应用服务账号的授权边界",
            403,
          );
        }
      }
    }
    if (endUser?.username && !effectiveAccess.isAdmin && effectiveAccess.departmentIds !== null) {
      for (const id of expanded) {
        if (!effectiveAccess.departmentIds.has(id)) {
          throw new OpenPlatformAuthError(
            "DATA_SCOPE_OUT_OF_BOUNDS",
            "传入的部门范围超出目标用户的授权边界",
            403,
          );
        }
      }
    }

    scopeDepartmentOverride = {
      rootIds: rootList,
      effectiveIds: [...expanded].sort(),
    };
  }

  for (const permission of requiredPermissions) {
    if (!principal.serviceAccess.permissions.has(permission)) {
      throw new OpenPlatformAuthError(
        "PERMISSION_DENIED",
        `应用服务账号缺少所需权限：${permission}`,
        403,
      );
    }
    if (!effectiveAccess.permissions.has(permission)) {
      throw new OpenPlatformAuthError(
        "PERMISSION_DENIED",
        `当前执行用户缺少所需权限：${permission}`,
        403,
      );
    }
  }

  return {
    datasource,
    effectiveUser,
    effectiveAccess,
    externalUserId,
    ...(scopeDepartmentOverride ? { scopeDepartmentOverride } : {}),
  };
}

/**
 * In-memory per-app sliding window rate limiter (requests per minute).
 * Enforces `open_apps.rate_limit_rpm` so external batch callers cannot overload the DB or LLM.
 */
export class OpenRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(now = Date.now) {
    this.now = now;
  }

  consume(appId: string, limitRpm: number): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const limit = Math.max(1, limitRpm);
    const current = this.now();
    const cutoff = current - 60_000;
    const timestamps = (this.windows.get(appId) ?? []).filter((ts) => ts > cutoff);
    if (timestamps.length >= limit) {
      const oldest = timestamps[0]!;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + 60_000 - current) / 1000));
      this.windows.set(appId, timestamps);
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    timestamps.push(current);
    this.windows.set(appId, timestamps);
    return { allowed: true, remaining: Math.max(0, limit - timestamps.length), retryAfterSec: 0 };
  }

  clear(): void {
    this.windows.clear();
  }
}
