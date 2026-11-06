import type { FastifyInstance } from "fastify";
import type { SessionSigner } from "./jwt.js";
import type { Db } from "../db/client.js";
import { findUserById } from "../db/repositories/users.js";

export const SESSION_COOKIE = "dc_session";

export interface AuthGuardOptions {
  signer: SessionSigner;
  db: Db;
}

export function registerAuthGuards(app: FastifyInstance, opts: AuthGuardOptions): void {
  const { signer, db } = opts;
  app.decorateRequest("user", undefined);
  app.decorateRequest("authUser", undefined);

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
  });

  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "需要管理员权限" } });
    }
  });
}
