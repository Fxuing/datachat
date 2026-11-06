import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { datasourceSchemaCache } from "../schema.js";
import type { SchemaSnapshot } from "../../agent/datasource/introspect.js";

/** Spec §9: cached schemas expire after 24 hours and refresh lazily on access. */
export const SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SchemaCacheEntry {
  snapshot: SchemaSnapshot;
  tableCount: number;
  refreshedAt: number;
  error: string | null;
}

export function saveSchema(db: Db, datasourceId: string, snapshot: SchemaSnapshot): void {
  const payloadJson = JSON.stringify(snapshot);
  db.insert(datasourceSchemaCache)
    .values({
      datasourceId,
      payloadJson,
      tableCount: snapshot.tables.length,
      refreshedAt: snapshot.refreshedAt,
      error: null,
    })
    .onConflictDoUpdate({
      target: datasourceSchemaCache.datasourceId,
      set: {
        payloadJson,
        tableCount: snapshot.tables.length,
        refreshedAt: snapshot.refreshedAt,
        error: null,
      },
    })
    .run();
}

/** Record a failed refresh without discarding the last good snapshot. */
export function saveSchemaError(db: Db, datasourceId: string, message: string): void {
  db.update(datasourceSchemaCache)
    .set({ error: message })
    .where(eq(datasourceSchemaCache.datasourceId, datasourceId))
    .run();
}

export function loadSchemaEntry(db: Db, datasourceId: string): SchemaCacheEntry | null {
  const row = db
    .select()
    .from(datasourceSchemaCache)
    .where(eq(datasourceSchemaCache.datasourceId, datasourceId))
    .get();
  if (!row) return null;
  try {
    const snapshot = JSON.parse(row.payloadJson) as SchemaSnapshot;
    if (!snapshot || !Array.isArray(snapshot.tables)) return null;
    return {
      snapshot,
      tableCount: row.tableCount,
      refreshedAt: row.refreshedAt,
      error: row.error,
    };
  } catch {
    return null;
  }
}

export function loadSchema(db: Db, datasourceId: string): SchemaSnapshot | null {
  return loadSchemaEntry(db, datasourceId)?.snapshot ?? null;
}
