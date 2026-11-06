import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import type { DatasourceType } from "@datachat/shared";

export interface ProbeInput {
  type: DatasourceType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: "disable" | "require";
}

export interface ProbeResult {
  ok: boolean;
  serverVersion?: string;
  readOnly: boolean;
  warnings: string[];
  error?: string;
}

/** Collapse driver errors so responses stay single-line and never echo the password. */
export function safeErrorMessage(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join("***");
  message = message.replace(/\s+/g, " ").trim();
  return message.slice(0, 500) || "连接失败";
}

export async function probeDatasource(input: ProbeInput): Promise<ProbeResult> {
  if (input.type === "mysql") {
    let connection: mysql.Connection | undefined;
    try {
      connection = await mysql.createConnection({
        host: input.host,
        port: input.port,
        database: input.database,
        user: input.username,
        password: input.password,
        connectTimeout: 10_000,
        ssl: input.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
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
        error: safeErrorMessage(error, input.password),
      };
    } finally {
      await connection?.end().catch(() => undefined);
    }
  }

  const client = new PgClient({
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.username,
    password: input.password,
    connectionTimeoutMillis: 10_000,
    ssl: input.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
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
    return { ok: true, serverVersion: version, readOnly: defaultReadOnly && !writeGrant, warnings };
  } catch (error) {
    return {
      ok: false,
      readOnly: false,
      warnings: [],
      error: safeErrorMessage(error, input.password),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
