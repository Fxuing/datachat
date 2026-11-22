import type { OptionValue } from "@datachat/datasource-sdk";
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
import { resolveDatasourceOptions } from "../drivers/options.js";
import { defaultDriverRegistry, type DriverRegistry } from "../drivers/registry.js";

export interface DatasourceConnection {
  id: string;
  type: DatasourceRow["type"];
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: DatasourceRow["sslMode"];
  options?: Record<string, OptionValue | undefined>;
}

export interface SchemaIntrospector {
  (datasource: DatasourceRow, connection: DatasourceConnection): Promise<SchemaSnapshot>;
}

export interface SchemaRefreshDeps {
  db: Db;
  pools: PoolRegistry;
  config: AppConfig;
  drivers?: DriverRegistry;
  /** Test seam; defaults to the real driver introspection. */
  introspect?: SchemaIntrospector;
}

export class SchemaRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaRefreshError";
  }
}

const inFlight = new Map<string, Promise<SchemaSnapshot>>();

function connectionFor(
  datasource: DatasourceRow,
  key: Buffer,
  drivers: DriverRegistry,
): { connection: DatasourceConnection; secrets: string[] } {
  const password = decryptSecret(datasource.passwordCipher, key);
  const driver = drivers.get(datasource.type);
  const resolved = driver
    ? resolveDatasourceOptions(driver.manifest.optionsSchema, datasource.optionsJson, key)
    : { options: {}, secrets: [] };
  return {
    connection: {
      id: datasource.id,
      type: datasource.type,
      host: datasource.host,
      port: datasource.port,
      database: datasource.database,
      username: datasource.username,
      password,
      sslMode: datasource.sslMode,
      options: resolved.options,
    },
    secrets: [password, ...resolved.secrets],
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

  const drivers = deps.drivers ?? defaultDriverRegistry;
  const task = (async () => {
    const key = deriveSecretKey(deps.config.appSecret);
    const { connection, secrets } = connectionFor(datasource, key, drivers);
    try {
      let snapshot: SchemaSnapshot;
      if (deps.introspect) {
        snapshot = await deps.introspect(datasource, connection);
      } else if (datasource.type === "mysql") {
        snapshot = await introspectMysql(deps.pools.get(connection).mysql!, datasource.database);
      } else if (datasource.type === "postgres") {
        snapshot = await introspectPostgres(deps.pools.get(connection).pg!);
      } else {
        const driver = drivers.get(datasource.type);
        if (!driver) {
          throw new Error(`未安装「${datasource.type}」数据源驱动插件`);
        }
        const pool = deps.pools.get(connection).custom;
        if (!pool) {
          throw new Error(`无法初始化「${datasource.type}」数据源连接池`);
        }
        snapshot = await pool.introspect();
      }
      saveSchema(deps.db, datasource.id, snapshot);
      return snapshot;
    } catch (error) {
      const message = safeErrorMessage(error, secrets);
      saveSchemaError(deps.db, datasource.id, message);
      throw new SchemaRefreshError(message);
    }
  })().finally(() => {
    inFlight.delete(datasource.id);
  });

  inFlight.set(datasource.id, task);
  return task;
}
