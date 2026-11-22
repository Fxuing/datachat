import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import { dashboardCards, dashboards, datasources } from "../schema.js";

export type DashboardRow = typeof dashboards.$inferSelect;
export type DashboardCardRow = typeof dashboardCards.$inferSelect;

export interface DashboardSummaryDto {
  id: string;
  name: string;
  description: string | null;
  cardCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardCardDto {
  id: string;
  dashboardId: string;
  title: string;
  sourceConversationId: string | null;
  sourceArtifactId: string | null;
  datasourceId: string | null;
  datasourceName: string | null;
  refreshable: boolean;
  spec: unknown;
  points: number;
  width: 1 | 2;
  position: number;
  lastRefreshedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardDetailDto extends DashboardSummaryDto {
  cards: DashboardCardDto[];
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function toDashboardCardDto(
  row: DashboardCardRow,
  datasourceName: string | null = null,
): DashboardCardDto {
  return {
    id: row.id,
    dashboardId: row.dashboardId,
    title: row.title,
    sourceConversationId: row.sourceConversationId,
    sourceArtifactId: row.sourceArtifactId,
    datasourceId: row.datasourceId,
    datasourceName,
    refreshable: Boolean(row.datasourceId && row.sqlText && row.chartConfigJson),
    spec: safeParseJson(row.specJson),
    points: row.points,
    width: row.width === 2 ? 2 : 1,
    position: row.position,
    lastRefreshedAt: row.lastRefreshedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listDashboardsByUser(db: Db, userId: string): DashboardSummaryDto[] {
  const rows = db
    .select()
    .from(dashboards)
    .where(eq(dashboards.userId, userId))
    .orderBy(desc(dashboards.updatedAt), desc(dashboards.id))
    .all();
  if (rows.length === 0) return [];

  const cardRows = db
    .select({ dashboardId: dashboardCards.dashboardId })
    .from(dashboardCards)
    .where(
      inArray(
        dashboardCards.dashboardId,
        rows.map((r) => r.id),
      ),
    )
    .all();

  const counts = new Map<string, number>();
  for (const item of cardRows) {
    counts.set(item.dashboardId, (counts.get(item.dashboardId) ?? 0) + 1);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    cardCount: counts.get(row.id) ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export function findOwnedDashboard(
  db: Db,
  id: string,
  userId: string,
): DashboardRow | undefined {
  return db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.id, id), eq(dashboards.userId, userId)))
    .get();
}

export function insertDashboard(
  db: Db,
  input: { userId: string; name: string; description?: string | null },
): DashboardSummaryDto {
  const now = Date.now();
  const row = db
    .insert(dashboards)
    .values({
      id: randomUUID(),
      userId: input.userId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cardCount: 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function updateOwnedDashboard(
  db: Db,
  id: string,
  userId: string,
  patch: { name?: string; description?: string | null },
): DashboardRow | undefined {
  const values: Partial<typeof dashboards.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  return db
    .update(dashboards)
    .set(values)
    .where(and(eq(dashboards.id, id), eq(dashboards.userId, userId)))
    .returning()
    .get();
}

export function deleteOwnedDashboard(db: Db, id: string, userId: string): boolean {
  return (
    db
      .delete(dashboards)
      .where(and(eq(dashboards.id, id), eq(dashboards.userId, userId)))
      .run().changes > 0
  );
}

export function listDashboardCardRows(db: Db, dashboardId: string): DashboardCardRow[] {
  return db
    .select()
    .from(dashboardCards)
    .where(eq(dashboardCards.dashboardId, dashboardId))
    .orderBy(asc(dashboardCards.position), asc(dashboardCards.createdAt))
    .all();
}

export function listDashboardCardsWithDatasourceNames(
  db: Db,
  dashboardId: string,
): DashboardCardDto[] {
  const rows = listDashboardCardRows(db, dashboardId);
  const dsIds = [
    ...new Set(
      rows
        .map((r) => r.datasourceId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const dsMap = new Map<string, string>();
  if (dsIds.length > 0) {
    const dsRows = db
      .select({ id: datasources.id, name: datasources.name })
      .from(datasources)
      .where(inArray(datasources.id, dsIds))
      .all();
    for (const ds of dsRows) dsMap.set(ds.id, ds.name);
  }
  return rows.map((row) =>
    toDashboardCardDto(row, row.datasourceId ? (dsMap.get(row.datasourceId) ?? null) : null),
  );
}

export function findOwnedDashboardCard(
  db: Db,
  dashboardId: string,
  cardId: string,
  userId: string,
): DashboardCardRow | undefined {
  return db
    .select()
    .from(dashboardCards)
    .where(
      and(
        eq(dashboardCards.id, cardId),
        eq(dashboardCards.dashboardId, dashboardId),
        eq(dashboardCards.userId, userId),
      ),
    )
    .get();
}

export function insertDashboardCard(
  db: Db,
  input: {
    dashboardId: string;
    userId: string;
    title: string;
    sourceConversationId: string | null;
    sourceArtifactId: string | null;
    datasourceId: string | null;
    sqlText: string | null;
    chartConfigJson: string | null;
    specJson: string;
    points: number;
    width: 1 | 2;
    position: number;
    lastRefreshedAt: number | null;
  },
): DashboardCardRow {
  const now = Date.now();
  const row = db
    .insert(dashboardCards)
    .values({
      id: randomUUID(),
      dashboardId: input.dashboardId,
      userId: input.userId,
      title: input.title,
      sourceConversationId: input.sourceConversationId,
      sourceArtifactId: input.sourceArtifactId,
      datasourceId: input.datasourceId,
      sqlText: input.sqlText,
      chartConfigJson: input.chartConfigJson,
      specJson: input.specJson,
      points: input.points,
      width: input.width,
      position: input.position,
      lastRefreshedAt: input.lastRefreshedAt,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  db.update(dashboards)
    .set({ updatedAt: now })
    .where(eq(dashboards.id, input.dashboardId))
    .run();
  return row;
}

export function updateOwnedDashboardCard(
  db: Db,
  dashboardId: string,
  cardId: string,
  userId: string,
  patch: {
    title?: string;
    width?: 1 | 2;
    position?: number;
    sqlText?: string;
    specJson?: string;
    points?: number;
    lastRefreshedAt?: number | null;
    lastError?: string | null;
  },
): DashboardCardRow | undefined {
  const now = Date.now();
  const values: Partial<typeof dashboardCards.$inferInsert> = {
    updatedAt: now,
  };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.width !== undefined) values.width = patch.width;
  if (patch.position !== undefined) values.position = patch.position;
  if (patch.sqlText !== undefined) values.sqlText = patch.sqlText;
  if (patch.specJson !== undefined) values.specJson = patch.specJson;
  if (patch.points !== undefined) values.points = patch.points;
  if (patch.lastRefreshedAt !== undefined) values.lastRefreshedAt = patch.lastRefreshedAt;
  if (patch.lastError !== undefined) values.lastError = patch.lastError;

  const updated = db
    .update(dashboardCards)
    .set(values)
    .where(
      and(
        eq(dashboardCards.id, cardId),
        eq(dashboardCards.dashboardId, dashboardId),
        eq(dashboardCards.userId, userId),
      ),
    )
    .returning()
    .get();
  if (updated) {
    db.update(dashboards)
      .set({ updatedAt: now })
      .where(eq(dashboards.id, dashboardId))
      .run();
  }
  return updated;
}

export function reorderDashboardCards(
  db: Db,
  dashboardId: string,
  userId: string,
  orderedCardIds: string[],
): boolean {
  const dashboard = findOwnedDashboard(db, dashboardId, userId);
  if (!dashboard) return false;
  const now = Date.now();
  db.transaction((tx) => {
    orderedCardIds.forEach((cardId, index) => {
      tx.update(dashboardCards)
        .set({ position: index, updatedAt: now })
        .where(
          and(
            eq(dashboardCards.id, cardId),
            eq(dashboardCards.dashboardId, dashboardId),
            eq(dashboardCards.userId, userId),
          ),
        )
        .run();
    });
    tx.update(dashboards)
      .set({ updatedAt: now })
      .where(eq(dashboards.id, dashboardId))
      .run();
  });
  return true;
}

export function deleteOwnedDashboardCard(
  db: Db,
  dashboardId: string,
  cardId: string,
  userId: string,
): boolean {
  const changes = db
    .delete(dashboardCards)
    .where(
      and(
        eq(dashboardCards.id, cardId),
        eq(dashboardCards.dashboardId, dashboardId),
        eq(dashboardCards.userId, userId),
      ),
    )
    .run().changes;
  if (changes > 0) {
    db.update(dashboards)
      .set({ updatedAt: Date.now() })
      .where(eq(dashboards.id, dashboardId))
      .run();
  }
  return changes > 0;
}
