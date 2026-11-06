import { eq, sql } from "drizzle-orm";
import { normalizeUsername, type PublicUser, type UserRole } from "@datachat/shared";
import type { Db } from "../client.js";
import { users } from "../schema.js";

export type UserRow = typeof users.$inferSelect;

/** Thrown by insertUser when the (case-insensitive) username is already taken. */
export class DuplicateUsernameError extends Error {
  readonly code = "DUPLICATE_USERNAME";

  constructor(readonly username: string) {
    super(`Username already exists: ${username}`);
    this.name = "DuplicateUsernameError";
  }
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    candidate.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    (typeof candidate.message === "string" && /UNIQUE constraint failed/i.test(candidate.message))
  );
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
  return db
    .select()
    .from(users)
    .where(eq(users.username, normalizeUsername(username)))
    .get();
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function countUsers(db: Db): number {
  const row = db.select({ count: sql<number>`count(*)` }).from(users).get();
  return Number(row?.count ?? 0);
}

export function countAdmins(db: Db): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.role, "admin"))
    .get();
  return Number(row?.count ?? 0);
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
  const username = normalizeUsername(input.username);
  try {
    return db
      .insert(users)
      .values({
        id: input.id,
        username,
        passwordHash: input.passwordHash,
        displayName: input.displayName ?? null,
        role: input.role,
        status: "active",
        createdAt: input.createdAt,
        lastLoginAt: null,
      })
      .returning()
      .get();
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateUsernameError(username);
    throw error;
  }
}
