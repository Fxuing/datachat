import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  datasourceGrants,
  datasourceSchemaCache,
  datasources,
  mcpServers,
  skills,
} from "../schema.js";
import { isUniqueViolation } from "./users.js";
import type { UserAccess } from "../../auth/access.js";
import type { DatasourceType, OptionValue } from "@datachat/shared";
import { publicDatasourceOptions } from "../../drivers/options.js";
import { defaultDriverRegistry, type DriverRegistry } from "../../drivers/registry.js";

export type DatasourceRow = typeof datasources.$inferSelect;
export type DatasourceInsert = typeof datasources.$inferInsert;

/** Thrown by insertDatasource when the datasource name is already taken. */
export class DuplicateDatasourceNameError extends Error {
  readonly code = "DUPLICATE_DATASOURCE_NAME";

  constructor(readonly datasourceName: string) {
    super(`Datasource name already exists: ${datasourceName}`);
    this.name = "DuplicateDatasourceNameError";
  }
}

export function insertDatasource(db: Db, row: DatasourceInsert): void {
  try {
    db.insert(datasources).values(row).run();
  } catch (error) {
    // Reuse the generic SQLite unique-violation detector from the users repository.
    if (isUniqueViolation(error)) throw new DuplicateDatasourceNameError(row.name);
    throw error;
  }
}

export function updateDatasource(
  db: Db,
  id: string,
  patch: Partial<Omit<DatasourceRow, "id" | "createdAt" | "createdBy">>,
): void {
  try {
    db.update(datasources)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(datasources.id, id))
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateDatasourceNameError(patch.name ?? id);
    throw error;
  }
}

export function deleteDatasource(db: Db, id: string): void {
  // No foreign keys on these tables, so clear dependent rows explicitly. Datasource
  // scoped MCP servers and skills would otherwise become orphaned rows.
  db.transaction((tx) => {
    tx.delete(datasourceGrants).where(eq(datasourceGrants.datasourceId, id)).run();
    tx.delete(datasourceSchemaCache).where(eq(datasourceSchemaCache.datasourceId, id)).run();
    tx.delete(mcpServers).where(eq(mcpServers.datasourceId, id)).run();
    tx.delete(skills)
      .where(and(eq(skills.scope, "datasource"), eq(skills.datasourceId, id)))
      .run();
    tx.delete(datasources).where(eq(datasources.id, id)).run();
  });
}

export function findDatasource(db: Db, id: string): DatasourceRow | undefined {
  return db.select().from(datasources).where(eq(datasources.id, id)).get();
}

export function findDatasourceByName(db: Db, name: string): DatasourceRow | undefined {
  return db
    .select()
    .from(datasources)
    .where(sql`lower(${datasources.name}) = lower(${name})`)
    .get();
}

/** Datasources the resolved access allows; `datasourceIds: null` means all of them. */
export function listDatasourcesForAccess(db: Db, access: UserAccess): DatasourceRow[] {
  if (access.datasourceIds === null) {
    return db.select().from(datasources).all();
  }
  const ids = [...access.datasourceIds];
  if (ids.length === 0) return [];
  return db.select().from(datasources).where(inArray(datasources.id, ids)).all();
}

export interface DatasourceSummary {
  id: string;
  name: string;
  type: DatasourceType;
  driverLabel: string;
  driverAvailable: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: DatasourceRow["sslMode"];
  options: Record<string, OptionValue>;
  secretOptionKeys: string[];
  status: string;
  readOnlyVerified: boolean;
  allowWriteAccount: boolean;
  lastCheckedAt: number | null;
}

export function toDatasourceSummary(
  row: DatasourceRow,
  drivers: DriverRegistry = defaultDriverRegistry,
): DatasourceSummary {
  const driver = drivers.get(row.type);
  const { options, secretOptionKeys } = driver
    ? publicDatasourceOptions(driver.manifest.optionsSchema, row.optionsJson)
    : { options: {}, secretOptionKeys: [] };
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    driverLabel: driver?.manifest.label ?? row.type,
    driverAvailable: Boolean(driver),
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    sslMode: row.sslMode,
    options,
    secretOptionKeys,
    status: row.status,
    readOnlyVerified: Boolean(row.readOnlyVerified),
    allowWriteAccount: Boolean(row.allowWriteAccount),
    lastCheckedAt: row.lastCheckedAt,
  };
}
