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
  return typeof node === "object" && node !== null && (node as AstNode).type === "select";
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

/**
 * Walks an AST while maintaining accurate CTE visibility:
 * - Non-recursive CTEs cannot shadow a physical table inside their own body.
 * - Recursive CTEs only see themselves in the UNION recursive branch (`_next`),
 *   never in the anchor term.
 * - Inner subqueries, derived tables, and UNION branches inherit outer CTEs.
 */
function walkWithCtes(
  node: unknown,
  inherited: ReadonlySet<string>,
  onFromEntry: (entry: AstNode, visibleCtes: ReadonlySet<string>) => void,
  seen = new WeakSet<object>(),
): void {
  if (Array.isArray(node)) {
    for (const item of node) walkWithCtes(item, inherited, onFromEntry, seen);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (isSelectNode(node)) {
    const visible = new Set(inherited);
    const withClause = node.with;
    if (Array.isArray(withClause)) {
      const recursive = withClause.some(
        (cte) => Boolean(cte && typeof cte === "object" && (cte as AstNode).recursive),
      );
      for (const cte of withClause) {
        if (!cte || typeof cte !== "object") continue;
        const name = cteName(cte as AstNode);
        const stmt = cteStatement(cte as AstNode);
        if (recursive && name && isSelectNode(stmt) && stmt._next) {
          // Anchor term cannot reference the CTE itself; only the recursive branch can.
          walkSelectBody(stmt, visible, onFromEntry, seen, false);
          visible.add(name);
          const nexts = Array.isArray(stmt._next) ? stmt._next : [stmt._next];
          for (const next of nexts) walkWithCtes(next, visible, onFromEntry, seen);
        } else {
          walkWithCtes(stmt, visible, onFromEntry, seen);
          if (name) visible.add(name);
        }
      }
    }
    walkSelectBody(node, visible, onFromEntry, seen, true);
    return;
  }

  for (const value of Object.values(node as AstNode)) {
    walkWithCtes(value, inherited, onFromEntry, seen);
  }
}

function walkSelectBody(
  select: AstNode,
  visible: ReadonlySet<string>,
  onFromEntry: (entry: AstNode, visibleCtes: ReadonlySet<string>) => void,
  seen: WeakSet<object>,
  includeNext: boolean,
): void {
  const from = Array.isArray(select.from) ? (select.from as AstNode[]) : [];
  for (const entry of from) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.expr && typeof entry.expr === "object") {
      const inner = (entry.expr as AstNode).ast;
      if (inner) walkWithCtes(inner, visible, onFromEntry, seen);
    } else {
      onFromEntry(entry, visible);
    }
    if (entry.on) walkWithCtes(entry.on, visible, onFromEntry, seen);
  }
  for (const [key, value] of Object.entries(select)) {
    if (key === "from" || key === "with" || key === "_next") continue;
    walkWithCtes(value, visible, onFromEntry, seen);
  }
  if (includeNext && select._next) {
    const nexts = Array.isArray(select._next) ? select._next : [select._next];
    for (const next of nexts) walkWithCtes(next, visible, onFromEntry, seen);
  }
}

function isScopableRoot(ast: Record<string, unknown>): boolean {
  const type = String(ast.type ?? "").toLowerCase();
  if (type === "select") return true;
  if (type === "explain") {
    const hasSelect = (node: unknown, seen = new WeakSet<object>()): boolean => {
      if (Array.isArray(node)) return node.some((item) => hasSelect(item, seen));
      if (typeof node !== "object" || node === null || seen.has(node)) return false;
      seen.add(node);
      if (isSelectNode(node)) return true;
      return Object.values(node as AstNode).some((value) => hasSelect(value, seen));
    };
    return hasSelect(ast);
  }
  return false;
}

/** Rejects metadata statements like SHOW / DESC that cannot be row-scoped. */
export function assertScopableSql(sql: string, dialect: SqlDialect): void {
  const ast = parseSql(sql, dialect);
  if (!isScopableRoot(ast)) {
    throw new ScopeRewriteError(
      "SCOPE_REWRITE_FAILED",
      "受控数据源不允许执行 SHOW / DESC 等元数据语句，请使用表结构工具或 SELECT 查询",
    );
  }
}

/** Physical table references in a statement, excluding CTE names and derived-table aliases. */
export function collectTableNames(sql: string, dialect: SqlDialect): string[] {
  const ast = parseSql(sql, dialect);
  const found = new Set<string>();
  walkWithCtes(ast, new Set(), (entry, ctes) => {
    const table = entry.table;
    if (typeof table !== "string") return;
    const name = normalizeTableName(table);
    if (ctes.has(name)) return;
    found.add(name);
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
    if (condition.values.length === 0) return noRowsNode();
    if (condition.values.length > 1) {
      throw new ScopeRewriteError(
        "SCOPE_REWRITE_FAILED",
        `字段 ${condition.column} 使用了单值操作符（${comparison}），但解析出多个过滤值，请改为 IN`,
      );
    }
    const [value] = condition.values;
    expr = {
      type: "binary_expr",
      operator: comparison,
      left: columnRef,
      right: placeholders([value!], ctx)[0],
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

function rewriteFromEntry(entry: AstNode, ctx: RewriteContext, ctes: ReadonlySet<string>): void {
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
  walkWithCtes(ast, new Set(), (entry, ctes) => {
    rewriteFromEntry(entry, ctx, ctes);
  });
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
