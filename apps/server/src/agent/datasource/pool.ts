import mysql, { type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import type { DatasourceType } from "@datachat/shared";

export interface DatasourceConnection {
  id: string;
  type: DatasourceType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: "disable" | "require";
}

export interface Pools {
  mysql?: MysqlPool;
  pg?: PgPool;
}

export class PoolRegistry {
  private pools = new Map<string, Pools>();

  get(ds: DatasourceConnection): Pools {
    const existing = this.pools.get(ds.id);
    if (existing) return existing;

    const pools: Pools = {};
    if (ds.type === "mysql") {
      const pool = mysql.createPool({
        host: ds.host,
        port: ds.port,
        database: ds.database,
        user: ds.username,
        password: ds.password,
        connectionLimit: 5,
        connectTimeout: 10_000,
        timezone: "Z",
        supportBigNumbers: true,
        ssl: ds.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
      });
      pool.on("connection", (connection) => {
        void connection.query("SET SESSION TRANSACTION READ ONLY");
        void connection.query("SET SESSION time_zone = '+00:00'");
      });
      pools.mysql = pool;
    } else {
      const pool = new PgPool({
        host: ds.host,
        port: ds.port,
        database: ds.database,
        user: ds.username,
        password: ds.password,
        max: 5,
        statement_timeout: 30_000,
        ssl: ds.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
      });
      pool.on("connect", (client) => {
        void client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
        void client.query("SET TIME ZONE 'UTC'");
      });
      pools.pg = pool;
    }
    this.pools.set(ds.id, pools);
    return pools;
  }

  async closeAll(): Promise<void> {
    for (const pools of this.pools.values()) {
      await pools.mysql?.end().catch(() => undefined);
      await pools.pg?.end().catch(() => undefined);
    }
    this.pools.clear();
  }
}
