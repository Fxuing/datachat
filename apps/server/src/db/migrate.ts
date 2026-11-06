import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
