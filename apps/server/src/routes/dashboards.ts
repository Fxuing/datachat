import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import type { DriverRegistry } from "../drivers/registry.js";
import type { ArtifactStore } from "../services/artifacts.js";
import {
  deleteOwnedDashboard,
  deleteOwnedDashboardCard,
  findOwnedDashboard,
  findOwnedDashboardCard,
  insertDashboard,
  listDashboardCardRows,
  listDashboardCardsWithDatasourceNames,
  listDashboardsByUser,
  reorderDashboardCards,
  toDashboardCardDto,
  toDashboardSummaryDto,
  updateOwnedDashboard,
  updateOwnedDashboardCard,
} from "../db/repositories/dashboards.js";
import { findDatasource } from "../db/repositories/datasources.js";
import { guardSql } from "../agent/sql/guard.js";
import { defaultDriverRegistry } from "../drivers/registry.js";
import {
  pinChartArtifactToDashboard,
  refreshDashboardCard,
} from "../services/dashboards.js";
import { nextScheduleRun, validateSchedule } from "../services/schedule.js";

export interface DashboardRouteOptions {
  config: AppConfig;
  db: Db;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
  drivers?: DriverRegistry;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const cardParamsSchema = z.object({
  id: z.string().uuid(),
  cardId: z.string().uuid(),
});

const createDashboardSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
});

const updateDashboardSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    refreshCron: z.string().trim().max(100).optional().nullable(),
    refreshTimezone: z.string().trim().min(1).max(80).optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.description !== undefined ||
      d.refreshCron !== undefined ||
      d.refreshTimezone !== undefined,
    {
      message: "至少提供一个修改字段",
    },
  );

const pinArtifactSchema = z.object({
  artifactId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  width: z.union([z.literal(1), z.literal(2)]).optional(),
});

const updateCardSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    width: z.union([z.literal(1), z.literal(2)]).optional(),
    sqlText: z.string().trim().min(1).max(20_000).optional(),
  })
  .refine((d) => d.title !== undefined || d.width !== undefined || d.sqlText !== undefined, {
    message: "至少提供标题、宽度或 SQL",
  });

const reorderSchema = z.object({
  cardIds: z.array(z.string().uuid()).min(1).max(50),
});

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export async function dashboardRoutes(
  app: FastifyInstance,
  opts: DashboardRouteOptions,
): Promise<void> {
  app.get(
    "/api/dashboards",
    { preHandler: app.requirePermission("chat.use") },
    async (request) => {
      return { dashboards: listDashboardsByUser(opts.db, request.user!.sub) };
    },
  );

  app.post(
    "/api/dashboards",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const body = createDashboardSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const dashboard = insertDashboard(opts.db, {
        userId: request.user!.sub,
        name: body.data.name,
        description: body.data.description,
      });
      return reply.code(201).send({ dashboard });
    },
  );

  app.get(
    "/api/dashboards/:id",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const row = findOwnedDashboard(opts.db, params.data.id, request.user!.sub);
      if (!row) return reply.code(404).send(errorBody("NOT_FOUND", "看板不存在"));
      const cards = listDashboardCardsWithDatasourceNames(opts.db, row.id);
      return {
        dashboard: {
          ...toDashboardSummaryDto(row, cards.length),
          cards,
        },
      };
    },
  );

  app.patch(
    "/api/dashboards/:id",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = updateDashboardSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const existing = findOwnedDashboard(opts.db, params.data.id, request.user!.sub);
      if (!existing) return reply.code(404).send(errorBody("NOT_FOUND", "看板不存在"));

      let nextCron: string | null | undefined = undefined;
      let nextTimezone: string | undefined = undefined;
      let nextRefreshAt: number | null | undefined = undefined;

      if (body.data.refreshCron !== undefined || body.data.refreshTimezone !== undefined) {
        const effectiveCron =
          body.data.refreshCron === ""
            ? null
            : body.data.refreshCron !== undefined
              ? body.data.refreshCron
              : existing.refreshCron;
        const effectiveTz = body.data.refreshTimezone ?? existing.refreshTimezone ?? "Asia/Shanghai";

        if (effectiveCron === null) {
          nextCron = null;
          nextTimezone = effectiveTz;
          nextRefreshAt = null;
        } else {
          const check = validateSchedule({
            cronExpression: effectiveCron,
            timezone: effectiveTz,
          });
          if (check) {
            return reply.code(400).send(errorBody(check.code, check.message));
          }
          nextCron = effectiveCron;
          nextTimezone = effectiveTz;
          nextRefreshAt = nextScheduleRun({
            cronExpression: effectiveCron,
            timezone: effectiveTz,
          });
        }
      }

      const updated = updateOwnedDashboard(opts.db, params.data.id, request.user!.sub, {
        ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        ...(body.data.description !== undefined ? { description: body.data.description } : {}),
        ...(nextCron !== undefined ? { refreshCron: nextCron } : {}),
        ...(nextTimezone !== undefined ? { refreshTimezone: nextTimezone } : {}),
        ...(nextRefreshAt !== undefined ? { nextRefreshAt } : {}),
      });
      if (!updated) return reply.code(404).send(errorBody("NOT_FOUND", "看板不存在"));
      const cards = listDashboardCardsWithDatasourceNames(opts.db, updated.id);
      return {
        dashboard: {
          ...toDashboardSummaryDto(updated, cards.length),
          cards,
        },
      };
    },
  );

  app.delete(
    "/api/dashboards/:id",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const removed = deleteOwnedDashboard(opts.db, params.data.id, request.user!.sub);
      if (!removed) return reply.code(404).send(errorBody("NOT_FOUND", "看板不存在"));
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/dashboards/:id/cards/from-artifact",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = pinArtifactSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const user = request.user!;
      const result = pinChartArtifactToDashboard(
        { db: opts.db, artifacts: opts.artifacts },
        {
          dashboardId: params.data.id,
          userId: user.sub,
          isAdmin: user.role === "admin",
          artifactId: body.data.artifactId,
          ...(body.data.title !== undefined ? { title: body.data.title } : {}),
          ...(body.data.width !== undefined ? { width: body.data.width } : {}),
        },
      );
      if (!result.ok) {
        return reply.code(result.status).send(errorBody(result.code, result.message));
      }
      return reply.code(201).send({ card: result.card });
    },
  );

  app.patch(
    "/api/dashboards/:id/cards/reorder",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = reorderSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const ok = reorderDashboardCards(opts.db, params.data.id, request.user!.sub, body.data.cardIds);
      if (!ok) return reply.code(404).send(errorBody("NOT_FOUND", "看板不存在"));
      return { cards: listDashboardCardsWithDatasourceNames(opts.db, params.data.id) };
    },
  );

  app.patch(
    "/api/dashboards/:id/cards/:cardId",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = cardParamsSchema.safeParse(request.params);
      const body = updateCardSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      if (body.data.sqlText !== undefined) {
        const existingCard = findOwnedDashboardCard(
          opts.db,
          params.data.id,
          params.data.cardId,
          request.user!.sub,
        );
        if (!existingCard) return reply.code(404).send(errorBody("NOT_FOUND", "看板卡片不存在"));
        const ds = existingCard.datasourceId
          ? findDatasource(opts.db, existingCard.datasourceId)
          : undefined;
        if (!ds) {
          return reply
            .code(400)
            .send(errorBody("NOT_REFRESHABLE", "该卡片未绑定数据源，不支持修改 SQL"));
        }
        const driver = (opts.drivers ?? defaultDriverRegistry).get(ds.type);
        if (!driver) {
          return reply
            .code(503)
            .send(errorBody("DRIVER_NOT_INSTALLED", `未安装「${ds.type}」数据源驱动`));
        }
        const guard = guardSql({
          sql: body.data.sqlText,
          dialect: driver.dialect,
          maxRows: opts.config.queryMaxRows,
        });
        if (!guard.ok) {
          return reply
            .code(400)
            .send(errorBody("INVALID_SQL", `SQL 未通过只读安全校验：${guard.reason}`));
        }
      }
      const updated = updateOwnedDashboardCard(
        opts.db,
        params.data.id,
        params.data.cardId,
        request.user!.sub,
        {
          ...body.data,
          // Once the owner explicitly edits SQL, detach sourceArtifactId so auto-repair won't revert it.
          ...(body.data.sqlText !== undefined ? { sourceArtifactId: null } : {}),
        },
      );
      if (!updated) return reply.code(404).send(errorBody("NOT_FOUND", "看板卡片不存在"));
      const dsName = updated.datasourceId
        ? (findDatasource(opts.db, updated.datasourceId)?.name ?? null)
        : null;
      return { card: toDashboardCardDto(updated, dsName) };
    },
  );

  app.delete(
    "/api/dashboards/:id/cards/:cardId",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = cardParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const removed = deleteOwnedDashboardCard(
        opts.db,
        params.data.id,
        params.data.cardId,
        request.user!.sub,
      );
      if (!removed) return reply.code(404).send(errorBody("NOT_FOUND", "看板卡片不存在"));
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/dashboards/:id/cards/:cardId/refresh",
    {
      preHandler: app.requirePermission("chat.use"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const params = cardParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const result = await refreshDashboardCard(opts, {
        dashboardId: params.data.id,
        cardId: params.data.cardId,
        userId: request.user!.sub,
      });
      if (!result.ok) {
        return reply.code(result.status).send({
          ...errorBody(result.code, result.message),
          ...(result.card ? { card: result.card } : {}),
        });
      }
      return { card: result.card };
    },
  );

  app.post(
    "/api/dashboards/:id/refresh",
    {
      preHandler: app.requirePermission("chat.use"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      const user = request.user!;
      const dashboard = findOwnedDashboard(opts.db, params.data.id, user.sub);
      if (!dashboard) return reply.code(404).send(errorBody("NOT_FOUND", "看板不存在"));

      const rows = listDashboardCardRows(opts.db, dashboard.id);
      let refreshed = 0;
      let failed = 0;
      let skipped = 0;
      for (const row of rows) {
        if (!row.datasourceId || !row.sqlText || !row.chartConfigJson) {
          skipped += 1;
          continue;
        }
        const res = await refreshDashboardCard(opts, {
          dashboardId: dashboard.id,
          cardId: row.id,
          userId: user.sub,
        });
        if (res.ok) refreshed += 1;
        else failed += 1;
      }

      const cards = listDashboardCardsWithDatasourceNames(opts.db, dashboard.id);
      return {
        refreshed,
        failed,
        skipped,
        cards,
      };
    },
  );
}
