import { access, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import type { FileTableColumn } from "../db/repositories/conversation-files.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SqliteWritableTable {
  tableName: string;
  columns: FileTableColumn[];
  rows: Array<Array<string | number | null>>;
}

export function assertValidConversationId(conversationId: string): string {
  if (!UUID_RE.test(conversationId)) {
    throw new Error(`非法的会话 ID: ${conversationId}`);
  }
  return conversationId;
}

export function resolveConversationFileDir(dataDir: string, conversationId: string): string {
  assertValidConversationId(conversationId);
  const filesRoot = path.resolve(dataDir, "files");
  const target = path.resolve(filesRoot, conversationId);
  if (!target.startsWith(filesRoot + path.sep)) {
    throw new Error("文件路径越界");
  }
  return target;
}

export function resolveConversationSqlitePath(dataDir: string, conversationId: string): string {
  return path.join(resolveConversationFileDir(dataDir, conversationId), "data.sqlite");
}

export function quoteSqliteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function sqliteColumnAffinity(type: FileTableColumn["type"]): "INTEGER" | "REAL" | "TEXT" {
  if (type === "INTEGER") return "INTEGER";
  if (type === "REAL") return "REAL";
  return "TEXT";
}

function normalizeSqliteBindValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function insertTablesInTransaction(
  db: Database.Database,
  tables: SqliteWritableTable[],
): void {
  const writeAll = db.transaction((items: SqliteWritableTable[]) => {
    for (const table of items) {
      if (table.columns.length === 0) continue;
      const quotedTable = quoteSqliteIdent(table.tableName);
      const colDefs = table.columns
        .map((column) => `${quoteSqliteIdent(column.name)} ${sqliteColumnAffinity(column.type)}`)
        .join(", ");
      db.exec(`CREATE TABLE ${quotedTable} (${colDefs})`);

      if (table.rows.length === 0) continue;
      const colNames = table.columns.map((column) => quoteSqliteIdent(column.name)).join(", ");
      const placeholders = table.columns.map(() => "?").join(", ");
      const insertStmt = db.prepare(
        `INSERT INTO ${quotedTable} (${colNames}) VALUES (${placeholders})`,
      );
      for (const row of table.rows) {
        const bound = new Array<string | number | null>(table.columns.length);
        for (let i = 0; i < table.columns.length; i += 1) {
          bound[i] = normalizeSqliteBindValue(row[i]);
        }
        insertStmt.run(...bound);
      }
    }
  });
  writeAll(tables);
}

/**
 * Write parsed tables into an isolated per-conversation SQLite database.
 * Uses DELETE journal mode so subsequent read-only worker connections never need
 * write access for WAL `-shm` sidecar creation.
 */
export async function writeTablesToSqlite(
  sqlitePath: string,
  tables: SqliteWritableTable[],
  options: { mode: "create" | "append" },
): Promise<void> {
  const dir = path.dirname(sqlitePath);
  await mkdir(dir, { recursive: true });

  if (options.mode === "create") {
    const tmpPath = `${sqlitePath}.${process.pid}.${Date.now()}.tmp`;
    let db: Database.Database | undefined;
    try {
      db = new Database(tmpPath);
      db.pragma("journal_mode = DELETE");
      db.pragma("synchronous = OFF");
      insertTablesInTransaction(db, tables);
      db.close();
      db = undefined;
      await rename(tmpPath, sqlitePath);
    } catch (error) {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore close error during cleanup
        }
      }
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return;
  }

  // Append mode requires the existing conversation database file.
  await access(sqlitePath);
  let db: Database.Database | undefined;
  try {
    db = new Database(sqlitePath, { fileMustExist: true });
    db.pragma("journal_mode = DELETE");
    db.pragma("busy_timeout = 5000");
    insertTablesInTransaction(db, tables);
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close error
      }
    }
  }
}

export async function removeConversationFileDir(
  dataDir: string,
  conversationId: string,
): Promise<void> {
  if (!UUID_RE.test(conversationId)) return;
  const dir = resolveConversationFileDir(dataDir, conversationId);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

export async function conversationFileBytes(
  dataDir: string,
  conversationId: string,
): Promise<number> {
  if (!UUID_RE.test(conversationId)) return 0;
  try {
    const sqlitePath = resolveConversationSqlitePath(dataDir, conversationId);
    return (await stat(sqlitePath)).size;
  } catch {
    return 0;
  }
}

export async function sqliteFileExists(sqlitePath: string): Promise<boolean> {
  try {
    await access(sqlitePath);
    return true;
  } catch {
    return false;
  }
}

export function resolveDatasetDir(dataDir: string, datasetId: string): string {
  if (!UUID_RE.test(datasetId)) {
    throw new Error(`非法的数据集 ID: ${datasetId}`);
  }
  const datasetsRoot = path.resolve(dataDir, "datasets");
  const target = path.resolve(datasetsRoot, datasetId);
  if (!target.startsWith(datasetsRoot + path.sep)) {
    throw new Error("文件路径越界");
  }
  return target;
}

export function resolveDatasetSqlitePath(dataDir: string, datasetId: string): string {
  return path.join(resolveDatasetDir(dataDir, datasetId), "data.sqlite");
}

/** Atomically copy a SQLite database file to a new destination path. */
export async function copySqliteFile(srcPath: string, destPath: string): Promise<number> {
  await access(srcPath);
  const dir = path.dirname(destPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${destPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await copyFile(srcPath, tmpPath);
    await rename(tmpPath, destPath);
    return (await stat(destPath)).size;
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeDatasetDir(dataDir: string, datasetId: string): Promise<void> {
  if (!UUID_RE.test(datasetId)) return;
  const dir = resolveDatasetDir(dataDir, datasetId);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
