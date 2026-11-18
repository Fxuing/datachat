import sqlParser, { type AST } from "node-sql-parser";

const { Parser } = sqlParser;

export type SqlDialect = "mysql" | "postgres";

export type ScopeOperator = "eq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte";

/** One AND-ed filter condition. Values are already resolved for the current user. */
export interface ScopeCondition {
  column: string;
  operator: ScopeOperator;
  values: string[];
  nullVisible: boolean;
}

export type ScopeTable =
  | { kind: "public" }
  | { kind: "denied" }
  | { kind: "scoped"; conditions: ScopeCondition[] };

/** Per-table decisions for one datasource and one user. */
export interface ScopePlan {
  tables: Map<string, ScopeTable>;
}

export class ScopeRewriteError extends Error {
  constructor(
    readonly code:
      | "SCOPE_REWRITE_FAILED"
      | "DATA_SCOPE_TABLE_NOT_CONFIGURED"
      | "DATA_SCOPE_DENIED_TABLE",
    message: string,
  ) {
    super(message);
    this.name = "ScopeRewriteError";
  }
}

/** Strips identifier quotes and folds case so plans match parsed references. */
export function normalizeTableName(name: string): string {
  return name.replace(/^[`"[]+|[`"\]]+$/g, "").trim().toLowerCase();
}

function databaseFor(dialect: SqlDialect): string {
  return dialect === "mysql" ? "mysql" : "postgresql";
}

function parseSql(sql: string, dialect: SqlDialect): Record<string, unknown> {
  try {
    const parsed = new Parser().astify(sql, { database: databaseFor(dialect) });
    if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
      throw new Error("只支持单条语句");
    }
    return parsed as unknown as Record<string, unknown>;
  } catch (error) {
    throw new ScopeRewriteError(
      "SCOPE_REWRITE_FAILED",
      `无法解析 SQL：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface AstNode {
  [key: string]: unknown;
}

function isSelectNode(node: unknown): node is AstNode {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as AstNode).type === "select" &&
    Array.isArray((node as AstNode).from)
  );
}

function cteName(cte: AstNode): string | null {
  const name = cte.name;
  if (typeof name === "string") return normalizeTableName(name);
  if (name && typeof name === "object") {
    const value = (name as AstNode).value;
    if (typeof value === "string") return normalizeTableName(value);
  }
  return null;
}

function cteStatement(cte: AstNode): unknown {
  const stmt = cte.stmt;
  if (stmt && typeof stmt === "object" && "ast" in (stmt as AstNode)) {
    return (stmt as AstNode).ast;
  }
  return stmt;
}

function withNames(select: AstNode, inherited: Set<string>): Set<string> {
  const names = new Set(inherited);
  const withClause = select.with;
  if (Array.isArray(withClause)) {
    for (const cte of withClause) {
      if (cte && typeof cte === "object") {
        const name = cteName(cte as AstNode);
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/** Visits every select node, including CTE bodies, derived tables, unions, and nested subqueries. */
function walkSelects(node: unknown, visit: (select: AstNode) => void, seen = new WeakSet<object>()): void {
  if (Array.isArray(node)) {
    for (const item of node) walkSelects(item, visit, seen);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  if (seen.has(node)) return;
  seen.add(node);
  if (isSelectNode(node)) visit(node);
  for (const value of Object.values(node as AstNode)) walkSelects(value, visit, seen);
}

/** Physical table references in a statement, excluding CTE names and derived-table aliases. */
export function collectTableNames(sql: string, dialect: SqlDialect): string[] {
  const ast = parseSql(sql, dialect);
  const found = new Set<string>();
  walkSelects(ast, (select) => {
    const ctes = withNames(select, new Set());
    const from = select.from as AstNode[];
    for (const entry of from) {
      if (!entry || typeof entry !== "object") continue;
      const table = entry.table;
      if (typeof table !== "string") continue;
      const name = normalizeTableName(table);
      if (ctes.has(name)) continue;
      found.add(name);
    }
  });
  return [...found];
}

interface RewriteContext {
  dialect: SqlDialect;
  plan: ScopePlan;
  params: string[];
  applied: Set<string>;
  paramIndex: number;
}

function rewriteNested(value: unknown, ctx: RewriteContext, ctes: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteNested(item, ctx, ctes);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (isSelectNode(value)) {
    rewriteSelect(value, ctx, ctes);
    return;
  }
  for (const child of Object.values(value as AstNode)) rewriteNested(child, ctx, ctes);
}

function placeholders(values: string[], ctx: RewriteContext): AstNode[] {
  return values.map((value) => {
    ctx.params.push(value);
    if (ctx.dialect === "postgres") {
      ctx.paramIndex += 1;
      return { type: "origin", value: `$${ctx.paramIndex}` };
    }
    return { type: "origin", value: "?" };
  });
}

const COMPARISON_SQL: Partial<Record<ScopeOperator, string>> = {
  eq: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

function allRowsNode(): AstNode {
  return {
    type: "binary_expr",
    operator: "=",
    left: { type: "number", value: 1 },
    right: { type: "number", value: 1 },
  };
}

function noRowsNode(): AstNode {
  return {
    type: "binary_expr",
    operator: "=",
    left: { type: "number", value: 1 },
    right: { type: "number", value: 0 },
  };
}

/** Builds one condition; `null` means the condition imposes no restriction. */
function buildCondition(condition: ScopeCondition, ctx: RewriteContext): AstNode | null {
  const columnRef = { type: "column_ref", table: null, column: condition.column, collate: null };
  const comparison = COMPARISON_SQL[condition.operator];
  let expr: AstNode;
  if (comparison) {
    const [value] = condition.values;
    if (value === undefined) return noRowsNode();
    expr = {
      type: "binary_expr",
      operator: comparison,
      left: columnRef,
      right: placeholders([value], ctx)[0],
    };
  } else if (condition.operator === "in" || condition.operator === "not_in") {
    if (condition.values.length === 0) {
      return condition.operator === "in" ? noRowsNode() : null;
    }
    expr = {
      type: "binary_expr",
      operator: condition.operator === "in" ? "IN" : "NOT IN",
      left: columnRef,
      right: { type: "expr_list", value: placeholders(condition.values, ctx) },
    };
  } else {
    return noRowsNode();
  }
  if (!condition.nullVisible) return expr;
  return {
    type: "binary_expr",
    operator: "OR",
    left: expr,
    right: {
      type: "binary_expr",
      operator: "IS",
      left: { ...columnRef },
      right: { type: "null", value: null },
    },
    parentheses: true,
  };
}

function combineConditions(conditions: AstNode[]): AstNode {
  if (conditions.length === 0) return allRowsNode();
  return conditions.reduce((left, right) => ({
    type: "binary_expr",
    operator: "AND",
    left,
    right,
  }));
}

function wrapScopedTable(
  entry: AstNode,
  tableName: string,
  policy: Extract<ScopeTable, { kind: "scoped" }>,
  ctx: RewriteContext,
): void {
  const conditions = policy.conditions
    .map((condition) => buildCondition(condition, ctx))
    .filter((node): node is AstNode => node !== null);
  const where = combineConditions(conditions);

  const template = parseSql("select * from __datachat_scope__ where 1 = 1", ctx.dialect);
  template.from = [{ table: entry.table, db: entry.db ?? null, as: null }];
  template.where = where;

  entry.expr = { ast: template, parentheses: true };
  entry.as = entry.as ?? entry.table;
  delete entry.table;
  delete entry.db;
  ctx.applied.add(tableName);
}

function rewriteEntry(entry: AstNode, ctx: RewriteContext, ctes: Set<string>): void {
  if (entry.expr && typeof entry.expr === "object") {
    const inner = (entry.expr as AstNode).ast;
    if (inner) rewriteNested(inner, ctx, ctes);
  }
  if (entry.on) rewriteNested(entry.on, ctx, ctes);
  if (typeof entry.table !== "string") return;

  const name = normalizeTableName(entry.table);
  if (ctes.has(name)) return;
  const policy = ctx.plan.tables.get(name);
  if (!policy) {
    throw new ScopeRewriteError(
      "DATA_SCOPE_TABLE_NOT_CONFIGURED",
      `表 ${entry.table} 未配置数据范围`,
    );
  }
  if (policy.kind === "denied") {
    throw new ScopeRewriteError("DATA_SCOPE_DENIED_TABLE", `表 ${entry.table} 不允许访问`);
  }
  if (policy.kind === "public") return;
  wrapScopedTable(entry, name, policy, ctx);
}

function rewriteSelect(select: AstNode, ctx: RewriteContext, inherited: Set<string>): void {
  const ctes = withNames(select, inherited);
  const withClause = select.with;
  if (Array.isArray(withClause)) {
    for (const cte of withClause) {
      if (cte && typeof cte === "object") rewriteNested(cteStatement(cte as AstNode), ctx, ctes);
    }
  }
  const from = select.from as AstNode[];
  for (const entry of from) {
    if (entry && typeof entry === "object") rewriteEntry(entry, ctx, ctes);
  }
  for (const [key, value] of Object.entries(select)) {
    if (key === "from" || key === "with" || key === "_next") continue;
    rewriteNested(value, ctx, ctes);
  }
  if (select._next) {
    const nexts = Array.isArray(select._next) ? select._next : [select._next];
    for (const next of nexts) rewriteNested(next, ctx, ctes);
  }
}

/**
 * Rewrites every scoped table into a filtered derived table and returns bound params
 * in positional order. Throws when a referenced table has no usable policy.
 */
export function rewriteSqlForScope(
  sql: string,
  dialect: SqlDialect,
  plan: ScopePlan,
): { sql: string; params: string[]; appliedTables: string[] } {
  const ast = parseSql(sql, dialect);
  const ctx: RewriteContext = {
    dialect,
    plan,
    params: [],
    applied: new Set(),
    paramIndex: 0,
  };
  rewriteNested(ast, ctx, new Set());
  let rewritten: string;
  try {
    rewritten = new Parser().sqlify(ast as unknown as AST, { database: databaseFor(dialect) });
  } catch (error) {
    throw new ScopeRewriteError(
      "SCOPE_REWRITE_FAILED",
      `无法序列化 SQL：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { sql: rewritten, params: ctx.params, appliedTables: [...ctx.applied] };
}
