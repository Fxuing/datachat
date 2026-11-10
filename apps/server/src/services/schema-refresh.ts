import { decryptSecret, deriveSecretKey } from "../agent/datasource/crypto.js";
import {
  introspectMysql,
  introspectPostgres,
  type SchemaSnapshot,
} from "../agent/datasource/introspect.js";
import { safeErrorMessage } from "../agent/datasource/probe.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { DatasourceRow } from "../db/repositories/datasources.js";
import { saveSchema, saveSchemaError } from "../db/repositories/schema-cache.js";

export interface DatasourceConnection {
  id: string;
  type: DatasourceRow["type"];
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: DatasourceRow["sslMode"];
}

export interface SchemaIntrospector {
  (datasource: DatasourceRow, connection: DatasourceConnection): Promise<SchemaSnapshot>;
}

export interface SchemaRefreshDeps {
  db: Db;
  pools: PoolRegistry;
  config: AppConfig;
  /** Test seam; defaults to the real MySQL/PostgreSQL introspection. */
  introspect?: SchemaIntrospector;
}

export class SchemaRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaRefreshError";
  }
}

const inFlight = new Map<string, Promise<SchemaSnapshot>>();

function connectionFor(datasource: DatasourceRow, key: Buffer): DatasourceConnection {
  return {
    id: datasource.id,
    type: datasource.type,
    host: datasource.host,
    port: datasource.port,
    database: datasource.database,
    username: datasource.username,
    password: decryptSecret(datasource.passwordCipher, key),
    sslMode: datasource.sslMode,
  };
}

/**
 * Introspect a datasource and persist the snapshot. Concurrent callers for the
 * same datasource share one introspection so a cold conversation does not open
 * several metadata queries at once.
 */
export async function refreshDatasourceSchema(
  deps: SchemaRefreshDeps,
  datasource: DatasourceRow,
): Promise<SchemaSnapshot> {
  const running = inFlight.get(datasource.id);
  if (running) return running;

  const task = (async () => {
    const key = deriveSecretKey(deps.config.appSecret);
    const connection = connectionFor(datasource, key);
    try {
      const snapshot = deps.introspect
        ? await deps.introspect(datasource, connection)
        : datasource.type === "mysql"
          ? await introspectMysql(deps.pools.get(connection).mysql!, datasource.database)
          : await introspectPostgres(deps.pools.get(connection).pg!);
      saveSchema(deps.db, datasource.id, snapshot);
      return snapshot;
    } catch (error) {
      const message = safeErrorMessage(error, connection.password);
      saveSchemaError(deps.db, datasource.id, message);
      throw new SchemaRefreshError(message);
    }
  })().finally(() => {
    inFlight.delete(datasource.id);
  });

  inFlight.set(datasource.id, task);
  return task;
}
