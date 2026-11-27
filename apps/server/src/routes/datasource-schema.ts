import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import type { DriverRegistry } from "../drivers/registry.js";
import { findDatasource } from "../db/repositories/datasources.js";
import { listScopePolicies } from "../db/repositories/data-scope.js";
import { normalizeTableName } from "../agent/sql/scope.js";
import { canAccessDatasource } from "../auth/access.js";
import { SCHEMA_CACHE_TTL_MS, loadSchemaEntry } from "../db/repositories/schema-cache.js";
import { userDepartmentScope } from "../services/data-scope.js";
import { refreshDatasourceSchema } from "../services/schema-refresh.js";
import {
  buildDatasourceStarterQuestions,
  listVisibleSemanticEntries,
} from "../services/semantic-layer.js";
import type { SchemaTable } from "../agent/datasource/introspect.js";

interface DatasourceSchemaRoutesOptions {
  config: AppConfig;
  db: Db;
  pools: PoolRegistry;
  drivers?: DriverRegistry;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const schemaPageLimit = 50;

function matchesSchemaSearch(table: SchemaTable, search: string): boolean {
  if (
    `${table.schema}.${table.name}`.toLowerCase().includes(search) ||
    (table.comment ?? "").toLowerCase().includes(search)
  ) {
    return true;
  }
  return table.columns.some(
    (column) =>
      column.name.toLowerCase().includes(search) ||
      (column.comment ?? "").toLowerCase().includes(search),
  );
}

function allowedScopeTables(
  db: DatasourceSchemaRoutesOptions["db"],
  datasourceId: string,
): Set<string> {
  return new Set(
    listScopePolicies(db, datasourceId)
      .filter((policy) => policy.enabled && policy.mode !== "denied")
      .map((policy) => normalizeTableName(policy.tableName)),
  );
}

export async function datasourceSchemaRoutes(
  app: FastifyInstance,
  opts: DatasourceSchemaRoutesOptions,
): Promise<void> {
  // TODO(Task 8): once `services/artifacts.ts` exists, register the ArtifactStore
  // and close it here on shutdown alongside the pool registry.

  app.post(
    "/api/datasources/:id/refresh-schema",
    { preHandler: app.requirePermission("admin.datasources"), schema: { params: idParamsSchema } },
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
      const access = request.access!;
      if (!canAccessDatasource(access, id)) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "无权访问该数据源" } });
      }
      const datasource = findDatasource(opts.db, id);
      if (!datasource) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });
      }

      const enforceScope = !access.isAdmin && datasource.dataScopeMode === "enabled";
      if (enforceScope && userDepartmentScope(opts.db, request.user!.sub).size === 0) {
        return reply.code(403).send({
          error: {
            code: "DATA_SCOPE_NO_DEPARTMENT",
            message: "当前数据源已启用部门数据权限，但你还没有加入任何部门",
          },
        });
      }

      const entry = loadSchemaEntry(opts.db, id);
      if (!entry) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "尚未缓存 schema" } });
      }

      const allowed = enforceScope ? allowedScopeTables(opts.db, id) : null;
      const visibleTables = allowed
        ? entry.snapshot.tables.filter((table) => allowed.has(normalizeTableName(table.name)))
        : entry.snapshot.tables;

      const search = (request.query as { search?: string }).search?.trim().toLowerCase();
      const matched = search
        ? visibleTables.filter((table) => matchesSchemaSearch(table, search))
        : visibleTables;
      return {
        tables: matched.slice(0, schemaPageLimit),
        refreshedAt: entry.snapshot.refreshedAt,
        stale: Date.now() - entry.refreshedAt > SCHEMA_CACHE_TTL_MS,
        // Raw driver text can leak hostnames/accounts; only admins see it.
        error: access.isAdmin ? entry.error : entry.error ? "上次刷新失败" : null,
        total: matched.length,
      };
    },
  );

  app.get(
    "/api/datasources/:id/catalog",
    { preHandler: app.authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = request.access!;
      if (!canAccessDatasource(access, id)) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "无权访问该数据源" } });
      }
      const datasource = findDatasource(opts.db, id);
      if (!datasource) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });
      }

      const visible = listVisibleSemanticEntries(opts.db, id, request.user!.sub);
      const entry = loadSchemaEntry(opts.db, id);
      const enforceScope = !access.isAdmin && datasource.dataScopeMode === "enabled";

      let tableCount = 0;
      let scopeNotice: string | null = null;
      if (visible.scopeDeniedNoDepartment) {
        tableCount = 0;
        scopeNotice = "当前数据源已启用部门数据权限，但你还没有加入任何部门";
      } else if (entry) {
        if (enforceScope) {
          const allowed = allowedScopeTables(opts.db, id);
          tableCount = entry.snapshot.tables.filter((table) =>
            allowed.has(normalizeTableName(table.name)),
          ).length;
        } else {
          tableCount = entry.snapshot.tables.length;
        }
      }

      return {
        datasourceId: id,
        refreshedAt: entry?.snapshot.refreshedAt ?? null,
        stale: entry ? Date.now() - entry.refreshedAt > SCHEMA_CACHE_TTL_MS : false,
        tableCount,
        scopeNotice,
        metrics: visible.metrics.map((metric) => ({
          id: metric.id,
          name: metric.name,
          synonyms: metric.synonyms,
          description: metric.description,
          tableName: metric.tableName,
          timeColumn: metric.timeColumn,
          unit: metric.unit,
        })),
        relations: visible.relations.map((relation) => ({
          id: relation.id,
          leftTable: relation.leftTable,
          leftColumn: relation.leftColumn,
          rightTable: relation.rightTable,
          rightColumn: relation.rightColumn,
          joinType: relation.joinType,
          description: relation.description,
        })),
        starterQuestions: buildDatasourceStarterQuestions(visible.metrics, visible.examples),
      };
    },
  );
}
