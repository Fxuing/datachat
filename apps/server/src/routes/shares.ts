import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  createShare,
  listShares,
  resolveShare,
  resolveShareReport,
  revokeShare,
  SHARE_MAX_EXPIRES_IN_DAYS,
  SHARE_MIN_EXPIRES_IN_DAYS,
  type ShareErrorCode,
} from "../services/shares.js";
import type { ArtifactStore } from "../services/artifacts.js";
import { effectiveSettings } from "../services/app-settings.js";

export interface ShareRouteOptions {
  db: Db;
  artifacts: ArtifactStore;
  config: AppConfig;
}

const createBodySchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    reportId: z.string().uuid().optional(),
    dashboardId: z.string().uuid().optional(),
    expiresInDays: z
      .number()
      .int()
      .min(SHARE_MIN_EXPIRES_IN_DAYS)
      .max(SHARE_MAX_EXPIRES_IN_DAYS)
      .optional(),
  })
  .refine(
    (value) =>
      Number(value.conversationId !== undefined) +
        Number(value.reportId !== undefined) +
        Number(value.dashboardId !== undefined) ===
      1,
    { message: "必须且只能指定会话、报告或看板之一" },
  );

const idParamsSchema = z.object({ id: z.string().uuid() });
const tokenParamsSchema = z.object({ token: z.string().min(1).max(512) });
const tokenReportParamsSchema = z.object({
  token: z.string().min(1).max(512),
  reportId: z.string().uuid(),
});
const listQuerySchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    reportId: z.string().uuid().optional(),
    dashboardId: z.string().uuid().optional(),
    status: z.enum(["active", "all"]).optional(),
    scope: z.enum(["mine", "all"]).optional(),
  })
  .refine(
    (value) =>
      Number(value.conversationId !== undefined) +
        Number(value.reportId !== undefined) +
        Number(value.dashboardId !== undefined) <=
      1,
    { message: "最多只能指定一个目标" },
  );

const ERROR_STATUS: Record<ShareErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  SHARE_DISABLED_BY_SCOPE: 409,
};

function error(code: string, message: string) {
  return { error: { code, message } };
}

export async function shareRoutes(
  app: FastifyInstance,
  opts: ShareRouteOptions,
): Promise<void> {
  app.get("/api/shares", { preHandler: app.authenticate }, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(error("VALIDATION", "参数不合法"));
    }
    const user = request.user!;
    const isAdmin = user.role === "admin";
    const scope = query.data.scope ?? "mine";
    if (scope === "all" && !isAdmin) {
      return reply.code(403).send(error("PERMISSION_DENIED", "仅管理员可查看全站分享"));
    }
    return {
      shares: listShares({
        db: opts.db,
        userId: user.sub,
        isAdmin,
        scope,
        status: query.data.status ?? "active",
        conversationId: query.data.conversationId,
        reportId: query.data.reportId,
        dashboardId: query.data.dashboardId,
      }),
    };
  });

  app.post(
    "/api/shares",
    { preHandler: app.requirePermission("share.create") },
    async (request, reply) => {
      const body = createBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }

      const result = createShare({
        db: opts.db,
        userId: request.user!.sub,
        ...(body.data.conversationId !== undefined
          ? { conversationId: body.data.conversationId }
          : {}),
        ...(body.data.reportId !== undefined ? { reportId: body.data.reportId } : {}),
        ...(body.data.dashboardId !== undefined ? { dashboardId: body.data.dashboardId } : {}),
        ...(body.data.expiresInDays !== undefined
          ? { expiresInDays: body.data.expiresInDays }
          : {}),
        maxExpiresInDays: effectiveSettings(opts.db, opts.config).shareMaxDays,
      });
      if (!result.ok) {
        const status = ERROR_STATUS[result.code];
        return reply
          .code(status)
          .send(error(result.code, result.message));
      }
      return reply.code(201).send({ share: result.share });
    },
  );

  app.delete("/api/shares/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(error("VALIDATION", "参数不合法"));
    }
    const user = request.user!;
    const result = revokeShare({
      db: opts.db,
      shareId: params.data.id,
      userId: user.sub,
      role: user.role === "admin" ? "admin" : "user",
    });
    if (!result.ok) {
      return reply.code(404).send(error("NOT_FOUND", result.message));
    }
    return reply.code(204).send();
  });

  // Public and unauthenticated. The token is the capability; the body is whitelisted.
  app.get("/api/public/shares/:token", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const params = tokenParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(410).send(error("SHARE_GONE", "分享链接已过期或已撤销"));
    }
    const result = await resolveShare({
      db: opts.db,
      artifacts: opts.artifacts,
      token: params.data.token,
    });
    if (!result.ok) {
      return reply.code(410).send(error(result.code, result.message));
    }
    return result.share;
  });

  app.get("/api/public/shares/:token/reports/:reportId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const params = tokenReportParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(410).send(error("SHARE_GONE", "分享链接已过期或已撤销"));
    }
    const result = await resolveShareReport({
      db: opts.db,
      artifacts: opts.artifacts,
      token: params.data.token,
      reportId: params.data.reportId,
    });
    if (!result.ok) {
      return reply.code(410).send(error(result.code, result.message));
    }
    return result.share;
  });
}
