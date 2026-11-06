import { describe, expect, it } from "vitest";
import { PoolRegistry } from "../src/agent/datasource/pool.js";

const mysql = {
  id: "ds-mysql",
  type: "mysql" as const,
  host: "127.0.0.1",
  port: 3306,
  database: "app",
  username: "reader",
  password: "secret",
  sslMode: "disable" as const,
};

const postgres = {
  ...mysql,
  id: "ds-pg",
  type: "postgres" as const,
  port: 5432,
  sslMode: "require" as const,
};

describe("PoolRegistry", () => {
  it("creates one pool per datasource and reuses it", async () => {
    const registry = new PoolRegistry();
    const first = registry.get(mysql);
    const second = registry.get(mysql);
    expect(second).toBe(first);
    expect(first.mysql).toBeDefined();
    expect(first.pg).toBeUndefined();

    const pg = registry.get(postgres);
    expect(pg.pg).toBeDefined();
    expect(pg.mysql).toBeUndefined();
    await registry.closeAll();
  });

  it("recreates pools after closeAll", async () => {
    const registry = new PoolRegistry();
    const first = registry.get(mysql);
    await registry.closeAll();

    const second = registry.get(mysql);
    expect(second).not.toBe(first);
    await registry.closeAll();
  });
});
