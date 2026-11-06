import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client.js";

/** Source layout: `apps/server/src/db` → `apps/server/drizzle`. */
const SOURCE_MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
/** Build layout: `apps/server/dist/db` → `apps/server/dist/drizzle`. */
const DIST_MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Prefer the folder that matches the running layout (src vs dist). */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_DIST_LAYOUT = path.basename(path.dirname(MODULE_DIR)) === "dist";
const DEFAULT_MIGRATIONS_DIRS = IS_DIST_LAYOUT
  ? [DIST_MIGRATIONS_DIR, SOURCE_MIGRATIONS_DIR]
  : [SOURCE_MIGRATIONS_DIR, DIST_MIGRATIONS_DIR];

export interface MigrateLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface MigrateDbOptions {
  /** Explicit migrations folder; defaults to MIGRATIONS_DIR, then the source/dist layouts. */
  migrationsFolder?: string;
  logger?: MigrateLogger;
}

function hasJournal(folder: string): boolean {
  return fs.existsSync(path.join(folder, "meta", "_journal.json"));
}

export function resolveMigrationsFolder(override?: string): string {
  const requested = override ?? process.env.MIGRATIONS_DIR;
  const candidates = requested ? [path.resolve(requested)] : DEFAULT_MIGRATIONS_DIRS;

  for (const folder of candidates) {
    if (hasJournal(folder)) return folder;
  }

  throw new Error(
    `Drizzle migrations not found: expected "meta/_journal.json" in ${candidates
      .map((folder) => `"${folder}"`)
      .join(" or ")}`,
  );
}

/** Applies pending migrations and returns the total number recorded as applied. */
export function migrateDb(db: Db, options: MigrateDbOptions = {}): number {
  const migrationsFolder = resolveMigrationsFolder(options.migrationsFolder);
  migrate(db, { migrationsFolder });
  const row = db.get<{ count: number }>(
    sql`select count(*) as count from __drizzle_migrations`,
  );
  const applied = Number(row?.count ?? 0);
  options.logger?.info({ migrationsFolder, applied }, "drizzle migrations applied");
  return applied;
}
