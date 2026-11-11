import { describe, expect, it } from "vitest";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool } from "mysql2/promise";
import { Pool } from "pg";
import { introspectMysql, introspectPostgres } from "../src/agent/datasource/introspect.js";

const run = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!run)("schema introspection", () => {
  it(
    "introspects mysql tables, keys and comments",
    async () => {
      const container = await new MySqlContainer("mysql:8.0")
        .withDatabase("app")
        .start();
      const pool = createPool({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase(),
      });
      try {
        await pool.query(`
          CREATE TABLE users (
            id INT PRIMARY KEY,
            name VARCHAR(50) NOT NULL COMMENT '姓名'
          )
        `);
        await pool.query(`
          CREATE TABLE orders (
            id INT PRIMARY KEY,
            user_id INT NOT NULL,
            CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
          )
        `);

        const snapshot = await introspectMysql(pool, container.getDatabase());
        const tableNames = snapshot.tables.map((table) => table.name);
        expect(tableNames).toEqual(["orders", "users"]);

        const users = snapshot.tables.find((table) => table.name === "users")!;
        expect(users.primaryKey).toEqual(["id"]);
        expect(users.columns.find((column) => column.name === "name")?.comment).toBe("姓名");

        const orders = snapshot.tables.find((table) => table.name === "orders")!;
        expect(orders.foreignKeys[0]?.referencedTable).toBe("users");
      } finally {
        await pool.end();
        await container.stop();
      }
    },
    180_000,
  );

  it(
    "introspects postgres tables and keys",
    async () => {
      const container = await new PostgreSqlContainer("postgres:16-alpine").start();
      const pool = new Pool({ connectionString: container.getConnectionUri() });
      try {
        await pool.query(`
          CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
          CREATE TABLE orders (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL REFERENCES users(id)
          );
        `);

        const snapshot = await introspectPostgres(pool);
        const users = snapshot.tables.find((table) => table.name === "users")!;
        expect(users.schema).toBe("public");
        expect(users.columns.map((column) => column.name)).toEqual(["id", "name"]);
        expect(users.primaryKey).toEqual(["id"]);

        const orders = snapshot.tables.find((table) => table.name === "orders")!;
        expect(orders.foreignKeys[0]?.referencedTable).toBe("users");
        expect(orders.foreignKeys[0]?.columns).toEqual(["user_id"]);
      } finally {
        await pool.end();
        await container.stop();
      }
    },
    180_000,
  );
});
