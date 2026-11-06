import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { datasourceInputSchema } from "@datachat/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
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

export interface DatasourceRouteOptions {
  config: AppConfig;
  db: Db;
}

const updateSchema = datasourceInputSchema.partial().extend({
  name: z.string().trim().min(1).max(64).optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

export async function datasourceRoutes(
  app: FastifyInstance,
  opts: DatasourceRouteOptions,
): Promise<void> {
  const { config, db } = opts;
  const key = deriveSecretKey(config.appSecret);

  app.get("/api/datasources", { preHandler: app.authenticate }, async (request) => {
    const rows = listDatasourcesForUser(db, request.user!.sub, request.user!.role === "admin");
    return { datasources: rows.map((row) => toDatasourceSummary(row)) };
  });

  app.post("/api/datasources", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = datasourceInputSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.password) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "缺少必要参数" } });
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
    return reply.code(201).send({ id, warnings: probe.warnings, readOnly: probe.readOnly });
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
    if (body.data.name !== undefined) {
      const duplicate = findDatasourceByName(db, body.data.name);
      if (duplicate && duplicate.id !== existing.id) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "数据源名称已存在" } });
      }
    }

    const patch: Partial<Omit<DatasourceRow, "id" | "createdAt" | "createdBy">> = {};
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.host !== undefined) patch.host = body.data.host;
    if (body.data.port !== undefined) patch.port = body.data.port;
    if (body.data.database !== undefined) patch.database = body.data.database;
    if (body.data.username !== undefined) patch.username = body.data.username;
    if (body.data.sslMode !== undefined) patch.sslMode = body.data.sslMode;
    if (body.data.password) patch.passwordCipher = encryptSecret(body.data.password, key);

    try {
      updateDatasource(db, existing.id, patch);
    } catch (error) {
      if (error instanceof DuplicateDatasourceNameError) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "数据源名称已存在" } });
      }
      throw error;
    }
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
    deleteDatasource(db, existing.id);
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
    return probe;
  });
}
