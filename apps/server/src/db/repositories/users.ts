import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { users } from "../schema.js";
import type { PublicUser, UserRole } from "@datachat/shared";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string | null;
  role: UserRole;
  status: "active" | "disabled";
  createdAt: number;
  lastLoginAt: number | null;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
  };
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.username, username)).get() as UserRow | undefined;
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get() as UserRow | undefined;
}

export function countUsers(db: Db): number {
  return db.select({ id: users.id }).from(users).all().length;
}

export function insertUser(
  db: Db,
  input: {
    id: string;
    username: string;
    passwordHash: string;
    role: UserRole;
    displayName?: string | null;
    createdAt: number;
  },
): UserRow {
  const row: UserRow = {
    id: input.id,
    username: input.username,
    passwordHash: input.passwordHash,
    displayName: input.displayName ?? null,
    role: input.role,
    status: "active",
    createdAt: input.createdAt,
    lastLoginAt: null,
  };
  db.insert(users).values(row).run();
  return row;
}
