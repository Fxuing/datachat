import type { FastifyInstance } from "fastify";
import type { SessionSigner } from "./jwt.js";

export const SESSION_COOKIE = "dc_session";

export function registerAuthGuards(app: FastifyInstance, signer: SessionSigner): void {
  app.decorateRequest("user", undefined);

  app.decorate("authenticate", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
    }
    try {
      request.user = await signer.verify(token);
    } catch {
      return reply
        .code(401)
        .send({ error: { code: "AUTH_REQUIRED", message: "登录已过期，请重新登录" } });
    }
  });

  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "需要管理员权限" } });
    }
  });
}
