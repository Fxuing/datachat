import sqlParser from "node-sql-parser";

export type SqlDialect = "mysql" | "postgres";
export type GuardErrorCode =
  | "EMPTY"
  | "PARSE_ERROR"
  | "FORBIDDEN_STATEMENT"
  | "FORBIDDEN_CONSTRUCT"
  | "LIMIT_TOO_LARGE"
  | "TOO_MANY_TABLES";

export type GuardResult =
  | { ok: true; sql: string }
  | { ok: false; code: GuardErrorCode; reason: string };

// `node-sql-parser` is CommonJS; a named ESM import fails at runtime under Node.
const { Parser } = sqlParser;

const parser = new Parser();

const ALLOWED_ROOT = new Set(["select", "show", "desc", "explain"]);
const FORBIDDEN_STATEMENTS = new Set([
  "insert", "update", "delete", "replace", "create", "drop", "alter", "truncate",
  "grant", "revoke", "call", "set", "use", "lock", "unlock", "rename", "analyze",
  "vacuum", "attach", "detach", "pragma", "copy", "merge",
]);
const FORBIDDEN_FUNCTIONS = new Set([
  "sleep", "benchmark", "load_file", "get_lock", "release_lock",
  "pg_sleep", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_file_write",
  "pg_file_rename", "pg_file_unlink", "pg_stat_file", "pg_logdir_ls",
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
  "dblink", "dblink_exec", "lo_import", "lo_export",
]);
/** Schemas that expose server internals; raw SQL must not query them. */
const SYSTEM_SCHEMAS = new Set([
  "information_schema", "mysql", "performance_schema", "sys",
  "pg_catalog", "pg_toast",
]);
const MAX_SQL_LENGTH = 100_000;
/** Deep offsets still scan the skipped rows, so keep pagination bounded too. */
const MAX_OFFSET = 100_000;

export interface GuardInput {
  sql: string;
  dialect: SqlDialect;
  maxRows: number;
  maxTables?: number;
}

export function guardSql({ sql, dialect, maxRows, maxTables = 20 }: GuardInput): GuardResult {
  const trimmed = sql.trim().replace(/(?:\s*;)+$/, "").trim();
  if (!trimmed) return { ok: false, code: "EMPTY", reason: "SQL 为空" };
  if (trimmed.length > MAX_SQL_LENGTH) {
    return { ok: false, code: "FORBIDDEN_CONSTRUCT", reason: "SQL 过长" };
  }
  // MySQL executes `/*! ... */` (versioned) and `/*+ ... */` (optimizer hints).
  // The parser treats them as comments, so reject them before parsing instead.
  if (trimmed.includes("/*!") || trimmed.includes("/*+")) {
    return {
      ok: false,
      code: "FORBIDDEN_CONSTRUCT",
      reason: "禁止使用可执行注释或优化器提示",
    };
  }

  let ast: unknown;
  try {
    ast = parser.astify(trimmed, { database: dialect === "mysql" ? "mysql" : "postgresql" });
  } catch (error) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      reason: `SQL 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (Array.isArray(ast)) {
    return { ok: false, code: "FORBIDDEN_STATEMENT", reason: "只允许单条语句" };
  }

  const root = ast as Record<string, unknown>;
  const rootType = String(root.type ?? "").toLowerCase();
  if (!ALLOWED_ROOT.has(rootType)) {
    return { ok: false, code: "FORBIDDEN_STATEMENT", reason: `不允许的语句类型：${rootType || "unknown"}` };
  }

  let violation: string | null = null;
  let violationCode: GuardErrorCode = "FORBIDDEN_CONSTRUCT";
  let tableCount = 0;
  walk(ast, (node) => {
    if (violation) return;
    const type = String(node.type ?? "").toLowerCase();
    if (FORBIDDEN_STATEMENTS.has(type)) {
      violation = `包含禁止的语句：${type}`;
      return;
    }
    if (type === "function") {
      const name = functionName(node);
      if (name && FORBIDDEN_FUNCTIONS.has(name)) {
        violation = `禁止调用函数：${name}`;
        return;
      }
    }
    // `into` exists on every select as `{ position: null }`; only a real INTO clause
    // carries a keyword/type/position.
    if (hasIntoClause(node.into)) {
      violation = "禁止 SELECT INTO / OUTFILE";
      return;
    }
    if (node.locking_read) {
      violation = "禁止加锁读（FOR UPDATE / LOCK IN SHARE MODE）";
      return;
    }
    if (type === "select") {
      const limitIssue = validateLimit(node.limit, maxRows);
      if (limitIssue) {
        violation = limitIssue.reason;
        violationCode = limitIssue.code;
        return;
      }
    }
    if (Array.isArray(node.from)) {
      for (const entry of node.from) {
        if (entry === null || typeof entry !== "object") continue;
        const table = (entry as Record<string, unknown>).table;
        if (typeof table !== "string") continue;
        tableCount += 1;
        const schema = (entry as Record<string, unknown>).db;
        if (typeof schema === "string" && isSystemSchema(schema)) {
          violation = `禁止访问系统库：${schema}`;
          return;
        }
        if (typeof schema !== "string" || schema === "") {
          // `pg_stat_activity` and friends live in pg_catalog implicitly when the
          // schema is omitted, so the qualifier check alone is not enough.
          const bare = table.includes(".") ? table.split(".")[0]! : table;
          if (isImplicitSystemName(bare)) {
            violation = `禁止访问系统表：${table}`;
            return;
          }
        }
      }
    }
  });

  if (violation) {
    return { ok: false, code: violationCode, reason: violation };
  }

  if (tableCount > maxTables) {
    return { ok: false, code: "TOO_MANY_TABLES", reason: `关联表数量超过 ${maxTables}` };
  }

  if (rootType === "select" && !root.set_op && !root._next) {
    const limit = root.limit as
      | { separator?: string; seperator?: string; value?: unknown }
      | null
      | undefined;
    const values = limitValue(limit);
    if (values === null) {
      return { ok: true, sql: `${trimmed}\nLIMIT ${maxRows + 1}` };
    }
  }

  return { ok: true, sql: trimmed };
}

/** Validate every LIMIT/OFFSET, including nested selects and UNION branches. */
function validateLimit(
  limit: unknown,
  maxRows: number,
): { code: GuardErrorCode; reason: string } | null {
  if (limit === null || typeof limit !== "object") return null;
  const node = limit as { separator?: string; seperator?: string; value?: unknown };
  const values = limitValue(node);
  if (values === null) return null;
  const separator = node.seperator ?? node.separator ?? "";
  const isComma = separator === ",";
  const isOffset = separator === "offset";
  const countNode = values[isComma ? 1 : 0];
  const offsetNode = isComma ? values[0] : isOffset ? values[1] : undefined;
  const count = numericConstant(countNode);
  if (count === null) {
    return { code: "FORBIDDEN_CONSTRUCT", reason: "LIMIT 必须是数字常量" };
  }
  if (count > maxRows) {
    return { code: "LIMIT_TOO_LARGE", reason: `LIMIT ${count} 超过上限 ${maxRows}` };
  }
  if (offsetNode !== undefined) {
    const offset = numericConstant(offsetNode);
    if (offset === null) {
      return { code: "FORBIDDEN_CONSTRUCT", reason: "OFFSET 必须是数字常量" };
    }
    if (offset > MAX_OFFSET) {
      return { code: "LIMIT_TOO_LARGE", reason: `OFFSET ${offset} 超过上限 ${MAX_OFFSET}` };
    }
  }
  return null;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
    return;
  }
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit, seen);
}

function functionName(node: Record<string, unknown>): string | null {
  const name = node.name as { name?: Array<{ value?: unknown }> } | undefined;
  const parts = name?.name;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (typeof part?.value === "string") {
      const normalized = part.value.toLowerCase();
      if (FORBIDDEN_FUNCTIONS.has(normalized)) return normalized;
    }
  }
  return null;
}

function hasIntoClause(into: unknown): boolean {
  if (into === null || typeof into !== "object") return false;
  const node = into as Record<string, unknown>;
  return Boolean(node.keyword) || node.type === "into" || node.position != null;
}

function isSystemSchema(schema: string): boolean {
  const normalized = schema.toLowerCase();
  return (
    SYSTEM_SCHEMAS.has(normalized) ||
    normalized.startsWith("pg_temp_") ||
    normalized.startsWith("pg_toast_temp_")
  );
}

const IMPLICIT_SYSTEM_NAME = /^(pg_|pg_catalog|information_schema|pg_toast)/i;

function isImplicitSystemName(name: string): boolean {
  return IMPLICIT_SYSTEM_NAME.test(name);
}

/** Returned `null` means the query has no LIMIT; an empty list is how the PG parser
 * represents "no LIMIT", so treat it the same as an absent clause. */
function limitValue(limit: { value?: unknown } | null | undefined): unknown[] | null {
  const raw = limit?.value;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw;
}

function numericConstant(value: unknown): number | null {
  const node = value as { type?: unknown; value?: unknown } | undefined;
  if (!node || node.type !== "number" || typeof node.value !== "number") return null;
  return node.value;
}
