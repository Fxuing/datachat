import { describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { dataScopePolicies, dataScopeRules, datasources } from "../src/db/schema.js";

const DS_ID = "11111111-1111-4111-8111-111111111111";

function setup(): DbHandle {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  return handle;
}

function tableNames(handle: DbHandle): string[] {
  const rows = handle.sqlite
    .prepare("select name from sqlite_master where type = 'table'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function insertDatasource(handle: DbHandle): void {
  const now = Date.now();
  handle.sqlite
    .prepare(
      `insert into datasources
       (id, name, type, host, port, database, username, password_cipher, created_by, created_at, updated_at)
       values (?, ?, 'mysql', 'localhost', 3306, 'demo', 'reader', 'cipher', 'admin', ?, ?)`,
    )
    .run(DS_ID, "demo", now, now);
}

function policy(overrides: Record<string, string | number | null> = {}): Record<string, string | number | null> {
  return {
    id: `policy-${Math.random().toString(16).slice(2)}`,
    datasource_id: DS_ID,
    table_name: "orders",
    mode: "public",
    enabled: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function insertPolicy(handle: DbHandle, row: Record<string, string | number | null>): void {
  const columns = Object.keys(row);
  handle.sqlite
    .prepare(
      `insert into data_scope_policies (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    )
    .run(...columns.map((column) => row[column]));
}

describe("data scope schema", () => {
  it("creates department and policy tables", () => {
    const handle = setup();
    expect(tableNames(handle)).toEqual(
      expect.arrayContaining([
        "departments",
        "department_closure",
        "user_departments",
        "department_datasource_grants",
        "department_org_map",
        "data_scope_policies",
        "data_scope_rules",
      ]),
    );
    handle.sqlite.close();
  });

  it("defaults datasources to scope off and keeps scope columns nullable", () => {
    const handle = setup();
    insertDatasource(handle);
    const row = handle.db.select().from(datasources).get();
    expect(row?.dataScopeMode).toBe("off");

    const auditColumns = handle.sqlite.pragma("table_info(\"query_audit\")") as Array<{
      name: string;
      notnull: number;
    }>;
    expect(auditColumns.find((column) => column.name === "scope_reason")?.notnull).toBe(0);

    const runColumns = handle.sqlite.pragma("table_info(\"runs\")") as Array<{
      name: string;
      notnull: number;
    }>;
    expect(runColumns.find((column) => column.name === "scope_snapshot")?.notnull).toBe(0);
    handle.sqlite.close();
  });

  it("rejects invalid policy modes and rule values", () => {
    const handle = setup();
    insertDatasource(handle);
    expect(() => insertPolicy(handle, policy({ mode: "open" }))).toThrow(/CHECK constraint failed/);
    insertPolicy(handle, policy({ mode: "scoped" }));

    const insertRule = (overrides: Record<string, string | number | null> = {}) => {
      const row = {
        id: `rule-${Math.random().toString(16).slice(2)}`,
        policy_id: (
          handle.sqlite
            .prepare("select id from data_scope_policies where table_name = 'orders'")
            .get() as { id: string }
        ).id,
        sort_order: 0,
        column_name: "dept_id",
        operator: "in",
        value_mode: "department_id",
        literal_values_json: null,
        null_visible: 0,
        created_at: Date.now(),
        ...overrides,
      };
      const columns = Object.keys(row);
      handle.sqlite
        .prepare(
          `insert into data_scope_rules (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
        )
        .run(...columns.map((column) => (row as unknown as Record<string, string | number | null>)[column]));
    };

    expect(() => insertRule({ operator: "like" })).toThrow(/CHECK constraint failed/);
    expect(() => insertRule({ value_mode: "app_id" })).toThrow(/CHECK constraint failed/);
    expect(() => insertRule({ null_visible: 2 })).toThrow(/CHECK constraint failed/);
    expect(() => insertRule({ operator: "eq", value_mode: "literal", literal_values_json: "[\"0\"]" })).not.toThrow();
    handle.sqlite.close();
  });

  it("enforces one policy per table and one mapping per department", () => {
    const handle = setup();
    insertDatasource(handle);
    insertPolicy(handle, policy());
    expect(() => insertPolicy(handle, policy())).toThrow(/UNIQUE constraint failed/);

    const now = Date.now();
    handle.sqlite
      .prepare("insert into departments (id, name, code, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run("dept-1", "总部", "HQ", now, now);
    expect(() =>
      handle.sqlite
        .prepare("insert into departments (id, name, code, created_at, updated_at) values (?, ?, ?, ?, ?)")
        .run("dept-2", "分部", "HQ", now, now),
    ).toThrow(/UNIQUE constraint failed/);

    const insertMapping = (values: Array<string | null>) =>
      handle.sqlite
        .prepare(
          "insert into department_org_map (id, datasource_id, department_id, external_id, external_code, external_org_code, source, created_at) values (?, ?, ?, ?, ?, ?, 'manual', ?)",
        )
        .run(`map-${Math.random()}`, DS_ID, "dept-1", ...values, now);

    expect(() => insertMapping([null, null, null])).toThrow(/CHECK constraint failed/);
    expect(() => insertMapping(["101", null, null])).not.toThrow();
    handle.sqlite.close();
  });

  it("keeps policy rows readable through drizzle", () => {
    const handle = setup();
    insertDatasource(handle);
    insertPolicy(handle, policy({ mode: "denied" }));
    const rows = handle.db.select().from(dataScopePolicies).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe("denied");
    expect(handle.db.select().from(dataScopeRules).all()).toHaveLength(0);
    handle.sqlite.close();
  });
});
