import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../client.js";
import { notifications } from "../schema.js";

export type NotificationRow = typeof notifications.$inferSelect;

export interface CreateNotificationInput {
  id: string;
  userId: string;
  type: "task_success" | "task_failed" | "task_disabled";
  title: string;
  body: string;
  href?: string | null;
  createdAt: number;
}

export function createNotification(db: Db, input: CreateNotificationInput): NotificationRow {
  const row = db
    .insert(notifications)
    .values({
      id: input.id,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      href: input.href ?? null,
      readAt: null,
      createdAt: input.createdAt,
    })
    .returning()
    .get();
  return row!;
}

export function listNotifications(db: Db, userId: string, limit = 20): NotificationRow[] {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .all();
}

export function countUnreadNotifications(db: Db, userId: string): number {
  return db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .all().length;
}

export function markNotificationRead(db: Db, id: string, userId: string, now: number): boolean {
  const result = db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)))
    .run();
  return result.changes > 0;
}

export function markAllNotificationsRead(db: Db, userId: string, now: number): number {
  return db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .run().changes;
}
