import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { datasources, queryAudit, users } from "../db/schema.js";
import {
  coverageForDatasource,
  DataScopeError,
  deleteDepartmentMapping,
  importDepartmentMappings,
  listDepartmentMappings,
  listScopePolicies,
  policyCoverageForDatasource,
  replaceScopePolicies,
  type DepartmentMappingInput,
  type ExternalMappingField,
  type ScopePolicy,
} from "../db/repositories/data-scope.js";
import { loadSchema } from "../db/repositories/schema-cache.js";
import { listDepartments, listUserDepartmentRows } from "../db/repositories/departments.js";
import { resolveUserAccess } from "../auth/access.js";
import { findUserById } from "../db/repositories/users.js";
import { revokeSharesForDatasource } from "../services/shares.js";
import { importMappingsFromCsv } from "../services/scope-import.js";
import { applyScopeToSql } from "../services/data-scope.js";
import { safeRecordAuditEvent } from "../services/audit.js";

export interface AdminDataScopeRouteOptions {
  db: Db;
}

const idParams = z.object({ id: z.string().uuid() });

const ruleSchema = z.object({
  columnName: z.string().trim().min(1).max(128),
  operator: z.enum(["eq", "in", "not_in", "gt", "gte", "lt", "lte"]).optional(),
  valueMode: z
    .enum([
      "literal",
      "department_id",
      "department_code",
      "external_id",
      "external_code",
      "external_org_code",
      "user_id",
      "username",
      "role",
    ])
    .optional(),
  literalValues: z.array(z.string().trim().max(256)).max(100).optional(),
  nullVisible: z.boolean().optional(),
});

const policySchema = z.object({
  tableName: z.string().trim().min(1).max(128),
  mode: z.enum(["scoped", "public", "denied"]),
  enabled: z.boolean().optional(),
  rules: z.array(ruleSchema).max(20).optional(),
});

const policiesSchema = z.object({ policies: z.array(policySchema).max(500) });

const mappingSchema = z.object({
  departmentId: z.string().uuid().optional(),
  departmentCode: z.string().trim().min(1).max(32).optional(),
  externalId: z.string().trim().max(128).nullable().optional(),
  externalCode: z.string().trim().max(128).nullable().optional(),
  externalOrgCode: z.string().trim().max(128).nullable().optional(),
});

const mappingsSchema = z.object({
  mappings: z.array(mappingSchema).max(1000).optional(),
  csv: z.string().max(500_000).optional(),
});

const previewSchema = z.object({
  userId: z.string().uuid(),
  sql: z.string().trim().min(1).max(100_000),
});

const departmentCandidatePattern = /(dept|department|org|organization|app)[_A-Za-z]*(id|code)$/i;

function requiredExternalFields(policies: ScopePolicy[]): Set<ExternalMappingField> {
  const fields = new Set<ExternalMappingField>();
  for (const policy of policies) {
    if (!policy.enabled || policy.mode !== "scoped") continue;
    for (const rule of policy.rules) {
      if (rule.valueMode === "external_id") fields.add("externalId");
      else if (rule.valueMode === "external_code") fields.add("externalCode");
      else if (rule.valueMode === "external_org_code") fields.add("externalOrgCode");
    }
  }
  return fields;
}

function sendScopeError(
  reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
  code: string,
  message: string,
  status = 400,
) {
  return reply.code(status).send({ error: { code, message } });
}

export async function adminDataScopeRoutes(
  app: FastifyInstance,
  opts: AdminDataScopeRouteOptions,
): Promise<void> {
  const { db } = opts;
  const admin = app.requirePermission("admin.datasources");

  function requireDatasource(
    reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
    datasourceId: string,
  ) {
    const row = db.select().from(datasources).where(eq(datasources.id, datasourceId)).get();
    if (!row) {
      sendScopeError(reply, "NOT_FOUND", "数据源不存在", 404);
      return null;
    }
    return row;
  }

  function audit(
    request: { authUser?: { id: string } | null; ip: string },
    action: "data_scope_change" | "data_scope_enable",
    detail: Record<string, unknown>,
  ): void {
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser?.id ?? null,
      action,
      ip: request.ip,
      detail,
    });
  }

  app.get("/api/admin/datasources/:id/scope", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    const policies = listScopePolicies(db, datasource.id);
    const tables = loadSchema(db, datasource.id)?.tables.map((table) => table.name) ?? [];
    const activeDepartments = listDepartments(db).filter((row) => row.status === "active");
    const departmentIds = activeDepartments.map((row) => row.id);
    const departmentById = new Map(activeDepartments.map((row) => [row.id, row]));
    const requiredFields = requiredExternalFields(policies);
    const departmentCoverage = coverageForDatasource(
      db,
      datasource.id,
      departmentIds,
      requiredFields,
    );
    return {
      datasourceId: datasource.id,
      mode: datasource.dataScopeMode,
      policies,
      mappings: listDepartmentMappings(db, datasource.id),
      coverage: {
        policies: policyCoverageForDatasource(db, datasource.id, tables),
        departments: {
          ...departmentCoverage,
          unmappedDepartments: departmentCoverage.unmappedIds
            .map((id) => departmentById.get(id))
            .filter((row): row is NonNullable<typeof row> => Boolean(row))
            .map((row) => ({ id: row.id, name: row.name, code: row.code })),
        },
        schemaLoaded: tables.length > 0,
      },
    };
  });

  app.get("/api/admin/datasources/:id/scope/columns", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    const snapshot = loadSchema(db, datasource.id);
    if (!snapshot) {
      return sendScopeError(reply, "SCHEMA_NOT_CACHED", "数据源表结构尚未缓存，请先刷新", 409);
    }
    const tables = snapshot.tables.map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        comment: column.comment,
      })),
    }));
    const candidates: { table: string; column: string }[] = [];
    const autoMatched: {
      tableName: string;
      mode: "scoped";
      rules: {
        columnName: string;
        operator: "in";
        valueMode: "department_code" | "department_id";
        nullVisible: false;
      }[];
    }[] = [];
    const matchedTables = new Set<string>();
    for (const table of tables) {
      for (const column of table.columns) {
        if (departmentCandidatePattern.test(column.name)) {
          candidates.push({ table: table.name, column: column.name });
          if (!matchedTables.has(table.name)) {
            matchedTables.add(table.name);
            autoMatched.push({
              tableName: table.name,
              mode: "scoped",
              rules: [
                {
                  columnName: column.name,
                  operator: "in",
                  valueMode: /code/i.test(column.name) ? "department_code" : "department_id",
                  nullVisible: false,
                },
              ],
            });
          }
        }
      }
    }
    return {
      refreshedAt: snapshot.refreshedAt,
      tables,
      candidates,
      autoMatched,
    };
  });

  app.put("/api/admin/datasources/:id/scope/policies", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = policiesSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    try {
      replaceScopePolicies(
        db,
        datasource.id,
        body.data.policies.map((policy) => ({
          datasourceId: datasource.id,
          tableName: policy.tableName,
          mode: policy.mode,
          enabled: policy.enabled ?? true,
          rules: policy.rules ?? [],
        })),
      );
    } catch (error) {
      if (error instanceof DataScopeError) {
        return sendScopeError(reply, error.code, error.message, 400);
      }
      throw error;
    }
    audit(request, "data_scope_change", {
      operation: "policies",
      datasourceId: datasource.id,
      count: body.data.policies.length,
    });
    return { policies: listScopePolicies(db, datasource.id) };
  });

  app.get("/api/admin/datasources/:id/scope/mappings", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    const requiredFields = requiredExternalFields(listScopePolicies(db, datasource.id));
    return {
      mappings: listDepartmentMappings(db, datasource.id),
      coverage: coverageForDatasource(
        db,
        datasource.id,
        listDepartments(db).filter((row) => row.status === "active").map((row) => row.id),
        requiredFields,
      ),
    };
  });

  app.put("/api/admin/datasources/:id/scope/mappings", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = mappingsSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    if (!body.data.mappings && !body.data.csv) {
      return sendScopeError(reply, "VALIDATION", "缺少 mappings 或 csv");
    }
    const result = body.data.csv
      ? importMappingsFromCsv(db, datasource.id, body.data.csv)
      : importDepartmentMappings(db, datasource.id, body.data.mappings as DepartmentMappingInput[]);
    audit(request, "data_scope_change", {
      operation: "mappings",
      datasourceId: datasource.id,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors.length,
    });
    return result;
  });

  app.delete(
    "/api/admin/datasources/:id/scope/mappings/:departmentId",
    { preHandler: admin },
    async (request, reply) => {
      const params = idParams.extend({ departmentId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
      const datasource = requireDatasource(reply, params.data.id);
      if (!datasource) return;
      deleteDepartmentMapping(db, datasource.id, params.data.departmentId);
      audit(request, "data_scope_change", {
        operation: "mapping_delete",
        datasourceId: datasource.id,
        departmentId: params.data.departmentId,
      });
      return reply.code(204).send();
    },
  );

  app.post("/api/admin/datasources/:id/scope/preview", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = previewSchema.safeParse(request.body);
    if (!params.success || !body.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    const user = findUserById(db, body.data.userId);
    if (!user) return sendScopeError(reply, "NOT_FOUND", "用户不存在", 404);
    try {
      const applied = applyScopeToSql({
        db,
        datasourceId: datasource.id,
        // Preview answers "what happens if this is enabled", independent of the current mode.
        mode: "enabled",
        userId: user.id,
        sql: body.data.sql,
        dialect: datasource.type,
      });
      return applied;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "SCOPE_PREVIEW_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      return sendScopeError(reply, code, message, 400);
    }
  });

  app.get("/api/admin/datasources/:id/scope/diagnostics", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const query = z.object({ userId: z.string().uuid() }).safeParse(request.query);
    if (!params.success || !query.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    const user = findUserById(db, query.data.userId);
    if (!user) return sendScopeError(reply, "NOT_FOUND", "用户不存在", 404);

    const access = resolveUserAccess(db, user);
    const memberships = listUserDepartmentRows(db, user.id);
    const effective = access.departmentIds;
    const policies = listScopePolicies(db, datasource.id).filter((policy) => policy.enabled);
    const policyNames = new Set(policies.map((policy) => policy.tableName.toLowerCase()));
    const schemaTables = loadSchema(db, datasource.id)?.tables.map((table) => table.name) ?? [];
    const formatRule = (rule: ScopePolicy["rules"][number]) => ({
      column: rule.columnName,
      operator: rule.operator,
      valueMode: rule.valueMode,
      literalValues: rule.literalValues,
      nullVisible: rule.nullVisible,
    });
    // Table decisions describe the row boundary even when datasource access is missing;
    // the caller sees canAccessDatasource separately so both reasons stay visible.
    const tables = [
      ...policies.map((policy) => {
        if (access.isAdmin) {
          const literalRules =
            policy.mode === "scoped"
              ? policy.rules.filter((rule) => rule.valueMode === "literal")
              : [];
          if (literalRules.length > 0) {
            return {
              table: policy.tableName,
              decision: "scoped",
              rules: literalRules.map(formatRule),
            };
          }
          return { table: policy.tableName, decision: "admin_all" };
        }
        if (!effective || effective.size === 0) {
          return { table: policy.tableName, decision: "no_department" };
        }
        if (policy.mode === "denied") return { table: policy.tableName, decision: "denied" };
        if (policy.mode === "public") return { table: policy.tableName, decision: "public" };
        return {
          table: policy.tableName,
          decision: "scoped",
          rules: policy.rules.map(formatRule),
          departments: [...effective].sort(),
        };
      }),
      ...schemaTables
        .filter((name) => !policyNames.has(name.toLowerCase()))
        .map((table) => ({
          table,
          decision: access.isAdmin ? "admin_all" : "unconfigured",
        })),
    ];
    return {
      datasourceId: datasource.id,
      mode: datasource.dataScopeMode,
      userId: user.id,
      isAdmin: access.isAdmin,
      canAccessDatasource: access.isAdmin || (access.datasourceIds?.has(datasource.id) ?? false),
      departments: memberships,
      effectiveDepartmentIds: effective ? [...effective].sort() : null,
      tables,
    };
  });

  app.get("/api/admin/datasources/:id/scope/denials", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    const rows = db
      .select({
        id: queryAudit.id,
        userId: queryAudit.userId,
        username: users.username,
        action: queryAudit.action,
        scopeReason: queryAudit.scopeReason,
        sqlText: queryAudit.sqlText,
        createdAt: queryAudit.createdAt,
      })
      .from(queryAudit)
      .leftJoin(users, eq(users.id, queryAudit.userId))
      .where(
        and(
          eq(queryAudit.datasourceId, datasource.id),
          eq(queryAudit.status, "rejected"),
          isNotNull(queryAudit.scopeReason),
        ),
      )
      .orderBy(desc(queryAudit.createdAt))
      .limit(100)
      .all();
    return { denials: rows };
  });

  app.post("/api/admin/datasources/:id/scope/enable", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    const tables = loadSchema(db, datasource.id)?.tables.map((table) => table.name) ?? [];
    if (tables.length === 0) {
      return sendScopeError(reply, "SCOPE_COVERAGE_INCOMPLETE", "数据源表结构尚未缓存，无法核对覆盖", 409);
    }
    const coverage = policyCoverageForDatasource(db, datasource.id, tables);
    if (coverage.unclassified.length > 0) {
      return reply.code(409).send({
        error: {
          code: "SCOPE_COVERAGE_INCOMPLETE",
          message: "仍有未分类的表，不能启用",
          unclassified: coverage.unclassified,
        },
      });
    }
    const requiredFields = requiredExternalFields(listScopePolicies(db, datasource.id));
    if (requiredFields.size > 0) {
      const departmentIds = listDepartments(db)
        .filter((row) => row.status === "active")
        .map((row) => row.id);
      const mapping = coverageForDatasource(db, datasource.id, departmentIds, requiredFields);
      if (mapping.unmapped > 0) {
        return reply.code(409).send({
          error: {
            code: "SCOPE_COVERAGE_INCOMPLETE",
            message: "仍有部门未配置组织映射，不能启用",
            unmapped: mapping.unmappedIds,
          },
        });
      }
    }
    db.update(datasources)
      .set({ dataScopeMode: "enabled", updatedAt: Date.now() })
      .where(eq(datasources.id, datasource.id))
      .run();
    const revoked = revokeSharesForDatasource(db, datasource.id);
    audit(request, "data_scope_enable", { datasourceId: datasource.id, revokedShares: revoked });
    return { mode: "enabled", revokedShares: revoked };
  });

  app.post("/api/admin/datasources/:id/scope/disable", { preHandler: admin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return sendScopeError(reply, "VALIDATION", "参数不合法");
    const datasource = requireDatasource(reply, params.data.id);
    if (!datasource) return;
    db.update(datasources)
      .set({ dataScopeMode: "off", updatedAt: Date.now() })
      .where(eq(datasources.id, datasource.id))
      .run();
    audit(request, "data_scope_change", { operation: "disable", datasourceId: datasource.id });
    return { mode: "off" };
  });
}
