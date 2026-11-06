import { Algorithm, hash, verify } from "@node-rs/argon2";

const ARGON2_PREFIX = "$argon2";

export function hashPassword(password: string): Promise<string> {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

/** Never throws for malformed/foreign hashes: an unverifiable hash is simply not a match. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (!passwordHash.startsWith(ARGON2_PREFIX)) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
