import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { settings } from "../schema.js";

/** Raw `settings` rows keyed by name; `value_json` stays an unparsed string. */
export function readSettingRows(db: Db): Map<string, string> {
  const rows = db.select().from(settings).all();
  return new Map(rows.map((row) => [row.key, row.valueJson]));
}

export function upsertSetting(db: Db, key: string, valueJson: string): void {
  db.insert(settings)
    .values({ key, valueJson })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson } })
    .run();
}

export function deleteSetting(db: Db, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}
