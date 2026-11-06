import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  createShare,
  resolveShare,
  revokeShare,
  SHARE_DEFAULT_EXPIRES_IN_DAYS,
  SHARE_MAX_EXPIRES_IN_DAYS,
  SHARE_MIN_EXPIRES_IN_DAYS,
  type ShareErrorCode,
} from "../services/shares.js";
import type { ArtifactStore } from "../services/artifacts.js";

export interface ShareRouteOptions {
  db: Db;
  artifacts: ArtifactStore;
}

const createBodySchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    reportId: z.string().uuid().optional(),
    expiresInDays: z
      .number()
      .int()
      .min(SHARE_MIN_EXPIRES_IN_DAYS)
      .max(SHARE_MAX_EXPIRES_IN_DAYS)
      .default(SHARE_DEFAULT_EXPIRES_IN_DAYS),
  })
  .refine(
    (value) => (value.conversationId === undefined) !== (value.reportId === undefined),
    { message: "必须且只能指定会话或报告" },
  );

const idParamsSchema = z.object({ id: z.string().uuid() });
const tokenParamsSchema = z.object({ token: z.string().min(1).max(512) });

const ERROR_STATUS: Record<ShareErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
};

function error(code: string, message: string) {
  return { error: { code, message } };
}

export async function shareRoutes(
  app: FastifyInstance,
  opts: ShareRouteOptions,
): Promise<void> {
  app.post("/api/shares", { preHandler: app.authenticate }, async (request, reply) => {
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
      expiresInDays: body.data.expiresInDays,
    });
    if (!result.ok) {
      const status = ERROR_STATUS[result.code];
      return reply
        .code(status)
        .send(error(status === 404 ? "NOT_FOUND" : "VALIDATION", result.message));
    }
    return reply.code(201).send({ share: result.share });
  });

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
}
