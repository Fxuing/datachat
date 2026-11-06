import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { listAudit } from "../db/repositories/audit.js";
import type { AuditAction, AuditStatus } from "../services/audit.js";

export interface AdminAuditRouteOptions {
  db: Db;
}

export const AUDIT_ACTIONS = [
  "query",
  "explain",
  "export",
  "login",
  "login_failed",
  "user_create",
  "user_update",
  "datasource_create",
  "datasource_update",
  "datasource_delete",
  "grant_update",
  "skill_change",
  "mcp_change",
] as const satisfies readonly AuditAction[];

export const AUDIT_STATUSES = ["ok", "rejected", "error", "timeout"] as const satisfies
  readonly AuditStatus[];

const MAX_PAGE_SIZE = 200;

/**
 * `from`/`to` accept epoch milliseconds or any ISO-8601 timestamp. A bare numeric
 * string is treated as milliseconds (not a year), matching the UI's date pickers.
 */
function parseBoundary(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }
  const value = Date.parse(raw);
  return Number.isNaN(value) ? null : value;
}

const listQuerySchema = z
  .object({
    userId: z.string().min(1).max(64).optional(),
    datasourceId: z.string().min(1).max(64).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    status: z.enum(AUDIT_STATUSES).optional(),
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine(
    (value) => {
      if (value.from === undefined || value.to === undefined) return true;
      const from = parseBoundary(value.from);
      const to = parseBoundary(value.to);
      return from === null || to === null || from <= to;
    },
    { message: "时间范围无效", path: ["from"] },
  );

export async function adminAuditRoutes(
  app: FastifyInstance,
  opts: AdminAuditRouteOptions,
): Promise<void> {
  const { db } = opts;

  app.get("/api/admin/audit", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION", message: "参数不合法", details: parsed.error.flatten() },
      });
    }
    const query = parsed.data;

    const from = query.from === undefined ? undefined : parseBoundary(query.from);
    const to = query.to === undefined ? undefined : parseBoundary(query.to);
    if (from === null || to === null) {
      return reply
        .code(400)
        .send({ error: { code: "VALIDATION", message: "时间范围无效" } });
    }

    return listAudit(db, {
      ...(query.userId !== undefined ? { userId: query.userId } : {}),
      ...(query.datasourceId !== undefined ? { datasourceId: query.datasourceId } : {}),
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      limit: query.limit,
      offset: query.offset,
    });
  });
}
