import { describe, expect, it } from "vitest";
import { guardSql, type SqlDialect } from "../../src/agent/sql/guard.js";

const MAX = 1000;

const allowed: Array<[string, SqlDialect]> = [
  ["SELECT id, name FROM users", "mysql"],
  ["SELECT id FROM users LIMIT 10", "mysql"],
  ["select count(*) from orders where created_at >= '2024-01-01'", "postgres"],
  ["WITH x AS (SELECT 1 AS n) SELECT n FROM x", "postgres"],
  ["SELECT a.id, b.total FROM a JOIN b ON a.id = b.a_id", "mysql"],
  ["SELECT * FROM t1 UNION SELECT * FROM t2", "postgres"],
  ["SHOW TABLES", "mysql"],
  ["SHOW COLUMNS FROM users", "mysql"],
  ["DESC users", "mysql"],
  ["EXPLAIN SELECT * FROM users", "mysql"],
  ["SELECT id FROM users WHERE name LIKE '%a%' ORDER BY id", "postgres"],
  ["SELECT COALESCE(sum(amount), 0) FROM orders", "mysql"],
  ["SELECT * FROM public.users", "postgres"],
  ["SELECT 1", "postgres"],
  ["SELECT * FROM users LIMIT 0", "mysql"],
  ["SELECT * FROM users LIMIT 10 OFFSET 100", "mysql"],
  ["SELECT * FROM users LIMIT 5000, 10", "mysql"],
  ["SELECT * FROM users LIMIT 10 OFFSET 1000", "mysql"],
  ["SELECT * FROM users WHERE id IN (SELECT id FROM u)", "mysql"],
  ["SELECT * FROM (SELECT * FROM t) x", "mysql"],
  ["WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT n FROM r", "postgres"],
];

const rejected: Array<[string, SqlDialect, string]> = [
  ["DELETE FROM users", "mysql", "FORBIDDEN_STATEMENT"],
  ["UPDATE users SET name = 'x'", "mysql", "FORBIDDEN_STATEMENT"],
  ["INSERT INTO users (id) VALUES (1)", "mysql", "FORBIDDEN_STATEMENT"],
  ["REPLACE INTO users (id) VALUES (1)", "mysql", "FORBIDDEN_STATEMENT"],
  ["DROP TABLE users", "mysql", "FORBIDDEN_STATEMENT"],
  ["CREATE TABLE x (id int)", "mysql", "FORBIDDEN_STATEMENT"],
  ["ALTER TABLE users ADD COLUMN age int", "mysql", "FORBIDDEN_STATEMENT"],
  ["TRUNCATE TABLE users", "mysql", "FORBIDDEN_STATEMENT"],
  ["GRANT SELECT ON *.* TO bob", "mysql", "FORBIDDEN_STATEMENT"],
  ["CALL do_something()", "mysql", "FORBIDDEN_STATEMENT"],
  ["SET autocommit = 0", "mysql", "FORBIDDEN_STATEMENT"],
  ["USE mysql", "mysql", "FORBIDDEN_STATEMENT"],
  ["LOCK TABLES users WRITE", "mysql", "FORBIDDEN_STATEMENT"],
  ["RENAME TABLE a TO b", "mysql", "FORBIDDEN_STATEMENT"],
  ["SELECT 1; DROP TABLE users", "mysql", "FORBIDDEN_STATEMENT"],
  ["SELECT 1; SELECT 2", "postgres", "FORBIDDEN_STATEMENT"],
  ["SELECT * FROM users FOR UPDATE", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM users LOCK IN SHARE MODE", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT SLEEP(10)", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT BENCHMARK(1000000, MD5('a'))", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT LOAD_FILE('/etc/passwd')", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT get_lock('lock', 10)", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT pg_sleep(10)", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT pg_read_file('/etc/passwd')", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT pg_read_binary_file('/etc/passwd')", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT pg_ls_dir('/')", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT pg_terminate_backend(123)", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT dblink('host=x', 'select 1')", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT lo_import('/etc/passwd')", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT lo_export(1, '/tmp/x')", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * INTO OUTFILE '/tmp/x' FROM users", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM users INTO OUTFILE '/tmp/x'", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * INTO @x FROM users", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM users LIMIT 999999", "mysql", "LIMIT_TOO_LARGE"],
  ["SELECT * FROM users LIMIT 10, 5000", "mysql", "LIMIT_TOO_LARGE"],
  ["SELECT * FROM users LIMIT ?", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM users LIMIT 10 OFFSET 200000", "mysql", "LIMIT_TOO_LARGE"],
  ["SELECT * FROM (SELECT * FROM t LIMIT 999999) x", "mysql", "LIMIT_TOO_LARGE"],
  ["SELECT * FROM t1 UNION SELECT * FROM t2 LIMIT 999999", "postgres", "LIMIT_TOO_LARGE"],
  ["SELECT * FROM (SELECT * FROM t LIMIT 10 OFFSET 999999) x", "mysql", "LIMIT_TOO_LARGE"],
  ["SELECT 1 /*!50000 UNION SELECT password_hash FROM users */", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT 1 /*!50000 SLEEP(10) */", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT /*+ MAX_EXECUTION_TIME(0) */ * FROM users", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM pg_stat_activity", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM pg_shadow", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM information_schema.tables", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM mysql.user", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM performance_schema.threads", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM sys.users", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SHOW COLUMNS FROM mysql.user", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM pg_catalog.pg_class", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM pg_toast.pg_toast_1", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM pg_temp_3.t", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM t WHERE id IN (SELECT id FROM pg_catalog.pg_class)", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["WITH x AS (SELECT * FROM mysql.user) SELECT * FROM x", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["", "mysql", "EMPTY"],
  ["   ", "mysql", "EMPTY"],
  ["SELECT * FROM " + Array.from({ length: 21 }, (_, i) => `t${i}`).join(", "), "mysql", "TOO_MANY_TABLES"],
];

describe("guardSql", () => {
  it.each(allowed)("allows %s (%s)", (sql, dialect) => {
    const result = guardSql({ sql, dialect, maxRows: MAX });
    expect(result.ok).toBe(true);
  });

  it.each(rejected)("rejects %s (%s)", (sql, dialect, code) => {
    const result = guardSql({ sql, dialect, maxRows: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("rejects VACUUM regardless of parser support", () => {
    const result = guardSql({ sql: "VACUUM", dialect: "postgres", maxRows: MAX });
    expect(result.ok).toBe(false);
  });

  it("rejects SQL longer than 100k characters", () => {
    const result = guardSql({ sql: `SELECT '${"a".repeat(100_001)}'`, dialect: "mysql", maxRows: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN_CONSTRUCT");
  });

  it("appends a limit when missing", () => {
    const result = guardSql({ sql: "SELECT id FROM users", dialect: "mysql", maxRows: 100 });
    expect(result).toEqual({ ok: true, sql: "SELECT id FROM users\nLIMIT 101" });
  });

  it("appends a limit for postgres selects without an explicit limit", () => {
    const result = guardSql({ sql: "SELECT id FROM users", dialect: "postgres", maxRows: 100 });
    expect(result).toEqual({ ok: true, sql: "SELECT id FROM users\nLIMIT 101" });
  });

  it("does not append a second LIMIT to a UNION and keeps its outer limit", () => {
    const sql = "SELECT * FROM t1 UNION SELECT * FROM t2 LIMIT 5";
    expect(guardSql({ sql, dialect: "postgres", maxRows: 100 })).toEqual({ ok: true, sql });
  });

  it("does not append a LIMIT to a UNION without one", () => {
    const sql = "SELECT * FROM t1 UNION SELECT * FROM t2";
    expect(guardSql({ sql, dialect: "postgres", maxRows: 100 })).toEqual({ ok: true, sql });
  });

  it("keeps an existing safe limit", () => {
    const result = guardSql({ sql: "SELECT id FROM users LIMIT 5", dialect: "postgres", maxRows: 100 });
    expect(result).toEqual({ ok: true, sql: "SELECT id FROM users LIMIT 5" });
  });

  it("strips trailing semicolons instead of rejecting", () => {
    const result = guardSql({ sql: "SELECT id FROM users;  ", dialect: "mysql", maxRows: 100 });
    expect(result).toEqual({ ok: true, sql: "SELECT id FROM users\nLIMIT 101" });
  });

  it("does not append a limit to SHOW or DESC", () => {
    expect(guardSql({ sql: "SHOW TABLES", dialect: "mysql", maxRows: 100 })).toEqual({
      ok: true,
      sql: "SHOW TABLES",
    });
    expect(guardSql({ sql: "DESC users", dialect: "mysql", maxRows: 100 })).toEqual({
      ok: true,
      sql: "DESC users",
    });
  });
});
