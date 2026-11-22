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
  insertDashboard,
  listDashboardCardRows,
  listDashboardCardsWithDatasourceNames,
  listDashboardsByUser,
  reorderDashboardCards,
  toDashboardCardDto,
  updateOwnedDashboard,
  updateOwnedDashboardCard,
} from "../db/repositories/dashboards.js";
import { findDatasource } from "../db/repositories/datasources.js";
import {
  pinChartArtifactToDashboard,
  refreshDashboardCard,
} from "../services/dashboards.js";

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
  })
  .refine((d) => d.name !== undefined || d.description !== undefined, {
    message: "至少提供名称或说明",
  });

const pinArtifactSchema = z.object({
  artifactId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  width: z.union([z.literal(1), z.literal(2)]).optional(),
});

const updateCardSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    width: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .refine((d) => d.title !== undefined || d.width !== undefined, {
    message: "至少提供标题或宽度",
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
          id: row.id,
          name: row.name,
          description: row.description,
          cardCount: cards.length,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
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
      const updated = updateOwnedDashboard(opts.db, params.data.id, request.user!.sub, body.data);
      if (!updated) return reply.code(404).send(errorBody("NOT_FOUND", "看板不存在"));
      const cards = listDashboardCardsWithDatasourceNames(opts.db, updated.id);
      return {
        dashboard: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          cardCount: cards.length,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
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
      const updated = updateOwnedDashboardCard(
        opts.db,
        params.data.id,
        params.data.cardId,
        request.user!.sub,
        body.data,
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
