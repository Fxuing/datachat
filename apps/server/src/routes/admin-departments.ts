import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  createDepartment,
  deleteDepartment,
  departmentMemberCounts,
  DepartmentError,
  listAllDepartmentGrants,
  listDepartmentGrants,
  listDepartmentMembers,
  listDepartments,
  listDepartmentTree,
  listUserDepartmentRows,
  moveDepartment,
  replaceDepartmentGrants,
  setUserDepartments,
  updateDepartment,
  type DepartmentNode,
} from "../db/repositories/departments.js";
import { findUserById } from "../db/repositories/users.js";
import { safeRecordAuditEvent } from "../services/audit.js";

export interface AdminDepartmentRouteOptions {
  db: Db;
}

const idParamsSchema = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  code: z.string().trim().min(1).max(32).optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  code: z.string().trim().min(1).max(32).optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const moveSchema = z.object({ parentId: z.string().uuid().nullable() });

const userDepartmentsSchema = z.object({
  departmentIds: z.array(z.string().uuid()).max(100),
  primaryId: z.string().uuid().nullable().optional(),
});

const grantsSchema = z.object({ datasourceIds: z.array(z.string().uuid()).max(200) });

const importSchema = z.object({
  departments: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(64),
        code: z.string().trim().min(1).max(32).optional(),
        parentCode: z.string().trim().min(1).max(32).optional(),
      }),
    )
    .min(1)
    .max(500),
});

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  PARENT_NOT_FOUND: 400,
  DATASOURCE_NOT_FOUND: 400,
  DUPLICATE_CODE: 409,
  HAS_CHILDREN: 409,
  HAS_MEMBERS: 409,
  SELF_PARENT: 400,
  CYCLE: 400,
  PRIMARY_NOT_MEMBER: 400,
  VALIDATION: 400,
};

function sendDepartmentError(
  reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
  error: DepartmentError,
) {
  const status = STATUS[error.code] ?? 400;
  return reply.code(status).send({ error: { code: error.code, message: error.message } });
}

function decorate(
  nodes: DepartmentNode[],
  counts: Map<string, number>,
  grants: Map<string, string[]>,
): unknown[] {
  return nodes.map((node) => ({
    ...node,
    memberCount: counts.get(node.id) ?? 0,
    datasourceIds: grants.get(node.id) ?? [],
    children: decorate(node.children, counts, grants),
  }));
}

export async function adminDepartmentRoutes(
  app: FastifyInstance,
  opts: AdminDepartmentRouteOptions,
): Promise<void> {
  const { db } = opts;
  const admin = app.requirePermission("admin.departments");

  const audit = (
    request: { authUser?: { id: string } | null; ip: string },
    detail: Record<string, unknown>,
  ): void => {
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser?.id ?? null,
      action: "department_change",
      ip: request.ip,
      detail,
    });
  };

  app.get("/api/admin/departments", { preHandler: admin }, async () => {
    return {
      departments: decorate(listDepartmentTree(db), departmentMemberCounts(db), listAllDepartmentGrants(db)),
      flat: listDepartments(db),
    };
  });

  app.post("/api/admin/departments", { preHandler: admin }, async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    try {
      const row = createDepartment(db, {
        name: body.data.name,
        ...(body.data.code !== undefined ? { code: body.data.code } : {}),
        ...(body.data.parentId !== undefined ? { parentId: body.data.parentId } : {}),
        ...(body.data.sortOrder !== undefined ? { sortOrder: body.data.sortOrder } : {}),
      });
      audit(request, { operation: "create", departmentId: row.id, name: row.name });
      return reply.code(201).send({ department: row });
    } catch (error) {
      if (error instanceof DepartmentError) return sendDepartmentError(reply, error);
      throw error;
    }
  });

  app.patch("/api/admin/departments/:id", { preHandler: admin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    try {
      const row = updateDepartment(db, params.data.id, body.data);
      audit(request, { operation: "update", departmentId: row.id, fields: Object.keys(body.data) });
      return { department: row };
    } catch (error) {
      if (error instanceof DepartmentError) return sendDepartmentError(reply, error);
      throw error;
    }
  });

  app.post("/api/admin/departments/:id/move", { preHandler: admin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = moveSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    try {
      const row = moveDepartment(db, params.data.id, body.data.parentId);
      audit(request, {
        operation: "move",
        departmentId: row.id,
        parentId: body.data.parentId,
      });
      return { department: row };
    } catch (error) {
      if (error instanceof DepartmentError) return sendDepartmentError(reply, error);
      throw error;
    }
  });

  app.delete("/api/admin/departments/:id", { preHandler: admin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    try {
      deleteDepartment(db, params.data.id);
      audit(request, { operation: "delete", departmentId: params.data.id });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof DepartmentError) return sendDepartmentError(reply, error);
      throw error;
    }
  });

  app.get("/api/admin/departments/:id/members", { preHandler: admin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    return { members: listDepartmentMembers(db, params.data.id) };
  });

  app.get("/api/admin/departments/:id/grants", { preHandler: admin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    return { datasourceIds: listDepartmentGrants(db, params.data.id) };
  });

  app.put("/api/admin/departments/:id/grants", { preHandler: admin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = grantsSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    try {
      replaceDepartmentGrants(db, params.data.id, body.data.datasourceIds);
      audit(request, {
        operation: "grants",
        departmentId: params.data.id,
        datasourceIds: body.data.datasourceIds,
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof DepartmentError) return sendDepartmentError(reply, error);
      throw error;
    }
  });

  app.get("/api/admin/users/:id/departments", { preHandler: admin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    return { departments: listUserDepartmentRows(db, params.data.id) };
  });

  app.put("/api/admin/users/:id/departments", { preHandler: admin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = userDepartmentsSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    if (!findUserById(db, params.data.id)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "用户不存在" } });
    }
    try {
      setUserDepartments(db, params.data.id, body.data.departmentIds, body.data.primaryId ?? undefined);
      audit(request, {
        operation: "membership",
        userId: params.data.id,
        departmentIds: body.data.departmentIds,
        primaryId: body.data.primaryId ?? null,
      });
      return { departments: listUserDepartmentRows(db, params.data.id) };
    } catch (error) {
      if (error instanceof DepartmentError) return sendDepartmentError(reply, error);
      throw error;
    }
  });

  app.post("/api/admin/departments/import", { preHandler: admin }, async (request, reply) => {
    const body = importSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const byCode = new Map<string, string>();
    for (const row of listDepartments(db)) {
      if (row.code) byCode.set(row.code, row.id);
    }
    let created = 0;
    const errors: string[] = [];
    for (const item of body.data.departments) {
      try {
        let parentId: string | null = null;
        if (item.parentCode) {
          const found = byCode.get(item.parentCode);
          if (!found) {
            errors.push(`${item.name}：父部门编码不存在（${item.parentCode}）`);
            continue;
          }
          parentId = found;
        }
        const row = createDepartment(db, {
          name: item.name,
          ...(item.code !== undefined ? { code: item.code } : {}),
          parentId,
        });
        created += 1;
        if (row.code) byCode.set(row.code, row.id);
      } catch (error) {
        errors.push(
          `${item.name}：${error instanceof DepartmentError ? error.message : String(error)}`,
        );
      }
    }
    audit(request, { operation: "import", created, errors: errors.length });
    return { created, errors };
  });
}
