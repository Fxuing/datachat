import { Client as PgClient, Pool as PgPool } from "pg";
import Cursor from "pg-cursor";
import {
  DATASOURCE_SDK_VERSION,
  defineDatasourceDriver,
  safeDriverErrorMessage,
  type DatasourceDriver,
  type DatasourceDriverPool,
  type ResolvedConnectionConfig,
} from "@datachat/datasource-sdk";
import { introspectPostgres } from "../agent/datasource/introspect.js";

function sslConfig(mode: ResolvedConnectionConfig["sslMode"]): { rejectUnauthorized: boolean } | undefined {
  if (mode === "disable") return undefined;
  return { rejectUnauthorized: mode === "require" };
}

export const postgresDriver: DatasourceDriver = defineDatasourceDriver({
  manifest: {
    sdkVersion: DATASOURCE_SDK_VERSION,
    id: "postgres",
    label: "PostgreSQL",
    connectionMode: "network",
    defaultPort: 5432,
    supportsSsl: true,
    optionsSchema: [],
    capabilities: {
      explain: true,
      readOnlyProbe: true,
      rowScope: true,
    },
  },
  dialect: {
    parserDialect: "postgresql",
    placeholderStyle: "dollar",
    quoteChar: '"',
  },
  async probe(config) {
    const client = new PgClient({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      connectionTimeoutMillis: 10_000,
      ssl: sslConfig(config.sslMode),
    });
    try {
      await client.connect();
      const version = String(
        (await client.query("SELECT version() AS version")).rows[0]?.version ?? "unknown",
      );
      const readOnlyRow = await client.query("SHOW default_transaction_read_only");
      const canCreate = await client.query(
        "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create",
      );
      const defaultReadOnly =
        String(readOnlyRow.rows[0]?.default_transaction_read_only ?? "off") === "on";
      const writeGrant = Boolean(canCreate.rows[0]?.can_create);
      const warnings = writeGrant ? ["当前账号具有建表权限，建议改用只读账号"] : [];
      return {
        ok: true,
        serverVersion: version,
        readOnly: defaultReadOnly && !writeGrant,
        warnings,
      };
    } catch (error) {
      return {
        ok: false,
        readOnly: false,
        warnings: [],
        error: safeDriverErrorMessage(error, [config.password]),
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  },
  createPool(config): DatasourceDriverPool {
    const pool = new PgPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      max: 5,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      options: "-c default_transaction_read_only=on -c timezone=UTC",
      ssl: sslConfig(config.sslMode),
    });

    return {
      introspect: () => introspectPostgres(pool),
      async executeQuery(req, emitBatch) {
        const client = await pool.connect();
        try {
          await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(req.timeoutMs))}`);
          const cursor = client.query(
            new Cursor(req.sql, req.params, { rowMode: "array" }) as never,
          ) as unknown as Cursor;
          let columns: Array<{ name: string; type: "unknown" }> = [];
          try {
            while (!req.signal?.aborted) {
              const rows = await new Promise<unknown[][]>((resolve, reject) => {
                cursor.read(req.batchSize, (err, res, resultMeta) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  if (columns.length === 0 && resultMeta?.fields) {
                    columns = (resultMeta.fields as Array<{ name: string }>).map((f) => ({
                      name: f.name,
                      type: "unknown" as const,
                    }));
                  }
                  resolve(res as unknown[][]);
                });
              });
              if (rows.length === 0) break;
              await emitBatch({ columns, rows });
            }
          } finally {
            await cursor.close().catch(() => undefined);
          }
        } finally {
          client.release();
        }
      },
      async close() {
        await pool.end();
      },
    };
  },
});
