export interface ExtractedMetricCandidate {
  name: string;
  sqlExpression: string;
  alias: string | null;
}

export interface ExtractedMetricDraft {
  name: string;
  sqlExpression: string;
  tableName: string;
  defaultFilters: string[];
  timeColumn: string;
  description: string;
  sourceSql: string;
  sourceRunId?: string;
  candidates: ExtractedMetricCandidate[];
}

const AGG_FN_RE = /\b(sum|count|avg|min|max|stddev|variance|percentile_\w+|count_if|uniq(?:exact)?)\s*\(/i;
const DATE_FILTER_VALUE_RE =
  /('\d{4}-\d{2}-\d{2}|now\s*\(|current_date|current_timestamp|date_sub|date_add|interval\s+\d|curdate\s*\()/i;
const TIME_COL_NAME_RE = /(?:^|_)(time|date|at|day|month|dt|ts|created|paid|updated)(?:$|_)/i;
const SQL_KEYWORDS = new Set([
  "where",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "on",
  "group",
  "order",
  "having",
  "limit",
  "union",
  "set",
]);

function stripQuotes(ident: string): string {
  return ident.replace(/^[`"\[]|[`"\]]$/g, "");
}

/** Splits `text` by a top-level delimiter (outside quotes and nested parentheses). */
function splitTopLevel(text: string, delimiter: "," | "AND"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    if (delimiter === "," && ch === ",") {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    } else if (delimiter === "AND") {
      const slice = text.slice(i);
      const match = /^\s+AND\s+/i.exec(slice);
      if (match) {
        parts.push(text.slice(start, i).trim());
        i += match[0].length - 1;
        start = i + 1;
      }
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/** Finds the index of the first top-level keyword regex match outside quotes/parens. */
function findTopLevelMatch(sql: string, pattern: RegExp): { index: number; length: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (quote) {
      if (ch === quote && sql[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    const m = pattern.exec(sql.slice(i));
    if (m && m.index === 0) {
      return { index: i, length: m[0].length };
    }
  }
  return null;
}

function parseTableAliases(sql: string): { primaryTable: string; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  let primaryTable = "";
  const re =
    /\b(from|join)\s+([`"\[]?[\w.-]+[`"\]]?)(?:\s+(?:as\s+)?([`"\[]?[a-zA-Z_][\w]*[`"\]]?))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const keyword = match[1]!.toLowerCase();
    const rawTable = stripQuotes(match[2]!);
    if (!rawTable || rawTable.startsWith("(")) continue;
    const tableName = rawTable.includes(".") ? rawTable.split(".").pop()! : rawTable;
    if (keyword === "from" && !primaryTable) {
      primaryTable = tableName;
    }
    const rawAlias = match[3] ? stripQuotes(match[3]) : "";
    if (rawAlias && !SQL_KEYWORDS.has(rawAlias.toLowerCase())) {
      aliases.set(rawAlias.toLowerCase(), tableName);
    }
  }
  return { primaryTable, aliases };
}

function expandAliases(expr: string, aliases: Map<string, string>): string {
  if (aliases.size === 0) return expr;
  return expr.replace(/\b([a-zA-Z_]\w*)\s*\.\s*([`"]?[a-zA-Z_]\w*[`"]?)/g, (full, prefix, col) => {
    const table = aliases.get(String(prefix).toLowerCase());
    return table ? `${table}.${stripQuotes(String(col))}` : full;
  });
}

function splitExprAndAlias(item: string): { expr: string; alias: string | null } {
  // Explicit `... AS alias` at top level.
  const asMatch = findTopLevelMatch(item, /\s+AS\s+([`"\[]?[^\s,]+[`"\]]?)\s*$/i);
  if (asMatch) {
    const expr = item.slice(0, asMatch.index).trim();
    const tail = item.slice(asMatch.index).replace(/^\s+AS\s+/i, "").trim();
    return { expr, alias: stripQuotes(tail) };
  }
  // Trailing bare alias after closing paren, e.g. `SUM(amount) total_gmv`.
  const bareMatch = /^(.*\))\s+([`"\[]?[a-zA-Z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*[`"\]]?)$/.exec(
    item.trim(),
  );
  if (bareMatch && !SQL_KEYWORDS.has(stripQuotes(bareMatch[2]!).toLowerCase())) {
    return { expr: bareMatch[1]!.trim(), alias: stripQuotes(bareMatch[2]!) };
  }
  return { expr: item.trim(), alias: null };
}

function prettifyAlias(alias: string | null, fallbackIndex: number): string {
  if (!alias) return `指标 ${fallbackIndex + 1}`;
  if (/^[a-z0-9_]+$/i.test(alias)) {
    const upper = alias.toUpperCase();
    if (upper === "GMV" || upper === "AOV" || upper === "UV" || upper === "PV" || upper === "ARPU") {
      return upper;
    }
  }
  return alias;
}

/**
 * Extracts a best-effort draft Semantic Metric from an executed SQL query and user prompt
 * so admins promoting a good answer only have to review and tweak instead of typing from scratch.
 */
export function extractMetricDraftFromSql(input: {
  sql: string;
  prompt?: string | null;
  comment?: string | null;
  sourceRunId?: string;
}): ExtractedMetricDraft {
  const cleanSql = input.sql.trim().replace(/;+\s*$/, "");
  const { primaryTable, aliases } = parseTableAliases(cleanSql);

  const candidates: ExtractedMetricCandidate[] = [];
  const selectMatch = findTopLevelMatch(cleanSql, /^SELECT\s+(?:DISTINCT\s+)?/i);
  const fromMatch = findTopLevelMatch(cleanSql, /\s+FROM\s+/i);

  if (selectMatch && fromMatch && fromMatch.index > selectMatch.length) {
    const selectClause = cleanSql.slice(selectMatch.index + selectMatch.length, fromMatch.index);
    const items = splitTopLevel(selectClause, ",");
    for (const item of items) {
      const { expr, alias } = splitExprAndAlias(item);
      if (!AGG_FN_RE.test(expr)) continue;
      const normalizedExpr = expandAliases(expr.replace(/\s+/g, " ").trim(), aliases);
      candidates.push({
        name: prettifyAlias(alias, candidates.length),
        sqlExpression: normalizedExpr,
        alias,
      });
    }
  }

  // Extract WHERE clause (before GROUP BY / ORDER BY / HAVING / LIMIT).
  const defaultFilters: string[] = [];
  let timeColumn = "";
  const whereMatch = findTopLevelMatch(cleanSql, /\s+WHERE\s+/i);
  if (whereMatch) {
    const afterWhere = cleanSql.slice(whereMatch.index + whereMatch.length);
    const endMatch = findTopLevelMatch(
      afterWhere,
      /\s+(?:GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|UNION)\b/i,
    );
    const whereBody = endMatch ? afterWhere.slice(0, endMatch.index).trim() : afterWhere.trim();
    const predicates = splitTopLevel(whereBody, "AND");
    for (const rawPred of predicates) {
      const pred = expandAliases(rawPred.replace(/\s+/g, " ").trim(), aliases);
      if (!pred) continue;
      const colMatch = /([a-zA-Z_]\w*\.[a-zA-Z_]\w*|[a-zA-Z_]\w*)\s*(?:>=|<=|>|<|=|BETWEEN)/i.exec(
        pred,
      );
      if (DATE_FILTER_VALUE_RE.test(pred)) {
        if (!timeColumn && colMatch) {
          const col = colMatch[1]!;
          timeColumn = col.includes(".") ? col : primaryTable ? `${primaryTable}.${col}` : col;
        }
        continue;
      }
      defaultFilters.push(pred);
    }
  }

  // Fallback time column detection from date functions or column names in SQL.
  if (!timeColumn) {
    const dateFnCol =
      /\b(?:date_trunc|date_format|to_char|date)\s*\([^)]*?([a-zA-Z_]\w*\.[a-zA-Z_]\w*|[a-zA-Z_]\w*)/i.exec(
        cleanSql,
      );
    if (dateFnCol) {
      const expanded = expandAliases(dateFnCol[1]!, aliases);
      if (TIME_COL_NAME_RE.test(expanded.split(".").pop() ?? "")) {
        timeColumn = expanded.includes(".")
          ? expanded
          : primaryTable
            ? `${primaryTable}.${expanded}`
            : expanded;
      }
    }
  }

  const first = candidates[0];
  const description = [input.prompt?.trim(), input.comment?.trim()]
    .filter(Boolean)
    .join("；")
    .slice(0, 500);

  return {
    name: first?.name ?? "",
    sqlExpression: first?.sqlExpression ?? "",
    tableName: primaryTable,
    defaultFilters,
    timeColumn,
    description,
    sourceSql: cleanSql,
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    candidates,
  };
}
