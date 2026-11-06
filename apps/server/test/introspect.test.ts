import { describe, expect, it } from "vitest";
import {
  buildMysqlSnapshot,
  buildPostgresSnapshot,
  introspectPostgres,
  type MysqlIntrospectionRows,
  type PostgresIntrospectionRows,
} from "../src/agent/datasource/introspect.js";

const mysqlRows: MysqlIntrospectionRows = {
  tableRows: [
    { TABLE_SCHEMA: "app", TABLE_NAME: "users", TABLE_COMMENT: "用户", TABLE_ROWS: 42 },
    { TABLE_SCHEMA: "app", TABLE_NAME: "orders", TABLE_COMMENT: "", TABLE_ROWS: "0" },
  ],
  columnRows: [
    {
      TABLE_NAME: "users",
      COLUMN_NAME: "id",
      COLUMN_TYPE: "int",
      IS_NULLABLE: "NO",
      COLUMN_DEFAULT: null,
      COLUMN_COMMENT: "主键",
    },
    {
      TABLE_NAME: "users",
      COLUMN_NAME: "name",
      COLUMN_TYPE: "varchar(50)",
      IS_NULLABLE: "YES",
      COLUMN_DEFAULT: null,
      COLUMN_COMMENT: "",
    },
    {
      TABLE_NAME: "orders",
      COLUMN_NAME: "id",
      COLUMN_TYPE: "int",
      IS_NULLABLE: "NO",
      COLUMN_DEFAULT: null,
      COLUMN_COMMENT: "",
    },
    {
      TABLE_NAME: "orders",
      COLUMN_NAME: "user_id",
      COLUMN_TYPE: "int",
      IS_NULLABLE: "NO",
      COLUMN_DEFAULT: null,
      COLUMN_COMMENT: "",
    },
  ],
  indexRows: [
    { TABLE_NAME: "users", INDEX_NAME: "PRIMARY", NON_UNIQUE: 0, COLUMN_NAME: "id" },
    { TABLE_NAME: "users", INDEX_NAME: "idx_users_name", NON_UNIQUE: 1, COLUMN_NAME: "name" },
    { TABLE_NAME: "orders", INDEX_NAME: "PRIMARY", NON_UNIQUE: "0", COLUMN_NAME: "id" },
    { TABLE_NAME: "orders", INDEX_NAME: "idx_orders_user", NON_UNIQUE: 0, COLUMN_NAME: "user_id" },
  ],
  fkRows: [
    {
      TABLE_NAME: "orders",
      CONSTRAINT_NAME: "fk_orders_user",
      COLUMN_NAME: "user_id",
      REFERENCED_TABLE_NAME: "users",
      REFERENCED_COLUMN_NAME: "id",
    },
  ],
};

const postgresRows: PostgresIntrospectionRows = {
  tableRows: [
    { schema: "public", name: "users", comment: "Users", row_estimate: "42" },
    { schema: "public", name: "orders", comment: null, row_estimate: null },
  ],
  columnRows: [
    {
      schema: "public",
      name: "users",
      column_name: "id",
      data_type: "integer",
      is_nullable: "NO",
      column_default: "nextval('users_id_seq')",
      comment: null,
    },
    {
      schema: "public",
      name: "users",
      column_name: "name",
      data_type: "text",
      is_nullable: "YES",
      column_default: null,
      comment: "姓名",
    },
    {
      schema: "public",
      name: "orders",
      column_name: "id",
      data_type: "integer",
      is_nullable: "NO",
      column_default: null,
      comment: null,
    },
    {
      schema: "public",
      name: "orders",
      column_name: "user_id",
      data_type: "integer",
      is_nullable: "NO",
      column_default: null,
      comment: null,
    },
  ],
  primaryKeyRows: [
    { schema: "public", name: "users", column_name: "id" },
    { schema: "public", name: "orders", column_name: "id" },
  ],
  foreignKeyRows: [
    {
      schema: "public",
      name: "orders",
      constraint_name: "orders_user_id_fkey",
      column_name: "user_id",
      referenced_table: "users",
      referenced_column: "id",
    },
  ],
  indexRows: [
    {
      schema: "public",
      name: "users",
      index_name: "users_pkey",
      is_unique: true,
      column_name: "id",
    },
    {
      schema: "public",
      name: "users",
      index_name: "idx_users_name",
      is_unique: false,
      column_name: "name",
    },
  ],
};

describe("mysql schema mapper", () => {
  const snapshot = buildMysqlSnapshot(mysqlRows, 1_700_000_000_000);

  it("keeps tables, comments and row estimates", () => {
    expect(snapshot.tables).toHaveLength(2);
    expect(snapshot.refreshedAt).toBe(1_700_000_000_000);
    const users = snapshot.tables.find((table) => table.name === "users")!;
    expect(users.comment).toBe("用户");
    expect(users.rowEstimate).toBe(42);
    expect(users.schema).toBe("app");
    const orders = snapshot.tables.find((table) => table.name === "orders")!;
    expect(orders.comment).toBeNull();
    expect(orders.rowEstimate).toBe(0);
  });

  it("maps columns nullability and comments", () => {
    const users = snapshot.tables.find((table) => table.name === "users")!;
    const id = users.columns.find((column) => column.name === "id")!;
    const name = users.columns.find((column) => column.name === "name")!;
    expect(id).toMatchObject({ type: "int", nullable: false, comment: "主键" });
    expect(name).toMatchObject({ type: "varchar(50)", nullable: true, defaultValue: null });
    expect(name.comment).toBeNull();
  });

  it("groups indexes and primary keys", () => {
    const users = snapshot.tables.find((table) => table.name === "users")!;
    expect(users.primaryKey).toEqual(["id"]);
    expect(users.indexes).toContainEqual({ name: "idx_users_name", unique: false, columns: ["name"] });
    expect(users.indexes).toContainEqual({ name: "PRIMARY", unique: true, columns: ["id"] });
  });

  it("groups foreign keys", () => {
    const orders = snapshot.tables.find((table) => table.name === "orders")!;
    expect(orders.foreignKeys).toEqual([
      {
        name: "fk_orders_user",
        columns: ["user_id"],
        referencedTable: "users",
        referencedColumns: ["id"],
      },
    ]);
  });
});

describe("postgres schema mapper", () => {
  const snapshot = buildPostgresSnapshot(postgresRows, 1_700_000_000_000);

  it("maps tables, comments and estimates", () => {
    const users = snapshot.tables.find((table) => table.name === "users")!;
    expect(users.schema).toBe("public");
    expect(users.comment).toBe("Users");
    expect(users.rowEstimate).toBe(42);
    expect(users.columns.find((column) => column.name === "name")?.comment).toBe("姓名");
    const orders = snapshot.tables.find((table) => table.name === "orders")!;
    expect(orders.comment).toBeNull();
    expect(orders.rowEstimate).toBeNull();
  });

  it("maps primary keys, indexes and foreign keys", () => {
    const users = snapshot.tables.find((table) => table.name === "users")!;
    expect(users.primaryKey).toEqual(["id"]);
    expect(users.indexes).toContainEqual({ name: "users_pkey", unique: true, columns: ["id"] });
    expect(users.indexes).toContainEqual({
      name: "idx_users_name",
      unique: false,
      columns: ["name"],
    });

    const orders = snapshot.tables.find((table) => table.name === "orders")!;
    expect(orders.foreignKeys).toEqual([
      {
        name: "orders_user_id_fkey",
        columns: ["user_id"],
        referencedTable: "users",
        referencedColumns: ["id"],
      },
    ]);
  });

  it("preserves column defaults and ignores unknown tables", () => {
    const users = snapshot.tables.find((table) => table.name === "users")!;
    expect(users.columns.find((column) => column.name === "id")?.defaultValue).toBe(
      "nextval('users_id_seq')",
    );
    const withOrphans = buildPostgresSnapshot(
      {
        ...postgresRows,
        columnRows: [
          ...postgresRows.columnRows,
          {
            schema: "public",
            name: "missing",
            column_name: "id",
            data_type: "integer",
            is_nullable: "NO",
            column_default: null,
            comment: null,
          },
        ],
      },
      1,
    );
    expect(withOrphans.tables).toHaveLength(2);
  });

  it("introspects composite PG foreign keys by key position, not constraint name alone", async () => {
    const calls: string[] = [];
    const pool = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [] };
      },
    };

    await introspectPostgres(pool as never);

    const fkSql = calls.find((sql) => sql.includes("FROM pg_constraint c") && sql.includes("contype = 'f'"))!;
    expect(fkSql).toContain("unnest(c.confkey) WITH ORDINALITY");
    expect(fkSql).toContain("fk.ord = k.ord");
    expect(fkSql).not.toContain("constraint_column_usage");
    expect(calls.find((sql) => sql.includes("contype = 'p'"))).toContain(
      "unnest(c.conkey) WITH ORDINALITY",
    );
    expect(calls.find((sql) => sql.includes("FROM pg_index"))).toContain("pg_get_indexdef");
  });
});
