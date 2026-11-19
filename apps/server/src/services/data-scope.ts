import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { departments } from "../db/schema.js";
import { loadSchema } from "../db/repositories/schema-cache.js";
import {
  departmentNameMap,
  effectiveDepartmentIds,
  listUserDepartments,
} from "../db/repositories/departments.js";
import {
  listDepartmentMappings,
  listScopePolicies,
  type DepartmentMapping,
  type ScopePolicy,
  type ScopeRule,
} from "../db/repositories/data-scope.js";
import type { SchemaSnapshot } from "../agent/datasource/introspect.js";
import {
  assertScopableSql,
  collectTableNames,
  normalizeTableName,
  rewriteSqlForScope,
  type ScopePlan,
  type ScopeTable,
  type SqlDialect,
} from "../agent/sql/scope.js";
import { findUserById } from "../db/repositories/users.js";

export type DataScopeMode = "off" | "configuring" | "enabled";

export type ScopeResolveCode =
  | "DATA_SCOPE_NO_DEPARTMENT"
  | "DATA_SCOPE_MAPPING_MISSING"
  | "DATA_SCOPE_TABLE_NOT_CONFIGURED"
  | "DATA_SCOPE_DENIED_TABLE"
  | "DATA_SCOPE_POLICY_STALE";

export class ScopeResolveError extends Error {
  constructor(
    readonly code: ScopeResolveCode,
    message: string,
  ) {
    super(message);
    this.name = "ScopeResolveError";
  }
}

/** Persisted on each run so history can be re-checked against later department moves. */
export interface ScopeSnapshot {
  v: 1;
  datasourceId: string;
  /** Empty means unrestricted (admin, or the datasource was not enforcing at run time). */
  departments: string[];
  /** Display names captured at run time; absent on snapshots written before this field. */
  departmentNames?: string[];
  /** Tables that actually received a row filter in this run. */
  scopedTables?: string[];
  policyHash: string;
}

export interface ResolveScopeInput {
  db: Db;
  datasourceId: string;
  mode: DataScopeMode;
  userId: string;
  isAdmin: boolean;
  tableNames: string[];
}

export interface ResolvedScope {
  plan: ScopePlan | null;
  snapshot: ScopeSnapshot;
}

function policyFingerprint(datasourceId: string, policies: ScopePolicy[]): string {
  const rows = policies
    .filter((policy) => policy.enabled)
    .map((policy) => {
      const rules = policy.rules
        .map((rule) =>
          [
            rule.columnName,
            rule.operator,
            rule.valueMode,
            rule.literalValues.join(","),
            rule.nullVisible ? "1" : "0",
          ].join("|"),
        )
        .join(";");
      return [policy.tableName, policy.mode, rules].join("|");
    })
    .sort();
  return createHash("sha256").update(`${datasourceId}\n${rows.join("\n")}`).digest("hex");
}

function departmentCodes(db: Db, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: departments.id, code: departments.code })
      .from(departments)
      .where(inArray(departments.id, ids))
      .all()
      .map((row) => [row.id, row.code]),
  );
}

function assertPolicyTarget(
  snapshot: SchemaSnapshot | null,
  tableName: string,
  columnName: string | null,
): void {
  if (!snapshot) return;
  const table = snapshot.tables.find(
    (candidate) => normalizeTableName(candidate.name) === normalizeTableName(tableName),
  );
  if (!table) {
    throw new ScopeResolveError(
      "DATA_SCOPE_POLICY_STALE",
      `表 ${tableName} 已不存在，请重新配置数据范围`,
    );
  }
  if (!columnName) return;
  const column = table.columns.find(
    (candidate) => normalizeTableName(candidate.name) === normalizeTableName(columnName),
  );
  if (!column) {
    throw new ScopeResolveError(
      "DATA_SCOPE_POLICY_STALE",
      `字段 ${tableName}.${columnName} 已不存在，请重新配置数据范围`,
    );
  }
}

function ruleValues(
  db: Db,
  departmentIds: string[],
  departmentNamesById: ReadonlyMap<string, string>,
  mappingsByDepartment: ReadonlyMap<string, DepartmentMapping>,
  rule: ScopeRule,
  user: { id: string; username: string; role: string } | undefined,
): string[] {
  switch (rule.valueMode) {
    case "literal":
      return rule.literalValues;
    case "department_id":
      return [...departmentIds];
    case "department_code": {
      const codes = departmentCodes(db, departmentIds);
      const values = departmentIds
        .map((id) => codes.get(id))
        .filter((code): code is string => Boolean(code));
      if (values.length !== departmentIds.length) {
        throw new ScopeResolveError(
          "DATA_SCOPE_MAPPING_MISSING",
          "存在没有编码的部门，无法按部门编码过滤",
        );
      }
      return values;
    }
    case "external_id":
    case "external_code":
    case "external_org_code": {
      const field =
        rule.valueMode === "external_id"
          ? "externalId"
          : rule.valueMode === "external_code"
            ? "externalCode"
            : "externalOrgCode";
      const values: string[] = [];
      const missing: string[] = [];
      for (const id of departmentIds) {
        const value = mappingsByDepartment.get(id)?.[field];
        if (value) values.push(value);
        else missing.push(departmentNamesById.get(id) ?? id);
      }
      if (missing.length > 0) {
        throw new ScopeResolveError(
          "DATA_SCOPE_MAPPING_MISSING",
          `部门 ${missing.join("、")} 未配置外部编码，无法过滤数据`,
        );
      }
      return values;
    }
    case "user_id":
      if (!user) throw new ScopeResolveError("DATA_SCOPE_POLICY_STALE", "当前用户不存在");
      return [user.id];
    case "username":
      if (!user) throw new ScopeResolveError("DATA_SCOPE_POLICY_STALE", "当前用户不存在");
      return [user.username];
    case "role":
      if (!user) throw new ScopeResolveError("DATA_SCOPE_POLICY_STALE", "当前用户不存在");
      return [user.role];
    default:
      throw new ScopeResolveError(
        "DATA_SCOPE_POLICY_STALE",
        `表 ${rule.columnName} 的取值方式已失效`,
      );
  }
}

/**
 * Builds the per-table plan for one user. `off`/`configuring` never filter;
 * `enabled` fails closed on missing departments, policies, or mappings.
 */
export function resolveScope(input: ResolveScopeInput): ResolvedScope {
  const { db, datasourceId, mode, userId, isAdmin } = input;
  const policies = listScopePolicies(db, datasourceId);
  const policyHash = policyFingerprint(datasourceId, policies);
  const policyByTable = new Map(
    policies.filter((policy) => policy.enabled).map((policy) => [normalizeTableName(policy.tableName), policy]),
  );

  if (mode !== "enabled") {
    return { plan: null, snapshot: { v: 1, datasourceId, departments: [], policyHash } };
  }

  const schemaSnapshot = loadSchema(db, datasourceId);

  if (isAdmin) {
    // Admins are exempt from department scoping, but literal rules are global
    // row constraints (for example is_deleted = 0) and still apply.
    const tables = new Map<string, ScopeTable>();
    let filtered = false;
    for (const tableName of input.tableNames) {
      const key = normalizeTableName(tableName);
      if (tables.has(key)) continue;
      const policy = policyByTable.get(key);
      const literalRules =
        policy?.mode === "scoped"
          ? policy.rules.filter((rule) => rule.valueMode === "literal")
          : [];
      if (literalRules.length === 0) {
        tables.set(key, { kind: "public" });
        continue;
      }
      const conditions = literalRules.map((rule) => {
        assertPolicyTarget(schemaSnapshot, tableName, rule.columnName);
        return {
          column: rule.columnName,
          operator: rule.operator,
          values: [...rule.literalValues].sort(),
          nullVisible: rule.nullVisible,
        };
      });
      filtered = true;
      tables.set(key, { kind: "scoped", conditions });
    }
    return filtered
      ? { plan: { tables }, snapshot: { v: 1, datasourceId, departments: [], policyHash } }
      : { plan: null, snapshot: { v: 1, datasourceId, departments: [], policyHash } };
  }

  const roots = listUserDepartments(db, userId);
  const effective = effectiveDepartmentIds(db, roots);
  if (effective.size === 0) {
    throw new ScopeResolveError(
      "DATA_SCOPE_NO_DEPARTMENT",
      "当前数据源已启用部门数据权限，但你还没有加入任何部门",
    );
  }
  const departmentIds = [...effective].sort();
  const namesById = departmentNameMap(db, departmentIds);
  const rootNames = roots
    .map((id) => namesById.get(id))
    .filter((name): name is string => Boolean(name));
  const departmentNames =
    rootNames.length > 0
      ? rootNames
      : departmentIds
          .map((id) => namesById.get(id))
          .filter((name): name is string => Boolean(name));
  const rangeLabel = departmentNames.join("、") || "未命名部门";

  const user = findUserById(db, userId);
  let mappingsByDepartment: Map<string, DepartmentMapping> | null = null;
  const getMappings = () => {
    if (!mappingsByDepartment) {
      mappingsByDepartment = new Map(
        listDepartmentMappings(db, datasourceId).map((row) => [row.departmentId, row]),
      );
    }
    return mappingsByDepartment;
  };

  const tables = new Map<string, ScopeTable>();
  for (const tableName of input.tableNames) {
    const key = normalizeTableName(tableName);
    if (tables.has(key)) continue;
    const policy = policyByTable.get(key);
    if (!policy) {
      throw new ScopeResolveError(
        "DATA_SCOPE_TABLE_NOT_CONFIGURED",
        `表 ${tableName} 未配置数据范围，已阻止查询（当前数据范围：${rangeLabel}）`,
      );
    }
    if (policy.mode === "denied") {
      throw new ScopeResolveError(
        "DATA_SCOPE_DENIED_TABLE",
        `表 ${tableName} 不允许访问（当前数据范围：${rangeLabel}）`,
      );
    }
    if (policy.mode === "public") {
      assertPolicyTarget(schemaSnapshot, tableName, null);
      tables.set(key, { kind: "public" });
      continue;
    }
    if (policy.rules.length === 0) {
      throw new ScopeResolveError(
        "DATA_SCOPE_POLICY_STALE",
        `表 ${tableName} 未配置有效过滤规则，请重新配置数据范围`,
      );
    }
    const conditions = policy.rules.map((rule) => {
      assertPolicyTarget(schemaSnapshot, tableName, rule.columnName);
      return {
        column: rule.columnName,
        operator: rule.operator,
        values: ruleValues(db, departmentIds, namesById, getMappings(), rule, user).sort(),
        nullVisible: rule.nullVisible,
      };
    });
    tables.set(key, { kind: "scoped", conditions });
  }

  return {
    plan: { tables },
    snapshot: {
      v: 1,
      datasourceId,
      departments: departmentIds,
      departmentNames,
      policyHash,
    },
  };
}

export interface AppliedScope {
  sql: string;
  params: string[];
  appliedTables: string[];
  snapshot: ScopeSnapshot;
}

/**
 * Resolves the viewer's plan and rewrites the statement in one step.
 * Never returns SQL for a table that the plan denies: errors propagate.
 */
export function applyScopeToSql(input: {
  db: Db;
  datasourceId: string;
  mode: DataScopeMode;
  userId: string;
  sql: string;
  dialect: SqlDialect;
}): AppliedScope {
  if (input.mode !== "enabled") {
    const policyHash = datasourcePolicyHashFrom(input.db, input.datasourceId);
    return {
      sql: input.sql,
      params: [],
      appliedTables: [],
      snapshot: { v: 1, datasourceId: input.datasourceId, departments: [], policyHash },
    };
  }
  const user = findUserById(input.db, input.userId);
  const isAdmin = user?.role === "admin";
  if (!isAdmin) {
    assertScopableSql(input.sql, input.dialect);
  }
  const scope = resolveScope({
    db: input.db,
    datasourceId: input.datasourceId,
    mode: input.mode,
    userId: input.userId,
    isAdmin,
    tableNames: collectTableNames(input.sql, input.dialect),
  });
  if (!scope.plan) {
    return { sql: input.sql, params: [], appliedTables: [], snapshot: scope.snapshot };
  }
  const rewritten = rewriteSqlForScope(input.sql, input.dialect, scope.plan);
  return { ...rewritten, snapshot: scope.snapshot };
}

/** Whether a stored run snapshot is still inside the viewer's current department subtree. */
export function isSnapshotVisible(
  snapshot: ScopeSnapshot | null,
  currentDepartments: Set<string> | null,
): boolean {
  if (currentDepartments === null) return true;
  if (!snapshot || snapshot.v !== 1) return false;
  // Empty departments belong to unrestricted runs (admin or pre-scope);
  // never expose them to non-admin viewers on a scoped datasource.
  if (snapshot.departments.length === 0) return false;
  return snapshot.departments.every((id) => currentDepartments.has(id));
}

export function parseScopeSnapshot(raw: string | null): ScopeSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ScopeSnapshot>;
    if (parsed.v !== 1 || typeof parsed.datasourceId !== "string") return null;
    if (!Array.isArray(parsed.departments) || parsed.departments.some((id) => typeof id !== "string")) {
      return null;
    }
    return {
      v: 1,
      datasourceId: parsed.datasourceId,
      departments: parsed.departments,
      ...(Array.isArray(parsed.departmentNames) &&
      parsed.departmentNames.every((name) => typeof name === "string")
        ? { departmentNames: parsed.departmentNames }
        : {}),
      ...(Array.isArray(parsed.scopedTables) &&
      parsed.scopedTables.every((table) => typeof table === "string")
        ? { scopedTables: parsed.scopedTables }
        : {}),
      policyHash: typeof parsed.policyHash === "string" ? parsed.policyHash : "",
    };
  } catch {
    return null;
  }
}

/** Department ids for a user regardless of datasource mode (used by the share/run guards). */
export function userDepartmentScope(db: Db, userId: string): Set<string> {
  return effectiveDepartmentIds(db, listUserDepartments(db, userId));
}

export function departmentCodesFor(db: Db, ids: string[]): Map<string, string> {
  return departmentCodes(db, ids);
}

export function datasourcePolicyHashFrom(db: Db, datasourceId: string): string {
  return policyFingerprint(datasourceId, listScopePolicies(db, datasourceId));
}
