import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isPermission, isSystemPermission } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { findDatasource } from "../db/repositories/datasources.js";
import { isUniqueViolation } from "../db/repositories/users.js";
import {
  createRole,
  deleteRole,
  findRole,
  findRoleByName,
  listRoles,
  replaceRoleDatasources,
  replaceRolePermissions,
  roleDetail,
  updateRole,
  type RoleRow,
} from "../db/repositories/roles.js";
import { safeRecordAuditEvent } from "../services/audit.js";

const permissionsSchema = z.array(z.string()).max(20);
const roleInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).nullable().optional(),
  permissions: permissionsSchema,
  datasourceIds: z.array(z.string().uuid()).max(200),
});
const rolePatchSchema = roleInputSchema.partial();
const idParamsSchema = z.object({ id: z.string().min(1).max(64) });

interface ApiError {
  code: string;
  message: string;
}

/** Unknown permissions are a client bug; system permissions are admin-only. */
function permissionError(permissions: string[]): ApiError | null {
  for (const permission of permissions) {
    if (!isPermission(permission)) {
      return { code: "VALIDATION", message: `未知权限：${permission}` };
    }
    if (isSystemPermission(permission)) {
      return { code: "SYSTEM_PERMISSION_NOT_ALLOWED", message: "自定义角色不能包含系统权限" };
    }
  }
  return null;
}

function missingDatasource(datasourceIds: string[], db: Db): ApiError | null {
  const missing = datasourceIds.find((id) => !findDatasource(db, id));
  return missing
    ? { code: "DATASOURCE_NOT_FOUND", message: `数据源不存在：${missing}` }
    : null;
}

export async function adminRoleRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const preHandler = app.requirePermission("admin.roles");

  app.get("/api/admin/roles", { preHandler }, async () => ({
    roles: listRoles(db).map((role) => ({ ...role, isBuiltin: role.builtin === 1 })),
  }));

  app.get("/api/admin/roles/:id", { preHandler }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const role = roleDetail(db, params.data.id);
    if (!role) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "角色不存在" } });
    }
    return { role: role };
  });

  app.post("/api/admin/roles", { preHandler }, async (request, reply) => {
    const parsed = roleInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const invalidPermission = permissionError(parsed.data.permissions);
    if (invalidPermission) {
      return reply.code(400).send({ error: invalidPermission });
    }
    const missing = missingDatasource(parsed.data.datasourceIds, db);
    if (missing) {
      return reply.code(400).send({ error: missing });
    }
    if (findRoleByName(db, parsed.data.name)) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: "角色名称已存在" } });
    }

    let role: RoleRow;
    try {
      role = createRole(db, parsed.data);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "角色名称已存在" } });
      }
      throw error;
    }

    const detail = roleDetail(db, role.id)!;
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser!.id,
      action: "role_change",
      ip: request.ip,
      sqlText: `role:${role.name}`,
      detail: {
        roleId: role.id,
        action: "create",
        permissions: detail.permissions,
        datasourceIds: detail.datasourceIds,
      },
    });
    return reply.code(201).send({ role: detail });
  });

  app.patch("/api/admin/roles/:id", { preHandler }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = rolePatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const role = findRole(db, params.data.id);
    if (!role) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "角色不存在" } });
    }
    // The built-in member role is editable, but its identity is fixed.
    if (body.data.name !== undefined && body.data.name !== role.name && role.builtin === 1) {
      return reply.code(400).send({ error: { code: "BUILTIN_ROLE", message: "内置角色不可改名" } });
    }
    if (body.data.permissions) {
      const invalidPermission = permissionError(body.data.permissions);
      if (invalidPermission) {
        return reply.code(400).send({ error: invalidPermission });
      }
    }
    if (body.data.datasourceIds) {
      const missing = missingDatasource(body.data.datasourceIds, db);
      if (missing) {
        return reply.code(400).send({ error: missing });
      }
    }
    if (body.data.name !== undefined && body.data.name !== role.name) {
      if (findRoleByName(db, body.data.name)) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "角色名称已存在" } });
      }
    }

    try {
      db.transaction((tx) => {
        if (body.data.name !== undefined || body.data.description !== undefined) {
          updateRole(tx, role.id, {
            name: body.data.name,
            description: body.data.description,
          });
        }
        if (body.data.permissions) {
          replaceRolePermissions(tx, role.id, body.data.permissions);
        }
        if (body.data.datasourceIds) {
          replaceRoleDatasources(tx, role.id, body.data.datasourceIds);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "角色名称已存在" } });
      }
      throw error;
    }

    const detail = roleDetail(db, role.id)!;
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser!.id,
      action: "role_change",
      ip: request.ip,
      sqlText: `role:${detail.name}`,
      detail: {
        roleId: detail.id,
        action: "update",
        permissions: detail.permissions,
        datasourceIds: detail.datasourceIds,
      },
    });
    return { role: detail };
  });

  app.delete("/api/admin/roles/:id", { preHandler }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const role = findRole(db, params.data.id);
    if (!role) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "角色不存在" } });
    }
    if (role.builtin === 1) {
      return reply.code(400).send({ error: { code: "BUILTIN_ROLE", message: "内置角色不可删除" } });
    }
    const detail = roleDetail(db, role.id)!;
    deleteRole(db, role.id);
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser!.id,
      action: "role_change",
      ip: request.ip,
      sqlText: `role:${role.name}`,
      detail: {
        roleId: role.id,
        action: "delete",
        permissions: detail.permissions,
        datasourceIds: detail.datasourceIds,
      },
    });
    return { ok: true };
  });
}
