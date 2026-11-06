import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function deriveSecretKey(appSecret: string): Buffer {
  return scryptSync(appSecret, "datachat-db-v1", 32);
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = value.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("unsupported secret format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("invalid secret");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}
