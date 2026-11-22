import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import { fileDatasets, fileDatasetTables } from "../schema.js";
import type { FileTableColumn } from "./conversation-files.js";

export type FileDatasetRow = typeof fileDatasets.$inferSelect;
export type FileDatasetTableRow = typeof fileDatasetTables.$inferSelect;

export interface FileDatasetTableSummary {
  id: string;
  datasetId: string;
  tableName: string;
  displayName: string;
  sheetName: string | null;
  rowCount: number;
  columns: FileTableColumn[];
  sampleRows: Array<Array<string | number | null>>;
  warnings: string[];
  createdAt: number;
}

export interface FileDatasetSummary {
  id: string;
  name: string;
  description: string | null;
  fileType: "xlsx" | "csv";
  fileCount: number;
  tableCount: number;
  rowCount: number;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  tables: FileDatasetTableSummary[];
}

export interface InsertFileDatasetInput {
  id?: string;
  userId: string;
  name: string;
  description?: string | null;
  fileType: "xlsx" | "csv";
  fileCount: number;
  tableCount: number;
  rowCount: number;
  sizeBytes: number;
  createdAt?: number;
}

export interface InsertFileDatasetTableInput {
  id?: string;
  datasetId: string;
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

export function toFileDatasetTableSummary(row: FileDatasetTableRow): FileDatasetTableSummary {
  const columns = safeJsonParse<unknown>(row.columnsJson, []);
  const sampleRows = safeJsonParse<unknown>(row.sampleRowsJson, []);
  const warnings = safeJsonParse<unknown>(row.warningsJson, []);
  return {
    id: row.id,
    datasetId: row.datasetId,
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

export function toFileDatasetSummary(
  row: FileDatasetRow,
  tables: FileDatasetTableSummary[],
): FileDatasetSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    fileType: row.fileType,
    fileCount: row.fileCount,
    tableCount: row.tableCount,
    rowCount: row.rowCount,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tables,
  };
}

export function insertFileDataset(db: Db, input: InsertFileDatasetInput): FileDatasetRow {
  const now = input.createdAt ?? Date.now();
  return db
    .insert(fileDatasets)
    .values({
      id: input.id ?? randomUUID(),
      userId: input.userId,
      name: input.name,
      description: input.description ?? null,
      fileType: input.fileType,
      fileCount: input.fileCount,
      tableCount: input.tableCount,
      rowCount: input.rowCount,
      sizeBytes: input.sizeBytes,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function insertFileDatasetTable(
  db: Db,
  input: InsertFileDatasetTableInput,
): FileDatasetTableRow {
  return db
    .insert(fileDatasetTables)
    .values({
      id: input.id ?? randomUUID(),
      datasetId: input.datasetId,
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

export function countFileDatasetsByUser(db: Db, userId: string): number {
  return db
    .select({ id: fileDatasets.id })
    .from(fileDatasets)
    .where(eq(fileDatasets.userId, userId))
    .all().length;
}

export function findOwnedFileDataset(
  db: Db,
  id: string,
  userId: string,
): FileDatasetRow | undefined {
  return db
    .select()
    .from(fileDatasets)
    .where(and(eq(fileDatasets.id, id), eq(fileDatasets.userId, userId)))
    .get();
}

export function listFileDatasetTables(db: Db, datasetId: string): FileDatasetTableSummary[] {
  return db
    .select()
    .from(fileDatasetTables)
    .where(eq(fileDatasetTables.datasetId, datasetId))
    .orderBy(asc(fileDatasetTables.createdAt), asc(fileDatasetTables.tableName))
    .all()
    .map(toFileDatasetTableSummary);
}

export function listFileDatasetsByUser(db: Db, userId: string): FileDatasetSummary[] {
  const rows = db
    .select()
    .from(fileDatasets)
    .where(eq(fileDatasets.userId, userId))
    .orderBy(desc(fileDatasets.updatedAt), desc(fileDatasets.id))
    .all();
  if (rows.length === 0) return [];

  const tableRows = db
    .select()
    .from(fileDatasetTables)
    .where(
      inArray(
        fileDatasetTables.datasetId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(fileDatasetTables.createdAt), asc(fileDatasetTables.tableName))
    .all();

  const tablesByDataset = new Map<string, FileDatasetTableSummary[]>();
  for (const tableRow of tableRows) {
    const list = tablesByDataset.get(tableRow.datasetId) ?? [];
    list.push(toFileDatasetTableSummary(tableRow));
    tablesByDataset.set(tableRow.datasetId, list);
  }

  return rows.map((row) => toFileDatasetSummary(row, tablesByDataset.get(row.id) ?? []));
}

export function updateOwnedFileDataset(
  db: Db,
  id: string,
  userId: string,
  patch: { name?: string; description?: string | null },
): FileDatasetRow | undefined {
  const values: Partial<typeof fileDatasets.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  return db
    .update(fileDatasets)
    .set(values)
    .where(and(eq(fileDatasets.id, id), eq(fileDatasets.userId, userId)))
    .returning()
    .get();
}

export function deleteOwnedFileDataset(db: Db, id: string, userId: string): boolean {
  return (
    db
      .delete(fileDatasets)
      .where(and(eq(fileDatasets.id, id), eq(fileDatasets.userId, userId)))
      .run().changes > 0
  );
}
