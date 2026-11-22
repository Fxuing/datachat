import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { semanticMetrics, semanticRelations } from "../schema.js";

export type SemanticMetricRow = typeof semanticMetrics.$inferSelect;
export type SemanticRelationRow = typeof semanticRelations.$inferSelect;
export type SemanticJoinType = "inner" | "left" | "right";

export interface SemanticMetricDto {
  id: string;
  datasourceId: string;
  name: string;
  synonyms: string[];
  description: string | null;
  sqlExpression: string;
  tableName: string | null;
  defaultFilters: string[];
  timeColumn: string | null;
  unit: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SemanticRelationDto {
  id: string;
  datasourceId: string;
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  joinType: SemanticJoinType;
  description: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface InsertSemanticMetricInput {
  datasourceId: string;
  name: string;
  synonyms?: string[];
  description?: string | null;
  sqlExpression: string;
  tableName?: string | null;
  defaultFilters?: string[];
  timeColumn?: string | null;
  unit?: string | null;
  enabled?: boolean;
}

export interface UpdateSemanticMetricInput {
  name?: string;
  synonyms?: string[];
  description?: string | null;
  sqlExpression?: string;
  tableName?: string | null;
  defaultFilters?: string[];
  timeColumn?: string | null;
  unit?: string | null;
  enabled?: boolean;
}

export interface InsertSemanticRelationInput {
  datasourceId: string;
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  joinType?: SemanticJoinType;
  description?: string | null;
  enabled?: boolean;
}

export interface UpdateSemanticRelationInput {
  leftTable?: string;
  leftColumn?: string;
  rightTable?: string;
  rightColumn?: string;
  joinType?: SemanticJoinType;
  description?: string | null;
  enabled?: boolean;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function cleanStringArray(values: string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function toSemanticMetricDto(row: SemanticMetricRow): SemanticMetricDto {
  return {
    id: row.id,
    datasourceId: row.datasourceId,
    name: row.name,
    synonyms: parseStringArray(row.synonymsJson),
    description: row.description,
    sqlExpression: row.sqlExpression,
    tableName: row.tableName,
    defaultFilters: parseStringArray(row.defaultFiltersJson),
    timeColumn: row.timeColumn,
    unit: row.unit,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSemanticRelationDto(row: SemanticRelationRow): SemanticRelationDto {
  return {
    id: row.id,
    datasourceId: row.datasourceId,
    leftTable: row.leftTable,
    leftColumn: row.leftColumn,
    rightTable: row.rightTable,
    rightColumn: row.rightColumn,
    joinType: row.joinType,
    description: row.description,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listSemanticMetrics(
  db: Db,
  datasourceId: string,
  opts: { onlyEnabled?: boolean } = {},
): SemanticMetricDto[] {
  const where = opts.onlyEnabled
    ? and(eq(semanticMetrics.datasourceId, datasourceId), eq(semanticMetrics.enabled, 1))
    : eq(semanticMetrics.datasourceId, datasourceId);
  return db
    .select()
    .from(semanticMetrics)
    .where(where)
    .orderBy(asc(semanticMetrics.name), asc(semanticMetrics.id))
    .all()
    .map(toSemanticMetricDto);
}

export function findSemanticMetric(
  db: Db,
  datasourceId: string,
  id: string,
): SemanticMetricRow | undefined {
  return db
    .select()
    .from(semanticMetrics)
    .where(and(eq(semanticMetrics.id, id), eq(semanticMetrics.datasourceId, datasourceId)))
    .get();
}

export function insertSemanticMetric(
  db: Db,
  input: InsertSemanticMetricInput,
): SemanticMetricDto {
  const now = Date.now();
  const row = db
    .insert(semanticMetrics)
    .values({
      id: randomUUID(),
      datasourceId: input.datasourceId,
      name: input.name.trim(),
      synonymsJson: JSON.stringify(cleanStringArray(input.synonyms)),
      description: input.description?.trim() || null,
      sqlExpression: input.sqlExpression.trim(),
      tableName: input.tableName?.trim() || null,
      defaultFiltersJson: JSON.stringify(cleanStringArray(input.defaultFilters)),
      timeColumn: input.timeColumn?.trim() || null,
      unit: input.unit?.trim() || null,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toSemanticMetricDto(row);
}

export function updateSemanticMetric(
  db: Db,
  datasourceId: string,
  id: string,
  patch: UpdateSemanticMetricInput,
): SemanticMetricDto | undefined {
  const values: Partial<typeof semanticMetrics.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.synonyms !== undefined) {
    values.synonymsJson = JSON.stringify(cleanStringArray(patch.synonyms));
  }
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  if (patch.sqlExpression !== undefined) values.sqlExpression = patch.sqlExpression.trim();
  if (patch.tableName !== undefined) values.tableName = patch.tableName?.trim() || null;
  if (patch.defaultFilters !== undefined) {
    values.defaultFiltersJson = JSON.stringify(cleanStringArray(patch.defaultFilters));
  }
  if (patch.timeColumn !== undefined) values.timeColumn = patch.timeColumn?.trim() || null;
  if (patch.unit !== undefined) values.unit = patch.unit?.trim() || null;
  if (patch.enabled !== undefined) values.enabled = patch.enabled ? 1 : 0;

  const row = db
    .update(semanticMetrics)
    .set(values)
    .where(and(eq(semanticMetrics.id, id), eq(semanticMetrics.datasourceId, datasourceId)))
    .returning()
    .get();
  return row ? toSemanticMetricDto(row) : undefined;
}

export function deleteSemanticMetric(db: Db, datasourceId: string, id: string): boolean {
  return (
    db
      .delete(semanticMetrics)
      .where(and(eq(semanticMetrics.id, id), eq(semanticMetrics.datasourceId, datasourceId)))
      .run().changes > 0
  );
}

export function listSemanticRelations(
  db: Db,
  datasourceId: string,
  opts: { onlyEnabled?: boolean } = {},
): SemanticRelationDto[] {
  const where = opts.onlyEnabled
    ? and(eq(semanticRelations.datasourceId, datasourceId), eq(semanticRelations.enabled, 1))
    : eq(semanticRelations.datasourceId, datasourceId);
  return db
    .select()
    .from(semanticRelations)
    .where(where)
    .orderBy(asc(semanticRelations.leftTable), asc(semanticRelations.rightTable), asc(semanticRelations.id))
    .all()
    .map(toSemanticRelationDto);
}

export function insertSemanticRelation(
  db: Db,
  input: InsertSemanticRelationInput,
): SemanticRelationDto {
  const now = Date.now();
  const row = db
    .insert(semanticRelations)
    .values({
      id: randomUUID(),
      datasourceId: input.datasourceId,
      leftTable: input.leftTable.trim(),
      leftColumn: input.leftColumn.trim(),
      rightTable: input.rightTable.trim(),
      rightColumn: input.rightColumn.trim(),
      joinType: input.joinType ?? "left",
      description: input.description?.trim() || null,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toSemanticRelationDto(row);
}

export function updateSemanticRelation(
  db: Db,
  datasourceId: string,
  id: string,
  patch: UpdateSemanticRelationInput,
): SemanticRelationDto | undefined {
  const values: Partial<typeof semanticRelations.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (patch.leftTable !== undefined) values.leftTable = patch.leftTable.trim();
  if (patch.leftColumn !== undefined) values.leftColumn = patch.leftColumn.trim();
  if (patch.rightTable !== undefined) values.rightTable = patch.rightTable.trim();
  if (patch.rightColumn !== undefined) values.rightColumn = patch.rightColumn.trim();
  if (patch.joinType !== undefined) values.joinType = patch.joinType;
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  if (patch.enabled !== undefined) values.enabled = patch.enabled ? 1 : 0;

  const row = db
    .update(semanticRelations)
    .set(values)
    .where(and(eq(semanticRelations.id, id), eq(semanticRelations.datasourceId, datasourceId)))
    .returning()
    .get();
  return row ? toSemanticRelationDto(row) : undefined;
}

export function deleteSemanticRelation(db: Db, datasourceId: string, id: string): boolean {
  return (
    db
      .delete(semanticRelations)
      .where(and(eq(semanticRelations.id, id), eq(semanticRelations.datasourceId, datasourceId)))
      .run().changes > 0
  );
}
