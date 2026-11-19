import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { conversationFiles, conversationFileTables } from "../schema.js";

export type FileColumnType = "INTEGER" | "REAL" | "TEXT" | "DATE" | "DATETIME";
export type FileColumnFormatHint = "currency" | "percent" | "thousands";

export interface FileTableColumn {
  name: string;
  originalName: string;
  type: FileColumnType;
  nullable: boolean;
  formatHint?: FileColumnFormatHint;
  sampleValues: string[];
}

export interface ConversationFileSummary {
  id: string;
  conversationId: string;
  fileName: string;
  fileType: "xlsx" | "csv";
  sizeBytes: number;
  headerRow: number;
  tableCount: number;
  rowCount: number;
  createdAt: number;
}

export interface ConversationFileTableSummary {
  id: string;
  conversationId: string;
  fileId: string;
  tableName: string;
  displayName: string;
  sheetName: string | null;
  rowCount: number;
  columns: FileTableColumn[];
  sampleRows: Array<Array<string | number | null>>;
  warnings: string[];
  createdAt: number;
}

export type ConversationFileRow = typeof conversationFiles.$inferSelect;
export type ConversationFileTableRow = typeof conversationFileTables.$inferSelect;

export interface InsertConversationFileInput {
  id?: string;
  conversationId: string;
  userId: string;
  fileName: string;
  fileType: "xlsx" | "csv";
  sizeBytes: number;
  headerRow: number;
  tableCount: number;
  rowCount: number;
  createdAt?: number;
}

export interface InsertConversationFileTableInput {
  id?: string;
  conversationId: string;
  fileId: string;
  tableName: string;
  displayName: string;
  sheetName: string | null;
  rowCount: number;
  columns: FileTableColumn[];
  sampleRows: Array<Array<string | number | null>>;
  warnings: string[];
  createdAt?: number;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toConversationFileSummary(row: ConversationFileRow): ConversationFileSummary {
  return {
    id: row.id,
    conversationId: row.conversationId,
    fileName: row.fileName,
    fileType: row.fileType,
    sizeBytes: row.sizeBytes,
    headerRow: row.headerRow,
    tableCount: row.tableCount,
    rowCount: row.rowCount,
    createdAt: row.createdAt,
  };
}

export function toConversationFileTableSummary(
  row: ConversationFileTableRow,
): ConversationFileTableSummary {
  const columns = safeJsonParse<unknown>(row.columnsJson, []);
  const sampleRows = safeJsonParse<unknown>(row.sampleRowsJson, []);
  const warnings = safeJsonParse<unknown>(row.warningsJson, []);
  return {
    id: row.id,
    conversationId: row.conversationId,
    fileId: row.fileId,
    tableName: row.tableName,
    displayName: row.displayName,
    sheetName: row.sheetName,
    rowCount: row.rowCount,
    columns: Array.isArray(columns) ? (columns as FileTableColumn[]) : [],
    sampleRows: Array.isArray(sampleRows)
      ? (sampleRows as Array<Array<string | number | null>>)
      : [],
    warnings: Array.isArray(warnings) ? (warnings as string[]) : [],
    createdAt: row.createdAt,
  };
}

export function insertConversationFile(
  db: Db,
  input: InsertConversationFileInput,
): ConversationFileRow {
  return db
    .insert(conversationFiles)
    .values({
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      userId: input.userId,
      fileName: input.fileName,
      fileType: input.fileType,
      sizeBytes: input.sizeBytes,
      headerRow: input.headerRow,
      tableCount: input.tableCount,
      rowCount: input.rowCount,
      createdAt: input.createdAt ?? Date.now(),
    })
    .returning()
    .get();
}

export function insertConversationFileTable(
  db: Db,
  input: InsertConversationFileTableInput,
): ConversationFileTableRow {
  return db
    .insert(conversationFileTables)
    .values({
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      fileId: input.fileId,
      tableName: input.tableName,
      displayName: input.displayName,
      sheetName: input.sheetName,
      rowCount: input.rowCount,
      columnsJson: JSON.stringify(input.columns),
      sampleRowsJson: JSON.stringify(input.sampleRows),
      warningsJson: JSON.stringify(input.warnings),
      createdAt: input.createdAt ?? Date.now(),
    })
    .returning()
    .get();
}

export function listConversationFiles(db: Db, conversationId: string): ConversationFileSummary[] {
  return db
    .select()
    .from(conversationFiles)
    .where(eq(conversationFiles.conversationId, conversationId))
    .orderBy(asc(conversationFiles.createdAt))
    .all()
    .map(toConversationFileSummary);
}

export function listConversationFileTables(
  db: Db,
  conversationId: string,
): ConversationFileTableSummary[] {
  return db
    .select()
    .from(conversationFileTables)
    .where(eq(conversationFileTables.conversationId, conversationId))
    .orderBy(asc(conversationFileTables.createdAt))
    .all()
    .map(toConversationFileTableSummary);
}

export function summarizeConversationFileStorage(
  db: Db,
  conversationId: string,
): { tableCount: number; rowCount: number; tableNames: Set<string> } {
  const rows = db
    .select({
      tableName: conversationFileTables.tableName,
      rowCount: conversationFileTables.rowCount,
    })
    .from(conversationFileTables)
    .where(eq(conversationFileTables.conversationId, conversationId))
    .all();
  let rowCount = 0;
  const tableNames = new Set<string>();
  for (const row of rows) {
    rowCount += row.rowCount;
    tableNames.add(row.tableName);
  }
  return { tableCount: rows.length, rowCount, tableNames };
}
