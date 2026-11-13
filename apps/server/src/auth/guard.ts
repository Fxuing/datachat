import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PERMISSION_LABELS, type Permission } from "@datachat/shared";
import type { SessionSigner } from "./jwt.js";
import { resolveUserAccess } from "./access.js";
import type { Db } from "../db/client.js";
import { findUserById } from "../db/repositories/users.js";

export const SESSION_COOKIE = "dc_session";

/** 403 body for a missing permission; shared by `requirePermission` and handler-level gates. */
export function permissionDeniedBody(permission: Permission) {
  return {
    error: {
      code: "PERMISSION_DENIED",
      message: `缺少权限：${PERMISSION_LABELS[permission]}`,
      permission,
    },
  };
}

export interface AuthGuardOptions {
  signer: SessionSigner;
  db: Db;
}

export function registerAuthGuards(app: FastifyInstance, opts: AuthGuardOptions): void {
  const { signer, db } = opts;
  app.decorateRequest("user", undefined);
  app.decorateRequest("authUser", undefined);
  app.decorateRequest("access", undefined);

  app.decorate("authenticate", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
    }
    let payload;
    try {
      payload = await signer.verify(token);
    } catch {
      return reply
        .code(401)
        .send({ error: { code: "AUTH_REQUIRED", message: "登录已过期，请重新登录" } });
    }
    // Roles and status are re-read on every request so demotions, disables and
    // deletions take effect immediately instead of waiting for the 12h JWT TTL.
    const user = findUserById(db, payload.sub);
    if (!user || user.status !== "active") {
      return reply
        .code(401)
        .send({ error: { code: "AUTH_REQUIRED", message: "登录已失效，请重新登录" } });
    }
    request.authUser = user;
    request.user = { sub: user.id, username: user.username, role: user.role };
    request.access = resolveUserAccess(db, user);
  });

  app.decorate("requirePermission", (permission: Permission) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(request, reply);
      if (reply.sent) return;
      if (!request.access?.permissions.has(permission)) {
        return reply.code(403).send(permissionDeniedBody(permission));
      }
    };
  });

  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "需要管理员权限" } });
    }
  });
}
