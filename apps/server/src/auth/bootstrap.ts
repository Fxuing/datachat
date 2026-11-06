import { randomUUID } from "node:crypto";
import { normalizeUsername } from "@datachat/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { countActiveAdmins } from "../db/repositories/users.js";
import { users } from "../db/schema.js";
import { hashPassword } from "./password.js";

export interface BootstrapLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

/**
 * Provisions the bootstrap admin when no admin exists yet. The password hash is
 * never overwritten, so re-running with a different ADMIN_PASSWORD is a no-op.
 */
export async function bootstrapAdmin(
  db: Db,
  config: AppConfig,
  logger?: BootstrapLogger,
): Promise<void> {
  if (countActiveAdmins(db) > 0) {
    logger?.info(
      { username: normalizeUsername(config.adminUsername) },
      "bootstrap admin already exists; skipped",
    );
    return;
  }
  if (!config.adminPassword) {
    throw new Error("数据库为空且未设置 ADMIN_PASSWORD，无法创建管理员");
  }

  const username = normalizeUsername(config.adminUsername);
  const passwordHash = await hashPassword(config.adminPassword);

  const inserted = db.transaction((tx) => {
    if (countActiveAdmins(tx) > 0) return false;
    const rows = tx
      .insert(users)
      .values({
        id: randomUUID(),
        username,
        passwordHash,
        role: "admin",
        displayName: "管理员",
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .returning({ id: users.id })
      .all();
    return rows.length > 0;
  });

  if (inserted) {
    logger?.info({ username }, "provisioned bootstrap admin");
  } else {
    logger?.info({ username }, "bootstrap admin already exists; skipped");
  }
}
