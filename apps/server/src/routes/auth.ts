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
import { safeRecordAuditEvent } from "../services/audit.js";

export interface AuthRouteOptions {
  config: AppConfig;
  db: Db;
  signer: SessionSigner;
}

/**
 * Valid Argon2id hash used when the username does not exist. Verifying against
 * it keeps the unknown-user path roughly as expensive as a real password check.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$NysYmsmDtseTJhNPHSzxyg$2dP3ZASJhU4UT7T2Qf3Hc4OxO+3iD9MbbBwMVco2e3k";

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
      const ok = await verifyPassword(
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        parsed.data.password,
      );
      if (!user || user.status !== "active" || !ok) {
        safeRecordAuditEvent(db, {
          actorUserId: user?.id ?? null,
          action: "login_failed",
          status: "rejected",
          targetUserId: user?.id ?? null,
          ip: request.ip,
          detail: { username: parsed.data.username },
        });
        return reply.code(401).send({ error: { code: "AUTH_FAILED", message: "用户名或密码错误" } });
      }
      const token = await signer.sign({ sub: user.id, username: user.username, role: user.role });
      db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id)).run();
      safeRecordAuditEvent(db, {
        actorUserId: user.id,
        action: "login",
        status: "ok",
        targetUserId: user.id,
        ip: request.ip,
      });
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
    return { user: toPublicUser(request.authUser!) };
  });
}
