import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { countUsers, findUserByUsername, insertUser } from "../db/repositories/users.js";
import { hashPassword } from "./password.js";

export async function bootstrapAdmin(db: Db, config: AppConfig): Promise<void> {
  if (countUsers(db) > 0) return;
  if (!config.adminPassword) {
    throw new Error("数据库为空且未设置 ADMIN_PASSWORD，无法创建管理员");
  }
  const existing = findUserByUsername(db, config.adminUsername);
  if (existing) return;
  insertUser(db, {
    id: randomUUID(),
    username: config.adminUsername,
    passwordHash: await hashPassword(config.adminPassword),
    role: "admin",
    displayName: "管理员",
    createdAt: Date.now(),
  });
}
