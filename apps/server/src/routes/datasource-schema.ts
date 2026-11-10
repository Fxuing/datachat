import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import {
  findDatasource,
  userCanAccess,
} from "../db/repositories/datasources.js";
import { SCHEMA_CACHE_TTL_MS, loadSchemaEntry } from "../db/repositories/schema-cache.js";
import { refreshDatasourceSchema } from "../services/schema-refresh.js";

interface DatasourceSchemaRoutesOptions {
  config: AppConfig;
  db: Db;
  pools: PoolRegistry;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const schemaPageLimit = 50;

function checkAccess(
  db: Db,
  request: { user?: { sub: string; role: string } },
  datasourceId: string,
): boolean {
  const user = request.user;
  if (!user) return false;
  return userCanAccess(db, user.sub, datasourceId, user.role === "admin");
}

export async function datasourceSchemaRoutes(
  app: FastifyInstance,
  opts: DatasourceSchemaRoutesOptions,
): Promise<void> {
  // TODO(Task 8): once `services/artifacts.ts` exists, register the ArtifactStore
  // and close it here on shutdown alongside the pool registry.

  app.post(
    "/api/datasources/:id/refresh-schema",
    { preHandler: app.requireAdmin, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const datasource = findDatasource(opts.db, id);
      if (!datasource) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });
      }

      try {
        const snapshot = await refreshDatasourceSchema(opts, datasource);
        return { tableCount: snapshot.tables.length, refreshedAt: snapshot.refreshedAt };
      } catch (error) {
        return reply.code(502).send({
          error: {
            code: "DS_UNREACHABLE",
            message: error instanceof Error ? error.message : "数据源连接失败",
          },
        });
      }
    },
  );

  app.get(
    "/api/datasources/:id/schema",
    { preHandler: app.authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      if (!checkAccess(opts.db, request, id)) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "无权访问该数据源" } });
      }

      const entry = loadSchemaEntry(opts.db, id);
      if (!entry) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "尚未缓存 schema" } });
      }

      const search = (request.query as { search?: string }).search?.trim().toLowerCase();
      const matched = search
        ? entry.snapshot.tables.filter((table) =>
            `${table.schema}.${table.name}`.toLowerCase().includes(search),
          )
        : entry.snapshot.tables;
      return {
        tables: matched.slice(0, schemaPageLimit),
        refreshedAt: entry.snapshot.refreshedAt,
        stale: Date.now() - entry.refreshedAt > SCHEMA_CACHE_TTL_MS,
        // Raw driver text can leak hostnames/accounts; only admins see it.
        error: user.role === "admin" ? entry.error : entry.error ? "上次刷新失败" : null,
        total: matched.length,
      };
    },
  );
}
