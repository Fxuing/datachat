import mysql, { type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import type { DatasourceType } from "@datachat/shared";

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
}

export interface Pools {
  mysql?: MysqlPool;
  pg?: PgPool;
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
        ssl: sslConfig(ds.sslMode),
      });
      // mysql2 emits this before handing the connection to the caller, and commands
      // are queued in order, so the caller's first query cannot overtake the setup.
      // On failure the connection is destroyed, which fails that first query closed.
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
    } else {
      const pool = new PgPool({
        host: ds.host,
        port: ds.port,
        database: ds.database,
        user: ds.username,
        password: ds.password,
        max: 5,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 30_000,
        // Startup options are applied by the server before the connection is
        // usable, which is stronger than a fire-and-forget SET after acquisition.
        options: "-c default_transaction_read_only=on -c timezone=UTC",
        ssl: sslConfig(ds.sslMode),
      });
      pools.pg = pool;
    }
    this.pools.set(ds.id, pools);
    return pools;
  }

  /** Drop cached connections so edited/deleted datasources cannot keep using them. */
  async evict(id: string): Promise<void> {
    const pools = this.pools.get(id);
    if (!pools) return;
    this.pools.delete(id);
    await closePools(pools);
  }

  async closeAll(): Promise<void> {
    const all = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(all.map((pools) => closePools(pools)));
  }
}

async function closePools(pools: Pools): Promise<void> {
  await Promise.allSettled([pools.mysql?.end(), pools.pg?.end()]);
}
