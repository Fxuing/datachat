import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { datasourceInputSchema } from "@datachat/shared";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { conversations } from "../db/schema.js";
import {
  deleteDatasource,
  DuplicateDatasourceNameError,
  findDatasource,
  findDatasourceByName,
  insertDatasource,
  listDatasourcesForUser,
  toDatasourceSummary,
  updateDatasource,
  type DatasourceRow,
} from "../db/repositories/datasources.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../agent/datasource/crypto.js";
import { probeDatasource, safeErrorMessage } from "../agent/datasource/probe.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import { recordAuditEvent } from "../services/audit.js";

export interface DatasourceRouteOptions {
  config: AppConfig;
  db: Db;
  pools: PoolRegistry;
}

const updateSchema = datasourceInputSchema.partial().extend({
  name: z.string().trim().min(1).max(64).optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

/** Metadata/link-local endpoints must never receive datasource credentials. */
export function isBlockedDatasourceHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "metadata.google.internal" || host === "fd00:ec2::254") return true;
  if (host.startsWith("fe80:") || host.startsWith("fd00:ec2:")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  const ipv4 = mapped?.[1] ?? host;
  if (!isIPv4(ipv4)) return false;
  const [first, second] = ipv4.split(".").map(Number);
  return first === 169 && second === 254;
}

function blockedHostMessage(): { error: { code: string; message: string } } {
  return { error: { code: "HOST_NOT_ALLOWED", message: "不允许连接链路本地或元数据地址" } };
}

export async function datasourceRoutes(
  app: FastifyInstance,
  opts: DatasourceRouteOptions,
): Promise<void> {
  const { config, db, pools } = opts;
  const key = deriveSecretKey(config.appSecret);

  const audit = (
    request: FastifyRequest,
    action: "datasource_create" | "datasource_update" | "datasource_delete",
    detail: Record<string, unknown>,
  ) => {
    recordAuditEvent(db, {
      actorUserId: request.user!.sub,
      datasourceId: typeof detail.id === "string" ? detail.id : undefined,
      action,
      ip: request.ip,
      detail,
    });
  };

  app.get("/api/datasources", { preHandler: app.authenticate }, async (request) => {
    const rows = listDatasourcesForUser(db, request.user!.sub, request.user!.role === "admin");
    return { datasources: rows.map((row) => toDatasourceSummary(row)) };
  });

  app.post("/api/datasources", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = datasourceInputSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.password) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "缺少必要参数" } });
    }
    if (isBlockedDatasourceHost(parsed.data.host)) {
      return reply.code(400).send(blockedHostMessage());
    }
    if (findDatasourceByName(db, parsed.data.name)) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: "数据源名称已存在" } });
    }
    const probe = await probeDatasource({
      type: parsed.data.type,
      host: parsed.data.host,
      port: parsed.data.port,
      database: parsed.data.database,
      username: parsed.data.username,
      password: parsed.data.password,
      sslMode: parsed.data.sslMode,
    });
    if (!probe.ok) {
      return reply.code(400).send({
        error: {
          code: "DS_UNREACHABLE",
          message: safeErrorMessage(probe.error ?? "连接失败", parsed.data.password),
        },
      });
    }
    const id = randomUUID();
    const now = Date.now();
    try {
      insertDatasource(db, {
        id,
        name: parsed.data.name,
        type: parsed.data.type,
        host: parsed.data.host,
        port: parsed.data.port,
        database: parsed.data.database,
        username: parsed.data.username,
        passwordCipher: encryptSecret(parsed.data.password, key),
        sslMode: parsed.data.sslMode,
        readOnlyVerified: probe.readOnly ? 1 : 0,
        allowWriteAccount: parsed.data.allowWriteAccount ? 1 : 0,
        status: "ok",
        lastCheckedAt: now,
        createdBy: request.user!.sub,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof DuplicateDatasourceNameError) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "数据源名称已存在" } });
      }
      throw error;
    }
    audit(request, "datasource_create", {
      id,
      name: parsed.data.name,
      type: parsed.data.type,
      allowWriteAccount: parsed.data.allowWriteAccount,
    });
    return reply.code(201).send({
      id,
      warnings: parsed.data.allowWriteAccount ? [] : probe.warnings,
      readOnly: probe.readOnly,
      allowWriteAccount: parsed.data.allowWriteAccount,
    });
  });

  app.patch("/api/datasources/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const existing = findDatasource(db, params.data.id);
    if (!existing) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });
    }
    if (body.data.host !== undefined && isBlockedDatasourceHost(body.data.host)) {
      return reply.code(400).send(blockedHostMessage());
    }
    const hostChanged = body.data.host !== undefined && body.data.host !== existing.host;
    const portChanged = body.data.port !== undefined && body.data.port !== existing.port;
    if ((hostChanged || portChanged) && !body.data.password) {
      return reply.code(400).send({
        error: { code: "PASSWORD_REQUIRED", message: "修改主机或端口时必须重新输入密码" },
      });
    }
    if (body.data.name !== undefined) {
      const duplicate = findDatasourceByName(db, body.data.name);
      if (duplicate && duplicate.id !== existing.id) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "数据源名称已存在" } });
      }
    }

    const patch: Partial<Omit<DatasourceRow, "id" | "createdAt" | "createdBy">> = {};
    const connectionChanged =
      body.data.host !== undefined ||
      body.data.port !== undefined ||
      body.data.database !== undefined ||
      body.data.username !== undefined ||
      body.data.sslMode !== undefined ||
      Boolean(body.data.password);
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.host !== undefined) patch.host = body.data.host;
    if (body.data.port !== undefined) patch.port = body.data.port;
    if (body.data.database !== undefined) patch.database = body.data.database;
    if (body.data.username !== undefined) patch.username = body.data.username;
    if (body.data.sslMode !== undefined) patch.sslMode = body.data.sslMode;
    if (body.data.password) patch.passwordCipher = encryptSecret(body.data.password, key);
    if (body.data.allowWriteAccount !== undefined) {
      patch.allowWriteAccount = body.data.allowWriteAccount ? 1 : 0;
    }
    if (connectionChanged) {
      patch.status = "unknown";
      patch.readOnlyVerified = 0;
      patch.lastCheckedAt = null;
    }

    try {
      updateDatasource(db, existing.id, patch);
    } catch (error) {
      if (error instanceof DuplicateDatasourceNameError) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "数据源名称已存在" } });
      }
      throw error;
    }
    // Any edit invalidates the cached connection, even a metadata-only one.
    await pools.evict(existing.id);
    audit(request, "datasource_update", {
      id: existing.id,
      name: patch.name ?? existing.name,
      connectionChanged,
    });
    return { ok: true };
  });

  app.delete("/api/datasources/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const existing = findDatasource(db, params.data.id);
    if (!existing) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });
    }
    const referenced = db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.datasourceId, existing.id))
      .get();
    if (referenced) {
      return reply.code(409).send({
        error: { code: "DS_IN_USE", message: "数据源已被会话引用，无法删除" },
      });
    }
    deleteDatasource(db, existing.id);
    await pools.evict(existing.id);
    audit(request, "datasource_delete", { id: existing.id, name: existing.name });
    return { ok: true };
  });

  app.post("/api/datasources/:id/test", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const ds = findDatasource(db, params.data.id);
    if (!ds) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });
    }
    if (isBlockedDatasourceHost(ds.host)) {
      return reply.code(400).send(blockedHostMessage());
    }

    const probe = await probeDatasource({
      type: ds.type,
      host: ds.host,
      port: ds.port,
      database: ds.database,
      username: ds.username,
      password: decryptSecret(ds.passwordCipher, key),
      sslMode: ds.sslMode,
    });
    updateDatasource(db, ds.id, {
      status: probe.ok ? "ok" : "error",
      lastCheckedAt: Date.now(),
      readOnlyVerified: probe.readOnly ? 1 : 0,
    });
    // Suppress the "use a read-only account" advice when the admin opted in.
    return { ...probe, warnings: ds.allowWriteAccount ? [] : probe.warnings };
  });
}
