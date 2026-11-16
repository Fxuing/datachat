import type { ChatSql } from "./api";

/** Result rows carry a copy of the SQL that produced them, so pairing only has
 * to survive whitespace differences from formatting round-trips. */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export interface QueryPair<T> {
  sql: ChatSql;
  result?: T;
}

export function pairQueries<T extends { sql?: string }>(
  sqls: ChatSql[],
  results: T[],
): { pairs: QueryPair<T>[]; unmatched: T[] } {
  const unmatched = [...results];
  const pairs = sqls.map((sql) => {
    const expected = normalizeSql(sql.sql);
    const index = unmatched.findIndex(
      (result) => result.sql !== undefined && normalizeSql(result.sql) === expected,
    );
    const result = index >= 0 ? unmatched.splice(index, 1)[0] : undefined;
    return { sql, result };
  });

  return { pairs, unmatched };
}
