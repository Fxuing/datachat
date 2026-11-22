import mysql, { type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import type { DatasourceType } from "@datachat/shared";
import type { DatasourceDriverPool, OptionValue } from "@datachat/datasource-sdk";
import { defaultDriverRegistry, type DriverRegistry } from "../../drivers/registry.js";

export type SslMode = "disable" | "require" | "no-verify";

export interface DatasourceConnection {
  id: string;
  type: DatasourceType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: SslMode;
  options?: Record<string, OptionValue | undefined>;
}

export interface Pools {
  mysql?: MysqlPool;
  pg?: PgPool;
  custom?: DatasourceDriverPool;
}

/** `require` verifies the server certificate; `no-verify` is the explicit opt-out. */
function sslConfig(mode: SslMode): { rejectUnauthorized: boolean } | undefined {
  if (mode === "disable") return undefined;
  return { rejectUnauthorized: mode === "require" };
}

interface CallbackConnection {
  query(sql: string, callback: (error: Error | null) => void): void;
  destroy(): void;
}

export class PoolRegistry {
  private pools = new Map<string, { type: string; pools: Pools }>();
  private readonly drivers: DriverRegistry;

  constructor(drivers: DriverRegistry = defaultDriverRegistry) {
    this.drivers = drivers;
  }

  get(ds: DatasourceConnection): Pools {
    const existing = this.pools.get(ds.id);
    if (existing) return existing.pools;

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
        ssl: sslConfig(ds.sslMode),
      });
      pool.on("connection", (connection) => {
        const raw = connection as unknown as CallbackConnection;
        raw.query("SET SESSION TRANSACTION READ ONLY", (readOnlyError) => {
          if (readOnlyError) {
            raw.destroy();
            return;
          }
          raw.query("SET SESSION time_zone = '+00:00'", (timeZoneError) => {
            if (timeZoneError) raw.destroy();
          });
        });
      });
      pools.mysql = pool;
    } else if (ds.type === "postgres") {
      const pool = new PgPool({
        host: ds.host,
        port: ds.port,
        database: ds.database,
        user: ds.username,
        password: ds.password,
        max: 5,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 30_000,
        options: "-c default_transaction_read_only=on -c timezone=UTC",
        ssl: sslConfig(ds.sslMode),
      });
      pools.pg = pool;
    } else {
      const driver = this.drivers.get(ds.type);
      if (!driver) {
        throw new Error(`未安装「${ds.type}」数据源驱动插件`);
      }
      pools.custom = driver.createPool({
        id: ds.id,
        type: ds.type,
        host: ds.host,
        port: ds.port,
        database: ds.database,
        username: ds.username,
        password: ds.password,
        sslMode: ds.sslMode,
        options: ds.options ?? {},
      });
    }
    this.pools.set(ds.id, { type: ds.type, pools });
    return pools;
  }

  /** Drop cached connections so edited/deleted datasources cannot keep using them. */
  async evict(id: string): Promise<void> {
    const entry = this.pools.get(id);
    if (!entry) return;
    this.pools.delete(id);
    await closePools(entry.pools);
  }

  /** Drop all cached connections belonging to a driver plugin (on disable/upgrade/uninstall). */
  async evictByDriver(driverId: string): Promise<void> {
    const targets: Pools[] = [];
    for (const [id, entry] of this.pools.entries()) {
      if (entry.type === driverId) {
        this.pools.delete(id);
        targets.push(entry.pools);
      }
    }
    await Promise.all(targets.map((pools) => closePools(pools)));
  }

  async closeAll(): Promise<void> {
    const all = [...this.pools.values()].map((entry) => entry.pools);
    this.pools.clear();
    await Promise.all(all.map((pools) => closePools(pools)));
  }
}

async function closePools(pools: Pools): Promise<void> {
  await Promise.allSettled([pools.mysql?.end(), pools.pg?.end(), pools.custom?.close()]);
}
