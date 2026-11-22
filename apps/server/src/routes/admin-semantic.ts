import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { findDatasource } from "../db/repositories/datasources.js";
import { loadSchemaEntry } from "../db/repositories/schema-cache.js";
import { guardSql } from "../agent/sql/guard.js";
import { collectTableNames } from "../agent/sql/scope.js";
import { defaultDriverRegistry, type DriverRegistry } from "../drivers/registry.js";
import {
  deleteSemanticMetric,
  deleteSemanticRelation,
  insertSemanticMetric,
  insertSemanticRelation,
  listSemanticMetrics,
  listSemanticRelations,
  updateSemanticMetric,
  updateSemanticRelation,
} from "../db/repositories/semantic-layer.js";
import {
  deleteSqlExample,
  getDatasourceFeedbackSummary,
  insertSqlExample,
  listDatasourceFeedback,
  listSqlExamples,
  markRunFeedbackPromoted,
  updateDatasourceFeedbackStatus,
  updateSqlExample,
} from "../db/repositories/sql-examples.js";
import { buildSemanticBlock } from "../services/semantic-layer.js";

export interface AdminSemanticRouteOptions {
  db: Db;
  drivers?: DriverRegistry;
}

const datasourceParamsSchema = z.object({ datasourceId: z.string().uuid() });
const itemParamsSchema = z.object({
  datasourceId: z.string().uuid(),
  id: z.string().uuid(),
});

const stringListSchema = z.array(z.string().trim().min(1).max(200)).max(20);

const createMetricSchema = z.object({
  name: z.string().trim().min(1).max(100),
  synonyms: stringListSchema.optional(),
  description: z.string().trim().max(500).optional().nullable(),
  sqlExpression: z.string().trim().min(1).max(1000),
  tableName: z.string().trim().max(200).optional().nullable(),
  defaultFilters: stringListSchema.optional(),
  timeColumn: z.string().trim().max(200).optional().nullable(),
  unit: z.string().trim().max(50).optional().nullable(),
  enabled: z.boolean().optional(),
  sourceRunId: z.string().trim().min(1).max(100).optional().nullable(),
});

const updateMetricSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    synonyms: stringListSchema.optional(),
    description: z.string().trim().max(500).optional().nullable(),
    sqlExpression: z.string().trim().min(1).max(1000).optional(),
    tableName: z.string().trim().max(200).optional().nullable(),
    defaultFilters: stringListSchema.optional(),
    timeColumn: z.string().trim().max(200).optional().nullable(),
    unit: z.string().trim().max(50).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "至少提供一个修改字段" });

const createRelationSchema = z.object({
  leftTable: z.string().trim().min(1).max(200),
  leftColumn: z.string().trim().min(1).max(200),
  rightTable: z.string().trim().min(1).max(200),
  rightColumn: z.string().trim().min(1).max(200),
  joinType: z.enum(["inner", "left", "right"]).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  enabled: z.boolean().optional(),
});

const updateRelationSchema = z
  .object({
    leftTable: z.string().trim().min(1).max(200).optional(),
    leftColumn: z.string().trim().min(1).max(200).optional(),
    rightTable: z.string().trim().min(1).max(200).optional(),
    rightColumn: z.string().trim().min(1).max(200).optional(),
    joinType: z.enum(["inner", "left", "right"]).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "至少提供一个修改字段" });

const previewSchema = z.object({
  query: z.string().trim().min(1).max(500),
});

const createExampleSchema = z.object({
  question: z.string().trim().min(1).max(500),
  sqlText: z.string().trim().min(1).max(4000),
  notes: z.string().trim().max(500).optional().nullable(),
  source: z.enum(["manual", "feedback_up", "feedback_fix"]).optional(),
  sourceRunId: z.string().trim().min(1).max(100).optional().nullable(),
  enabled: z.boolean().optional(),
});

const updateExampleSchema = z
  .object({
    question: z.string().trim().min(1).max(500).optional(),
    sqlText: z.string().trim().min(1).max(4000).optional(),
    notes: z.string().trim().max(500).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "至少提供一个修改字段" });

const feedbackQuerySchema = z.object({
  rating: z.enum(["all", "1", "-1"]).optional().default("all"),
  status: z.enum(["all", "pending", "promoted", "dismissed"]).optional().default("pending"),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const updateFeedbackStatusSchema = z.object({
  reviewStatus: z.enum(["pending", "promoted", "dismissed"]),
});

function validateExampleSql(
  sqlText: string,
  datasourceType: string,
  drivers: DriverRegistry,
): { ok: true; tables: string[] } | { ok: false; message: string } {
  const driver = drivers.get(datasourceType);
  if (!driver) {
    return { ok: false, message: `未安装「${datasourceType}」驱动，无法校验示例 SQL` };
  }
  const guard = guardSql({ sql: sqlText, dialect: driver.dialect, maxRows: 100_000 });
  if (!guard.ok) {
    return { ok: false, message: `示例 SQL 未通过只读安全校验：${guard.reason}` };
  }
  let tables: string[] = [];
  try {
    tables = collectTableNames(sqlText, driver.dialect);
  } catch {
    tables = [];
  }
  return { ok: true, tables };
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function isUniqueConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || message.includes("UNIQUE constraint failed");
}

export async function adminSemanticRoutes(
  app: FastifyInstance,
  opts: AdminSemanticRouteOptions,
): Promise<void> {
  const drivers = opts.drivers ?? defaultDriverRegistry;

  app.get(
    "/api/admin/datasources/:datasourceId/semantic",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = datasourceParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const datasource = findDatasource(opts.db, params.data.datasourceId);
      if (!datasource) return reply.code(404).send(errorBody("NOT_FOUND", "数据源不存在"));

      const schemaEntry = loadSchemaEntry(opts.db, datasource.id);
      const tables =
        schemaEntry?.snapshot?.tables.map((table) => ({
          name: table.name,
          comment: table.comment,
          columns: table.columns.map((column) => column.name),
        })) ?? [];

      return {
        datasource: {
          id: datasource.id,
          name: datasource.name,
          type: datasource.type,
        },
        metrics: listSemanticMetrics(opts.db, datasource.id),
        relations: listSemanticRelations(opts.db, datasource.id),
        examples: listSqlExamples(opts.db, datasource.id),
        feedbackSummary: getDatasourceFeedbackSummary(opts.db, datasource.id),
        tables,
      };
    },
  );

  app.post(
    "/api/admin/datasources/:datasourceId/semantic/metrics",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = datasourceParamsSchema.safeParse(request.params);
      const body = createMetricSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const datasource = findDatasource(opts.db, params.data.datasourceId);
      if (!datasource) return reply.code(404).send(errorBody("NOT_FOUND", "数据源不存在"));

      try {
        const { sourceRunId, ...metricInput } = body.data;
        const metric = insertSemanticMetric(opts.db, {
          datasourceId: datasource.id,
          ...metricInput,
        });
        if (sourceRunId) {
          markRunFeedbackPromoted(opts.db, sourceRunId);
        }
        return reply.code(201).send({ metric });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return reply.code(409).send(errorBody("CONFLICT", "该数据源下已存在同名指标"));
        }
        throw err;
      }
    },
  );

  app.patch(
    "/api/admin/datasources/:datasourceId/semantic/metrics/:id",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = itemParamsSchema.safeParse(request.params);
      const body = updateMetricSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      try {
        const metric = updateSemanticMetric(
          opts.db,
          params.data.datasourceId,
          params.data.id,
          body.data,
        );
        if (!metric) return reply.code(404).send(errorBody("NOT_FOUND", "指标不存在"));
        return { metric };
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return reply.code(409).send(errorBody("CONFLICT", "该数据源下已存在同名指标"));
        }
        throw err;
      }
    },
  );

  app.delete(
    "/api/admin/datasources/:datasourceId/semantic/metrics/:id",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = itemParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const removed = deleteSemanticMetric(opts.db, params.data.datasourceId, params.data.id);
      if (!removed) return reply.code(404).send(errorBody("NOT_FOUND", "指标不存在"));
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/admin/datasources/:datasourceId/semantic/relations",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = datasourceParamsSchema.safeParse(request.params);
      const body = createRelationSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const datasource = findDatasource(opts.db, params.data.datasourceId);
      if (!datasource) return reply.code(404).send(errorBody("NOT_FOUND", "数据源不存在"));

      try {
        const relation = insertSemanticRelation(opts.db, {
          datasourceId: datasource.id,
          ...body.data,
        });
        return reply.code(201).send({ relation });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return reply.code(409).send(errorBody("CONFLICT", "该关联关系已存在"));
        }
        throw err;
      }
    },
  );

  app.patch(
    "/api/admin/datasources/:datasourceId/semantic/relations/:id",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = itemParamsSchema.safeParse(request.params);
      const body = updateRelationSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      try {
        const relation = updateSemanticRelation(
          opts.db,
          params.data.datasourceId,
          params.data.id,
          body.data,
        );
        if (!relation) return reply.code(404).send(errorBody("NOT_FOUND", "关联关系不存在"));
        return { relation };
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return reply.code(409).send(errorBody("CONFLICT", "该关联关系已存在"));
        }
        throw err;
      }
    },
  );

  app.delete(
    "/api/admin/datasources/:datasourceId/semantic/relations/:id",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = itemParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const removed = deleteSemanticRelation(opts.db, params.data.datasourceId, params.data.id);
      if (!removed) return reply.code(404).send(errorBody("NOT_FOUND", "关联关系不存在"));
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/admin/datasources/:datasourceId/semantic/preview",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = datasourceParamsSchema.safeParse(request.params);
      const body = previewSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const datasource = findDatasource(opts.db, params.data.datasourceId);
      if (!datasource) return reply.code(404).send(errorBody("NOT_FOUND", "数据源不存在"));

      const result = buildSemanticBlock({
        db: opts.db,
        datasourceId: datasource.id,
        query: body.data.query,
      });
      return {
        text: result.text,
        metricIds: result.metrics.map((m) => m.id),
        relationIds: result.relations.map((r) => r.id),
        exampleIds: result.examples.map((e) => e.id),
      };
    },
  );

  app.post(
    "/api/admin/datasources/:datasourceId/semantic/examples",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = datasourceParamsSchema.safeParse(request.params);
      const body = createExampleSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const datasource = findDatasource(opts.db, params.data.datasourceId);
      if (!datasource) return reply.code(404).send(errorBody("NOT_FOUND", "数据源不存在"));

      const checked = validateExampleSql(body.data.sqlText, datasource.type, drivers);
      if (!checked.ok) {
        return reply.code(400).send(errorBody("INVALID_SQL", checked.message));
      }

      const example = insertSqlExample(opts.db, {
        datasourceId: datasource.id,
        question: body.data.question,
        sqlText: body.data.sqlText,
        notes: body.data.notes ?? null,
        tables: checked.tables,
        source: body.data.source ?? "manual",
        sourceRunId: body.data.sourceRunId ?? null,
        enabled: body.data.enabled,
        createdBy: request.user!.sub,
      });

      if (body.data.sourceRunId) {
        markRunFeedbackPromoted(opts.db, body.data.sourceRunId);
      }

      return reply.code(201).send({ example });
    },
  );

  app.patch(
    "/api/admin/datasources/:datasourceId/semantic/examples/:id",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = itemParamsSchema.safeParse(request.params);
      const body = updateExampleSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const datasource = findDatasource(opts.db, params.data.datasourceId);
      if (!datasource) return reply.code(404).send(errorBody("NOT_FOUND", "数据源不存在"));

      let tables: string[] | undefined;
      if (body.data.sqlText !== undefined) {
        const checked = validateExampleSql(body.data.sqlText, datasource.type, drivers);
        if (!checked.ok) {
          return reply.code(400).send(errorBody("INVALID_SQL", checked.message));
        }
        tables = checked.tables;
      }

      const example = updateSqlExample(opts.db, datasource.id, params.data.id, {
        ...body.data,
        ...(tables !== undefined ? { tables } : {}),
      });
      if (!example) return reply.code(404).send(errorBody("NOT_FOUND", "SQL 示例不存在"));
      return { example };
    },
  );

  app.delete(
    "/api/admin/datasources/:datasourceId/semantic/examples/:id",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = itemParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const removed = deleteSqlExample(opts.db, params.data.datasourceId, params.data.id);
      if (!removed) return reply.code(404).send(errorBody("NOT_FOUND", "SQL 示例不存在"));
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/admin/datasources/:datasourceId/semantic/feedback",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = datasourceParamsSchema.safeParse(request.params);
      const query = feedbackQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const datasource = findDatasource(opts.db, params.data.datasourceId);
      if (!datasource) return reply.code(404).send(errorBody("NOT_FOUND", "数据源不存在"));

      const rating =
        query.data.rating === "1" ? 1 : query.data.rating === "-1" ? -1 : "all";
      const items = listDatasourceFeedback(opts.db, datasource.id, {
        rating,
        status: query.data.status,
        limit: query.data.limit,
      });
      return {
        items,
        summary: getDatasourceFeedbackSummary(opts.db, datasource.id),
      };
    },
  );

  app.patch(
    "/api/admin/datasources/:datasourceId/semantic/feedback/:id",
    { preHandler: app.requirePermission("admin.datasources") },
    async (request, reply) => {
      const params = itemParamsSchema.safeParse(request.params);
      const body = updateFeedbackStatusSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const updated = updateDatasourceFeedbackStatus(
        opts.db,
        params.data.datasourceId,
        params.data.id,
        body.data.reviewStatus,
      );
      if (!updated) return reply.code(404).send(errorBody("NOT_FOUND", "反馈记录不存在"));
      return { ok: true, reviewStatus: body.data.reviewStatus };
    },
  );
}
