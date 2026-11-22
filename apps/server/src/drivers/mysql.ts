import mysql from "mysql2/promise";
import {
  DATASOURCE_SDK_VERSION,
  defineDatasourceDriver,
  safeDriverErrorMessage,
  type DatasourceDriver,
  type DatasourceDriverPool,
  type ResolvedConnectionConfig,
} from "@datachat/datasource-sdk";
import { introspectMysql } from "../agent/datasource/introspect.js";

function sslConfig(mode: ResolvedConnectionConfig["sslMode"]): { rejectUnauthorized: boolean } | undefined {
  if (mode === "disable") return undefined;
  return { rejectUnauthorized: mode === "require" };
}

interface CallbackConnection {
  query(sql: string, callback: (error: Error | null) => void): void;
  destroy(): void;
}

export const mysqlDriver: DatasourceDriver = defineDatasourceDriver({
  manifest: {
    sdkVersion: DATASOURCE_SDK_VERSION,
    id: "mysql",
    label: "MySQL",
    connectionMode: "network",
    defaultPort: 3306,
    supportsSsl: true,
    optionsSchema: [],
    capabilities: {
      explain: true,
      readOnlyProbe: true,
      rowScope: true,
    },
  },
  dialect: {
    parserDialect: "mysql",
    placeholderStyle: "qmark",
    quoteChar: "`",
  },
  async probe(config) {
    let connection: mysql.Connection | undefined;
    try {
      connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.username,
        password: config.password,
        connectTimeout: 10_000,
        ssl: sslConfig(config.sslMode),
      });
      const [versionRows] = await connection.query("SELECT VERSION() AS version");
      const version = String((versionRows as Array<{ version: string }>)[0]?.version ?? "unknown");
      const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
      const grants = (grantRows as Array<Record<string, string>>)
        .flatMap((row) => Object.values(row))
        .join(" ");
      const writeGrant = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(grants);
      const warnings = writeGrant ? ["当前账号具有写权限，建议改用只读账号"] : [];
      return { ok: true, serverVersion: version, readOnly: !writeGrant, warnings };
    } catch (error) {
      return {
        ok: false,
        readOnly: false,
        warnings: [],
        error: safeDriverErrorMessage(error, [config.password]),
      };
    } finally {
      await connection?.end().catch(() => undefined);
    }
  },
  createPool(config): DatasourceDriverPool {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      connectionLimit: 5,
      connectTimeout: 10_000,
      timezone: "Z",
      supportBigNumbers: true,
      ssl: sslConfig(config.sslMode),
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

    return {
      introspect: () => introspectMysql(pool, config.database),
      async executeQuery(req, emitBatch) {
        const connection = await pool.getConnection();
        try {
          await connection.query(
            `SET SESSION MAX_EXECUTION_TIME = ${Math.max(1, Math.floor(req.timeoutMs))}`,
          );
          const rawConnection = (
            connection as unknown as { connection?: { query: (options: unknown) => unknown } }
          ).connection;
          const querySource = (rawConnection ?? connection) as unknown as {
            query: (options: { sql: string; rowsAsArray: boolean; values?: unknown[] }) => unknown;
          };
          const query = querySource.query({
            sql: req.sql,
            rowsAsArray: true,
            values: req.params,
          }) as unknown as {
            on(event: "fields", listener: (fields: Array<{ name: string }>) => void): unknown;
            stream(options?: { highWaterMark?: number }): AsyncIterable<unknown[]>;
          };
          let columns: Array<{ name: string; type: "unknown" }> = [];
          query.on("fields", (fields) => {
            columns = fields.map((f) => ({ name: f.name, type: "unknown" as const }));
          });
          let rows: unknown[][] = [];
          for await (const row of query.stream({ highWaterMark: req.batchSize })) {
            if (req.signal?.aborted) break;
            rows.push(Array.isArray(row) ? row : Object.values(row as Record<string, unknown>));
            if (rows.length >= req.batchSize) {
              await emitBatch({ columns, rows });
              rows = [];
            }
          }
          if (rows.length > 0) await emitBatch({ columns, rows });
          else if (columns.length > 0) await emitBatch({ columns, rows: [] });
        } finally {
          connection.release();
        }
      },
      async close() {
        await pool.end();
      },
    };
  },
});
