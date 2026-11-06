import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { loginSchema } from "@datachat/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { findUserByUsername, toPublicUser } from "../db/repositories/users.js";
import { verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE } from "../auth/guard.js";
import type { SessionSigner } from "../auth/jwt.js";

export interface AuthRouteOptions {
  config: AppConfig;
  db: Db;
  signer: SessionSigner;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const { config, db, signer } = opts;

  app.post(
    "/api/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: "VALIDATION", message: "用户名或密码格式不正确" } });
      }
      const user = findUserByUsername(db, parsed.data.username);
      if (!user || user.status !== "active") {
        return reply.code(401).send({ error: { code: "AUTH_FAILED", message: "用户名或密码错误" } });
      }
      const ok = await verifyPassword(user.passwordHash, parsed.data.password);
      if (!ok) {
        return reply.code(401).send({ error: { code: "AUTH_FAILED", message: "用户名或密码错误" } });
      }
      const token = await signer.sign({ sub: user.id, username: user.username, role: user.role });
      db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id)).run();
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProduction,
        path: "/",
        maxAge: 12 * 60 * 60,
      });
      return { user: toPublicUser(user) };
    },
  );

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => {
    const user = findUserByUsername(db, request.user!.username);
    if (!user) {
      return { user: null };
    }
    return { user: toPublicUser(user) };
  });
}
