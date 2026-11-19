import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  dataScopePolicies,
  dataScopeRules,
  departmentOrgMap,
  departments,
  datasources,
} from "../schema.js";

export const RULE_OPERATORS = ["eq", "in", "not_in", "gt", "gte", "lt", "lte"] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const VALUE_MODES = [
  "literal",
  "department_id",
  "department_code",
  "external_id",
  "external_code",
  "external_org_code",
  "user_id",
  "username",
  "role",
] as const;
export type ValueMode = (typeof VALUE_MODES)[number];

export const POLICY_MODES = ["scoped", "public", "denied"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

/** Operators that compare against a single value. */
const COMPARISON_OPERATORS: RuleOperator[] = ["gt", "gte", "lt", "lte"];
/** Value modes that can resolve to multiple values (department subtrees / multi-membership). */
const MULTI_VALUE_MODES = new Set<ValueMode>([
  "department_id",
  "department_code",
  "external_id",
  "external_code",
  "external_org_code",
]);

export class DataScopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DataScopeError";
  }
}

export interface ScopeRule {
  id: string;
  columnName: string;
  operator: RuleOperator;
  valueMode: ValueMode;
  literalValues: string[];
  nullVisible: boolean;
}

export interface ScopeRuleInput {
  columnName: string;
  operator?: RuleOperator;
  valueMode?: ValueMode;
  literalValues?: string[];
  nullVisible?: boolean;
}

export interface ScopePolicy {
  id: string;
  datasourceId: string;
  tableName: string;
  mode: PolicyMode;
  enabled: boolean;
  rules: ScopeRule[];
}

export interface ScopePolicyInput {
  datasourceId: string;
  tableName: string;
  mode: PolicyMode;
  enabled?: boolean;
  rules?: ScopeRuleInput[];
}

export interface DepartmentMapping {
  id: string;
  datasourceId: string;
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  externalId: string | null;
  externalCode: string | null;
  externalOrgCode: string | null;
  source: "manual" | "import";
}

export interface DepartmentMappingInput {
  departmentId?: string;
  departmentCode?: string;
  externalId?: string | null;
  externalCode?: string | null;
  externalOrgCode?: string | null;
}

function decodeLiteralValues(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function toRule(row: typeof dataScopeRules.$inferSelect): ScopeRule {
  return {
    id: row.id,
    columnName: row.columnName,
    operator: row.operator,
    valueMode: row.valueMode,
    literalValues: decodeLiteralValues(row.literalValuesJson),
    nullVisible: row.nullVisible === 1,
  };
}

function toPolicy(
  row: typeof dataScopePolicies.$inferSelect,
  rules: ScopeRule[],
): ScopePolicy {
  return {
    id: row.id,
    datasourceId: row.datasourceId,
    tableName: row.tableName,
    mode: row.mode,
    enabled: row.enabled === 1,
    rules,
  };
}

function requireDatasource(db: Db, datasourceId: string): void {
  const row = db
    .select({ id: datasources.id })
    .from(datasources)
    .where(eq(datasources.id, datasourceId))
    .get();
  if (!row) throw new DataScopeError("DATASOURCE_NOT_FOUND", "数据源不存在");
}

function normalizeTableName(tableName: string): string {
  const trimmed = tableName.trim();
  if (!trimmed) throw new DataScopeError("TABLE_REQUIRED", "表名不能为空");
  return trimmed;
}

function normalizeRule(input: ScopeRuleInput): Omit<ScopeRule, "id"> {
  const columnName = input.columnName?.trim();
  if (!columnName) {
    throw new DataScopeError("RULE_COLUMN_REQUIRED", "过滤条件必须选择字段");
  }
  const operator = input.operator ?? "eq";
  if (!RULE_OPERATORS.includes(operator)) {
    throw new DataScopeError("INVALID_OPERATOR", `invalid operator: ${String(operator)}`);
  }
  const valueMode = input.valueMode ?? "literal";
  if (!VALUE_MODES.includes(valueMode)) {
    throw new DataScopeError("INVALID_VALUE_MODE", `invalid value mode: ${String(valueMode)}`);
  }
  const literalValues = [
    ...new Set((input.literalValues ?? []).map((value) => value.trim()).filter(Boolean)),
  ];
  if (valueMode === "literal" && literalValues.length === 0) {
    throw new DataScopeError("LITERAL_REQUIRES_VALUE", `固定值条件 ${columnName} 必须填写值`);
  }
  if (COMPARISON_OPERATORS.includes(operator)) {
    if (valueMode !== "literal" || literalValues.length !== 1) {
      throw new DataScopeError(
        "COMPARE_REQUIRES_SINGLE_VALUE",
        `比较条件 ${columnName} 只支持一个固定值`,
      );
    }
  }
  if (operator === "eq") {
    if (MULTI_VALUE_MODES.has(valueMode)) {
      throw new DataScopeError(
        "EQ_REQUIRES_SINGLE_VALUE",
        `字段 ${columnName} 的部门/组织类取值可能包含多个值，请改用「属于（IN）」或「不属于（NOT IN）」`,
      );
    }
    if (valueMode === "literal" && literalValues.length !== 1) {
      throw new DataScopeError(
        "EQ_REQUIRES_SINGLE_VALUE",
        `等于条件 ${columnName} 只能填写一个固定值，多个值请改用「属于（IN）」`,
      );
    }
  }
  return {
    columnName,
    operator,
    valueMode,
    literalValues: valueMode === "literal" ? literalValues : [],
    nullVisible: input.nullVisible ?? false,
  };
}

function normalizePolicy(input: ScopePolicyInput): Omit<ScopePolicy, "id"> {
  const tableName = normalizeTableName(input.tableName);
  if (!POLICY_MODES.includes(input.mode)) {
    throw new DataScopeError("INVALID_MODE", `invalid policy mode: ${String(input.mode)}`);
  }
  const rules = input.mode === "scoped" ? (input.rules ?? []).map(normalizeRule) : [];
  if (input.mode === "scoped" && rules.length === 0) {
    throw new DataScopeError("SCOPED_REQUIRES_RULE", "按条件过滤至少需要一条规则");
  }
  return {
    datasourceId: input.datasourceId,
    tableName,
    mode: input.mode,
    enabled: input.enabled ?? true,
    rules: rules.map((rule, index) => ({ ...rule, id: `${index}` })),
  };
}

function insertRules(db: Db, policyId: string, rules: Omit<ScopeRule, "id">[], now: number): void {
  rules.forEach((rule, index) => {
    db.insert(dataScopeRules)
      .values({
        id: randomUUID(),
        policyId,
        sortOrder: index,
        columnName: rule.columnName,
        operator: rule.operator,
        valueMode: rule.valueMode,
        literalValuesJson:
          rule.valueMode === "literal" ? JSON.stringify(rule.literalValues) : null,
        nullVisible: rule.nullVisible ? 1 : 0,
        createdAt: now,
      })
      .run();
  });
}

export function upsertScopePolicy(db: Db, input: ScopePolicyInput): ScopePolicy {
  const policy = normalizePolicy(input);
  const existing = db
    .select()
    .from(dataScopePolicies)
    .where(
      and(
        eq(dataScopePolicies.datasourceId, policy.datasourceId),
        eq(dataScopePolicies.tableName, policy.tableName),
      ),
    )
    .get();
  if (!existing) requireDatasource(db, policy.datasourceId);
  const now = Date.now();
  const id = existing?.id ?? randomUUID();
  db.transaction((tx) => {
    const t = tx as unknown as Db;
    if (existing) {
      t.update(dataScopePolicies)
        .set({ mode: policy.mode, enabled: policy.enabled ? 1 : 0, updatedAt: now })
        .where(eq(dataScopePolicies.id, id))
        .run();
      t.delete(dataScopeRules).where(eq(dataScopeRules.policyId, id)).run();
    } else {
      t.insert(dataScopePolicies)
        .values({
          id,
          datasourceId: policy.datasourceId,
          tableName: policy.tableName,
          mode: policy.mode,
          enabled: policy.enabled ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    insertRules(t, id, policy.rules, now);
  });
  return findScopePolicy(db, policy.datasourceId, policy.tableName)!;
}

/** Replaces the whole policy set for a datasource (used by the wizard's bulk save). */
export function replaceScopePolicies(
  db: Db,
  datasourceId: string,
  inputs: Omit<ScopePolicyInput, "datasourceId">[],
): ScopePolicy[] {
  requireDatasource(db, datasourceId);
  const policies = inputs.map((input) => normalizePolicy({ ...input, datasourceId }));
  const seenTables = new Set<string>();
  for (const policy of policies) {
    const key = policy.tableName.toLowerCase();
    if (seenTables.has(key)) {
      throw new DataScopeError("DUPLICATE_TABLE", `表 ${policy.tableName} 重复配置`);
    }
    seenTables.add(key);
  }
  const now = Date.now();
  db.transaction((tx) => {
    const t = tx as unknown as Db;
    t.delete(dataScopePolicies).where(eq(dataScopePolicies.datasourceId, datasourceId)).run();
    for (const policy of policies) {
      const id = randomUUID();
      t.insert(dataScopePolicies)
        .values({
          id,
          datasourceId,
          tableName: policy.tableName,
          mode: policy.mode,
          enabled: policy.enabled ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      insertRules(t, id, policy.rules, now);
    }
  });
  return listScopePolicies(db, datasourceId);
}

export function deleteScopePolicy(db: Db, datasourceId: string, tableName: string): void {
  db.delete(dataScopePolicies)
    .where(
      and(
        eq(dataScopePolicies.datasourceId, datasourceId),
        eq(dataScopePolicies.tableName, tableName),
      ),
    )
    .run();
}

function rulesForPolicies(db: Db, policyIds: string[]): Map<string, ScopeRule[]> {
  const byPolicy = new Map<string, ScopeRule[]>();
  if (policyIds.length === 0) return byPolicy;
  const rows = db
    .select()
    .from(dataScopeRules)
    .where(inArray(dataScopeRules.policyId, policyIds))
    .orderBy(asc(dataScopeRules.sortOrder))
    .all();
  for (const row of rows) {
    const list = byPolicy.get(row.policyId) ?? [];
    list.push(toRule(row));
    byPolicy.set(row.policyId, list);
  }
  return byPolicy;
}

export function listScopePolicies(db: Db, datasourceId: string): ScopePolicy[] {
  const rows = db
    .select()
    .from(dataScopePolicies)
    .where(eq(dataScopePolicies.datasourceId, datasourceId))
    .orderBy(asc(dataScopePolicies.tableName))
    .all();
  const rules = rulesForPolicies(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toPolicy(row, rules.get(row.id) ?? []));
}

export function findScopePolicy(
  db: Db,
  datasourceId: string,
  tableName: string,
): ScopePolicy | undefined {
  const row = db
    .select()
    .from(dataScopePolicies)
    .where(
      and(
        eq(dataScopePolicies.datasourceId, datasourceId),
        eq(dataScopePolicies.tableName, tableName),
      ),
    )
    .get();
  if (!row) return undefined;
  return toPolicy(row, rulesForPolicies(db, [row.id]).get(row.id) ?? []);
}

function listMappingRows(db: Db, datasourceId: string): DepartmentMapping[] {
  return db
    .select({
      id: departmentOrgMap.id,
      datasourceId: departmentOrgMap.datasourceId,
      departmentId: departmentOrgMap.departmentId,
      departmentName: departments.name,
      departmentCode: departments.code,
      externalId: departmentOrgMap.externalId,
      externalCode: departmentOrgMap.externalCode,
      externalOrgCode: departmentOrgMap.externalOrgCode,
      source: departmentOrgMap.source,
    })
    .from(departmentOrgMap)
    .innerJoin(departments, eq(departments.id, departmentOrgMap.departmentId))
    .where(eq(departmentOrgMap.datasourceId, datasourceId))
    .all();
}

export function listDepartmentMappings(db: Db, datasourceId: string): DepartmentMapping[] {
  return listMappingRows(db, datasourceId);
}

function resolveMappingDepartment(db: Db, row: DepartmentMappingInput): string | null {
  if (row.departmentId) {
    const found = db
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, row.departmentId))
      .get();
    return found?.id ?? null;
  }
  if (row.departmentCode) {
    const found = db
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.code, row.departmentCode.trim()))
      .get();
    return found?.id ?? null;
  }
  return null;
}

function cleanExternal(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Inserts or updates mappings; invalid rows are reported instead of aborting the batch. */
export function importDepartmentMappings(
  db: Db,
  datasourceId: string,
  rows: DepartmentMappingInput[],
): { inserted: number; updated: number; errors: string[] } {
  requireDatasource(db, datasourceId);
  const errors: string[] = [];
  const seen = new Set<string>();
  let inserted = 0;
  let updated = 0;
  const now = Date.now();
  db.transaction((tx) => {
    rows.forEach((row, index) => {
      const label = row.departmentId ?? row.departmentCode ?? `第 ${index + 1} 行`;
      const departmentId = resolveMappingDepartment(tx as unknown as Db, row);
      if (!departmentId) {
        errors.push(`${label}: 部门不存在`);
        return;
      }
      if (seen.has(departmentId)) {
        errors.push(`${label}: 同一部门重复映射`);
        return;
      }
      seen.add(departmentId);
      const externalId = cleanExternal(row.externalId);
      const externalCode = cleanExternal(row.externalCode);
      const externalOrgCode = cleanExternal(row.externalOrgCode);
      if (!externalId && !externalCode && !externalOrgCode) {
        errors.push(`${label}: 至少填写一个外部值`);
        return;
      }
      const existing = tx
        .select({ id: departmentOrgMap.id })
        .from(departmentOrgMap)
        .where(
          and(
            eq(departmentOrgMap.datasourceId, datasourceId),
            eq(departmentOrgMap.departmentId, departmentId),
          ),
        )
        .get();
      if (existing) {
        tx.update(departmentOrgMap)
          .set({ externalId, externalCode, externalOrgCode, source: "import" })
          .where(eq(departmentOrgMap.id, existing.id))
          .run();
        updated += 1;
        return;
      }
      tx.insert(departmentOrgMap)
        .values({
          id: randomUUID(),
          datasourceId,
          departmentId,
          externalId,
          externalCode,
          externalOrgCode,
          source: "import",
          createdAt: now,
        })
        .run();
      inserted += 1;
    });
  });
  return { inserted, updated, errors };
}

export function deleteDepartmentMapping(
  db: Db,
  datasourceId: string,
  departmentId: string,
): void {
  db.delete(departmentOrgMap)
    .where(
      and(
        eq(departmentOrgMap.datasourceId, datasourceId),
        eq(departmentOrgMap.departmentId, departmentId),
      ),
    )
    .run();
}

export type ExternalMappingField = "externalId" | "externalCode" | "externalOrgCode";

/**
 * Mapping coverage over the supplied department ids (usually the active tree).
 * When `requiredFields` is provided, a department only counts as mapped if every
 * required external column is non-empty.
 */
export function coverageForDatasource(
  db: Db,
  datasourceId: string,
  departmentIds: string[],
  requiredFields?: ReadonlySet<ExternalMappingField>,
): { mapped: number; unmapped: number; unmappedIds: string[] } {
  const rows = db
    .select({
      departmentId: departmentOrgMap.departmentId,
      externalId: departmentOrgMap.externalId,
      externalCode: departmentOrgMap.externalCode,
      externalOrgCode: departmentOrgMap.externalOrgCode,
    })
    .from(departmentOrgMap)
    .where(eq(departmentOrgMap.datasourceId, datasourceId))
    .all();
  const mapped = new Set<string>();
  for (const row of rows) {
    if (requiredFields && requiredFields.size > 0) {
      let ok = true;
      for (const field of requiredFields) {
        if (!row[field]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    mapped.add(row.departmentId);
  }
  const unmappedIds = departmentIds.filter((id) => !mapped.has(id));
  return {
    mapped: departmentIds.length - unmappedIds.length,
    unmapped: unmappedIds.length,
    unmappedIds,
  };
}

/** Table classification coverage: every table must have an enabled policy. */
export function policyCoverageForDatasource(
  db: Db,
  datasourceId: string,
  tableNames: string[],
): { total: number; classified: number; unclassified: string[] } {
  const policies = listScopePolicies(db, datasourceId).filter((policy) => policy.enabled);
  const classified = new Set(policies.map((policy) => policy.tableName.toLowerCase()));
  const unclassified = tableNames.filter((table) => !classified.has(table.toLowerCase()));
  return { total: tableNames.length, classified: tableNames.length - unclassified.length, unclassified };
}

export function listPoliciesForTables(
  db: Db,
  datasourceId: string,
  tableNames: string[],
): ScopePolicy[] {
  if (tableNames.length === 0) return [];
  const rows = db
    .select()
    .from(dataScopePolicies)
    .where(
      and(
        eq(dataScopePolicies.datasourceId, datasourceId),
        inArray(dataScopePolicies.tableName, tableNames),
      ),
    )
    .all();
  const rules = rulesForPolicies(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toPolicy(row, rules.get(row.id) ?? []));
}
