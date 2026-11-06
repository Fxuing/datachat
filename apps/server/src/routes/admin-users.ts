import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import {
  countActiveAdmins,
  DuplicateUsernameError,
  findUserById,
  findUserByUsername,
  insertUser,
  toPublicUser,
} from "../db/repositories/users.js";
import { hashPassword } from "../auth/password.js";
import { listGrantedUserIds, replaceGrants } from "../db/repositories/grants.js";
import { safeRecordAuditEvent } from "../services/audit.js";

class LastAdminError extends Error {}

const createUserSchema = z.object({
  username: z.string().trim().min(2).max(64),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().max(64).optional(),
  role: z.enum(["admin", "user"]).default("user"),
});

const updateUserSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  displayName: z.string().trim().max(64).nullable().optional(),
  password: z.string().min(8).max(200).optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

export async function adminUserRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;

  app.get("/api/admin/users", { preHandler: app.requireAdmin }, async () => {
    const rows = db.select().from(users).all();
    return { users: rows.map((row) => toPublicUser(row)) };
  });

  app.post("/api/admin/users", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION", message: "参数不合法", details: parsed.error.flatten() },
      });
    }
    const exists = findUserByUsername(db, parsed.data.username);
    if (exists) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: "用户名已存在" } });
    }
    let row: ReturnType<typeof insertUser>;
    try {
      row = insertUser(db, {
        id: randomUUID(),
        username: parsed.data.username,
        passwordHash: await hashPassword(parsed.data.password),
        role: parsed.data.role,
        displayName: parsed.data.displayName ?? null,
        createdAt: Date.now(),
      });
    } catch (error) {
      if (error instanceof DuplicateUsernameError) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "用户名已存在" } });
      }
      throw error;
    }
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser?.id ?? null,
      action: "user_create",
      targetUserId: row.id,
      ip: request.ip,
      detail: { username: row.username, role: row.role },
    });
    return reply.code(201).send({ user: toPublicUser(row) });
  });

  app.patch("/api/admin/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = updateUserSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const target = findUserById(db, params.data.id);
    if (!target) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "用户不存在" } });
    }

    const nextRole = body.data.role ?? target.role;
    const nextStatus = body.data.status ?? target.status;

    // An admin may edit their own profile, but not lock themselves out.
    if (target.id === request.user?.sub) {
      if (target.role === "admin" && nextRole !== "admin") {
        return reply
          .code(409)
          .send({ error: { code: "CONFLICT", message: "不能修改自己的管理员角色" } });
      }
      if (nextStatus === "disabled") {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "不能禁用自己的账号" } });
      }
    }

    // Never let the system end up without an active admin. Hashing happens
    // before the check, and the count + update run in one transaction so two
    // concurrent requests cannot both observe two admins and demote both.
    const removesActiveAdmin =
      target.role === "admin" &&
      target.status === "active" &&
      (nextRole !== "admin" || nextStatus !== "active");
    const nextPasswordHash = body.data.password
      ? await hashPassword(body.data.password)
      : target.passwordHash;
    if (removesActiveAdmin && countActiveAdmins(db) <= 1) {
      return reply
        .code(409)
        .send({ error: { code: "CONFLICT", message: "系统至少需要保留一名可用管理员" } });
    }

    try {
      db.transaction((tx) => {
        if (removesActiveAdmin && countActiveAdmins(tx) <= 1) {
          throw new LastAdminError();
        }
        tx.update(users)
          .set({
            role: nextRole,
            status: nextStatus,
            displayName:
              body.data.displayName === undefined ? target.displayName : body.data.displayName,
            passwordHash: nextPasswordHash,
          })
          .where(eq(users.id, target.id))
          .run();
      });
    } catch (error) {
      if (error instanceof LastAdminError) {
        return reply
          .code(409)
          .send({ error: { code: "CONFLICT", message: "系统至少需要保留一名可用管理员" } });
      }
      throw error;
    }
    const updated = findUserById(db, target.id)!;
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser?.id ?? null,
      action: "user_update",
      targetUserId: updated.id,
      ip: request.ip,
      detail: {
        username: updated.username,
        role: updated.role,
        status: updated.status,
        passwordChanged: Boolean(body.data.password),
      },
    });
    return { user: toPublicUser(updated) };
  });

  app.get(
    "/api/admin/datasources/:id/grants",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
      }
      return { userIds: listGrantedUserIds(db, params.data.id) };
    },
  );

  app.put(
    "/api/admin/datasources/:id/grants",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = z.object({ userIds: z.array(z.string().uuid()) }).safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
      }
      replaceGrants(db, params.data.id, body.data.userIds);
      safeRecordAuditEvent(db, {
        actorUserId: request.authUser?.id ?? null,
        action: "grant_update",
        datasourceId: params.data.id,
        ip: request.ip,
        detail: { userIds: body.data.userIds },
      });
      return { ok: true };
    },
  );
}
