import { describe, expect, it } from "vitest";
import {
  ScopeRewriteError,
  assertScopableSql,
  collectTableNames,
  normalizeTableName,
  rewriteSqlForScope,
  type ScopePlan,
  type ScopeTable,
} from "../src/agent/sql/scope.js";

function plan(tables: Record<string, ScopeTable>): ScopePlan {
  return { tables: new Map(Object.entries(tables)) };
}

const scoped = (column: string, values: string[], nullVisible = true): ScopeTable => ({
  kind: "scoped",
  conditions: [{ column, operator: "in", values, nullVisible }],
});

describe("collectTableNames", () => {
  it("collects physical tables across joins, subqueries, CTEs, and unions", () => {
    const sql =
      "with recent as (select id from orders) " +
      "select * from recent join customers c on c.id = recent.id " +
      "where c.id in (select customer_id from invoices) " +
      "union all select * from audit_log";
    expect(collectTableNames(sql, "mysql").sort()).toEqual([
      "audit_log",
      "customers",
      "invoices",
      "orders",
    ]);
  });

  it("normalizes quoted and qualified names", () => {
    expect(collectTableNames('select * from "Sales"."Orders"', "postgres")).toEqual(["orders"]);
    expect(normalizeTableName("`Orders`")).toBe("orders");
  });

  it("propagates outer CTE names into derived tables and subqueries", () => {
    const sql =
      "with recent as (select id from orders) " +
      "select * from (select * from recent) sub where sub.id in (select id from recent)";
    expect(collectTableNames(sql, "mysql")).toEqual(["orders"]);
  });

  it("treats a physical table inside a same-named non-recursive CTE as physical", () => {
    const sql = "with orders as (select * from orders) select * from orders";
    expect(collectTableNames(sql, "mysql")).toEqual(["orders"]);
  });

  it("allows recursive CTE self-references without treating the CTE as a physical table", () => {
    const sql =
      "with recursive nums as (select 1 as n union all select n + 1 from nums where n < 3) select * from nums";
    expect(collectTableNames(sql, "mysql")).toEqual([]);
  });
});

describe("assertScopableSql", () => {
  it("rejects SHOW and DESC metadata statements while allowing SELECT and EXPLAIN", () => {
    expect(() => assertScopableSql("SHOW TABLES", "mysql")).toThrow(ScopeRewriteError);
    expect(() => assertScopableSql("DESC orders", "mysql")).toThrow(ScopeRewriteError);
    expect(() => assertScopableSql("SELECT * FROM orders", "mysql")).not.toThrow();
    expect(() => assertScopableSql("EXPLAIN SELECT * FROM orders", "mysql")).not.toThrow();
  });
});

describe("rewriteSqlForScope", () => {
  it("leaves public tables untouched and binds mysql params", () => {
    const result = rewriteSqlForScope(
      "select o.id from orders o join customers c on o.cid = c.id",
      "mysql",
      plan({ orders: scoped("dept_id", ["d1", "d2"]), customers: { kind: "public" } }),
    );
    expect(result.sql).toBe(
      "SELECT `o`.`id` FROM (SELECT * FROM `orders` WHERE (`dept_id` IN (?, ?) OR `dept_id` IS NULL)) AS `o` " +
        "INNER JOIN `customers` AS `c` ON `o`.`cid` = `c`.`id`",
    );
    expect(result.params).toEqual(["d1", "d2"]);
    expect(result.appliedTables).toEqual(["orders"]);
  });

  it("numbers postgres params across multiple tables and supports nullVisible=false", () => {
    const result = rewriteSqlForScope(
      "select * from orders o join customers c on o.cid = c.id where o.id in (select id from invoices)",
      "postgres",
      plan({
        orders: scoped("dept_id", ["a"], false),
        customers: scoped("org_code", ["x", "y"]),
        invoices: scoped("dept_id", ["a"], false),
      }),
    );
    expect(result.params).toEqual(["a", "x", "y", "a"]);
    expect(result.sql).toContain('"orders" WHERE "dept_id" IN ($1)');
    expect(result.sql).toContain('"customers" WHERE ("org_code" IN ($2, $3) OR "org_code" IS NULL)');
    expect(result.sql).toContain('"invoices" WHERE "dept_id" IN ($4)');
    expect(result.sql).not.toContain('"dept_id" IS NULL');
    expect(result.sql).toContain('"org_code" IS NULL');
  });

  it("wraps the physical table inside a CTE without wrapping the CTE reference", () => {
    const result = rewriteSqlForScope(
      "with recent as (select id from orders) select * from recent",
      "mysql",
      plan({ orders: scoped("dept_id", ["d1"]) }),
    );
    expect(result.sql).toContain("(SELECT * FROM `orders` WHERE (`dept_id` IN (?) OR `dept_id` IS NULL))");
    expect(result.sql).toMatch(/FROM `recent`$/);
  });

  it("ANDs multiple conditions with literals and comparisons", () => {
    const result = rewriteSqlForScope(
      "select * from orders",
      "mysql",
      plan({
        orders: {
          kind: "scoped",
          conditions: [
            { column: "dept_id", operator: "in", values: ["d1"], nullVisible: false },
            { column: "is_deleted", operator: "eq", values: ["0"], nullVisible: true },
            { column: "amount", operator: "gt", values: ["100"], nullVisible: false },
          ],
        },
      }),
    );
    expect(result.params).toEqual(["d1", "0", "100"]);
    expect(result.sql).toContain("`dept_id` IN (?) AND (`is_deleted` = ? OR `is_deleted` IS NULL) AND `amount` > ?");
  });

  it("treats an empty exclusion list as no restriction", () => {
    const result = rewriteSqlForScope(
      "select * from orders",
      "mysql",
      plan({
        orders: {
          kind: "scoped",
          conditions: [{ column: "dept_id", operator: "not_in", values: [], nullVisible: false }],
        },
      }),
    );
    expect(result.params).toEqual([]);
    expect(result.sql).toBe("SELECT * FROM (SELECT * FROM `orders` WHERE 1 = 1) AS `orders`");
  });

  it("wraps derived tables and both union branches", () => {
    const result = rewriteSqlForScope(
      "select * from (select id from orders) x union all select * from invoices",
      "mysql",
      plan({ orders: scoped("dept_id", ["d1"]), invoices: scoped("dept_id", ["d1"]) }),
    );
    expect(result.sql.match(/`dept_id` IN \(/g)).toHaveLength(2);
    expect(result.params).toEqual(["d1", "d1"]);
  });

  it("rejects denied and unconfigured tables", () => {
    expect(() =>
      rewriteSqlForScope("select * from orders", "mysql", plan({ orders: { kind: "denied" } })),
    ).toThrow(ScopeRewriteError);
    expect(() => rewriteSqlForScope("select * from orders", "mysql", plan({}))).toThrow(
      /未配置数据范围/,
    );
  });

  it("reports unparsable sql as a rewrite failure", () => {
    expect(() => rewriteSqlForScope("select from", "mysql", plan({}))).toThrow(/无法解析 SQL/);
  });

  it("rewrites a physical table even when shadowed by a non-recursive CTE of the same name", () => {
    const result = rewriteSqlForScope(
      "with orders as (select id from orders) select * from orders",
      "mysql",
      plan({ orders: scoped("dept_id", ["d1"], false) }),
    );
    expect(result.params).toEqual(["d1"]);
    expect(result.appliedTables).toEqual(["orders"]);
    expect(result.sql).toContain("(SELECT * FROM `orders` WHERE `dept_id` IN (?))");
    expect(result.sql).toMatch(/SELECT \* FROM `orders`$/);
  });

  it("rewrites subqueries referencing outer CTEs without treating the CTE as physical", () => {
    const result = rewriteSqlForScope(
      "with recent as (select id from orders) select * from (select * from recent) sub",
      "mysql",
      plan({ orders: scoped("dept_id", ["d1"], false) }),
    );
    expect(result.params).toEqual(["d1"]);
    expect(result.appliedTables).toEqual(["orders"]);
  });

  it("refuses single-value comparison operators when multiple values are provided", () => {
    expect(() =>
      rewriteSqlForScope(
        "select * from orders",
        "mysql",
        plan({
          orders: {
            kind: "scoped",
            conditions: [{ column: "dept_id", operator: "eq", values: ["d1", "d2"], nullVisible: false }],
          },
        }),
      ),
    ).toThrow(/单值操作符/);
  });
});
