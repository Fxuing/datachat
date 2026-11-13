import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "../client.js";
import { datasourceGrants } from "../schema.js";

export function listGrantedUserIds(db: Db, datasourceId: string): string[] {
  return db
    .select({ userId: datasourceGrants.userId })
    .from(datasourceGrants)
    .where(eq(datasourceGrants.datasourceId, datasourceId))
    .all()
    .map((row) => row.userId);
}

export function replaceGrants(db: Db, datasourceId: string, userIds: string[]): void {
  db.delete(datasourceGrants).where(eq(datasourceGrants.datasourceId, datasourceId)).run();
  for (const userId of [...new Set(userIds)]) {
    db.insert(datasourceGrants)
      .values({ id: randomUUID(), datasourceId, userId, createdAt: Date.now() })
      .run();
  }
}
