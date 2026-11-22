import type { OptionFieldSchema, OptionValue } from "@datachat/datasource-sdk";
import { decryptSecret, encryptSecret } from "../agent/datasource/crypto.js";

const SECRET_MARKER_KEY = "__enc";

interface EncryptedEnvelope {
  [SECRET_MARKER_KEY]: string;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[SECRET_MARKER_KEY] === "string"
  );
}

function parseRawStoredOptions(rawJson: string | null | undefined): Record<string, unknown> {
  if (!rawJson) return {};
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed legacy options JSON; treat as empty.
  }
  return {};
}

export class DriverOptionsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverOptionsValidationError";
  }
}

/**
 * Validate incoming driver options against `optionsSchema`, encrypt any `secret: true`
 * fields using AES-GCM, and preserve existing encrypted secret values when left blank
 * on update (matching `password` semantics).
 */
export function serializeDatasourceOptions(
  schema: OptionFieldSchema[],
  incoming: Record<string, OptionValue | null> | undefined,
  existingJson: string | null | undefined,
  key: Buffer,
  isUpdate: boolean,
): string | null {
  if (schema.length === 0) return null;
  const existing = parseRawStoredOptions(existingJson);
  const stored: Record<string, unknown> = {};

  for (const field of schema) {
    const hasIncoming = incoming !== undefined && Object.prototype.hasOwnProperty.call(incoming, field.key);
    const raw = hasIncoming ? incoming[field.key] : undefined;
    const isSecret = field.type !== "select" && field.secret === true;

    if (isSecret) {
      if (raw === undefined || raw === null || raw === "") {
        if (isUpdate && isEncryptedEnvelope(existing[field.key])) {
          stored[field.key] = existing[field.key];
          continue;
        }
        if (field.required) {
          throw new DriverOptionsValidationError(`请填写必填配置「${field.label}」`);
        }
        continue;
      }
      if (typeof raw !== "string") {
        throw new DriverOptionsValidationError(`配置「${field.label}」必须为字符串`);
      }
      stored[field.key] = { [SECRET_MARKER_KEY]: encryptSecret(raw, key) };
      continue;
    }

    let value: OptionValue | undefined;
    if (hasIncoming) {
      if (raw === null || raw === "") {
        value = undefined;
      } else {
        value = raw;
      }
    } else if (isUpdate && existing[field.key] !== undefined && !isEncryptedEnvelope(existing[field.key])) {
      value = existing[field.key] as OptionValue;
    } else if (field.defaultValue !== undefined) {
      value = field.defaultValue;
    }

    if (value === undefined) {
      if (field.required) {
        throw new DriverOptionsValidationError(`请填写必填配置「${field.label}」`);
      }
      continue;
    }

    if (field.type === "number") {
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed)) {
        throw new DriverOptionsValidationError(`配置「${field.label}」必须为有效数字`);
      }
      stored[field.key] = parsed;
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new DriverOptionsValidationError(`配置「${field.label}」必须为布尔值`);
      }
      stored[field.key] = value;
    } else if (field.type === "select") {
      const str = String(value);
      if (!field.options.some((opt) => opt.value === str)) {
        throw new DriverOptionsValidationError(`配置「${field.label}」取值不合法`);
      }
      stored[field.key] = str;
    } else {
      stored[field.key] = String(value);
    }
  }

  return Object.keys(stored).length > 0 ? JSON.stringify(stored) : null;
}

/**
 * Decrypt stored options for runtime connection creation. Returns both the plain
 * option map and the list of decrypted secret strings for error scrubbing.
 */
export function resolveDatasourceOptions(
  schema: OptionFieldSchema[],
  storedJson: string | null | undefined,
  key: Buffer,
): { options: Record<string, OptionValue | undefined>; secrets: string[] } {
  const raw = parseRawStoredOptions(storedJson);
  const options: Record<string, OptionValue | undefined> = {};
  const secrets: string[] = [];

  for (const field of schema) {
    const entry = raw[field.key];
    const isSecret = field.type !== "select" && field.secret === true;
    if (isSecret) {
      if (isEncryptedEnvelope(entry)) {
        const plain = decryptSecret(entry[SECRET_MARKER_KEY], key);
        options[field.key] = plain;
        if (plain) secrets.push(plain);
      } else {
        options[field.key] = undefined;
      }
      continue;
    }
    if (entry !== undefined && !isEncryptedEnvelope(entry)) {
      options[field.key] = entry as OptionValue;
    } else if (field.defaultValue !== undefined) {
      options[field.key] = field.defaultValue;
    }
  }

  return { options, secrets };
}

/**
 * Produce a safe public projection of stored options for Admin UI responses:
 * non-secret values are returned, while `secret: true` fields are never leaked
 * (only their presence is signaled in `secretOptionKeys`).
 */
export function publicDatasourceOptions(
  schema: OptionFieldSchema[],
  storedJson: string | null | undefined,
): { options: Record<string, OptionValue>; secretOptionKeys: string[] } {
  const raw = parseRawStoredOptions(storedJson);
  const options: Record<string, OptionValue> = {};
  const secretOptionKeys: string[] = [];

  for (const field of schema) {
    const entry = raw[field.key];
    const isSecret = field.type !== "select" && field.secret === true;
    if (isSecret) {
      if (isEncryptedEnvelope(entry)) {
        secretOptionKeys.push(field.key);
      }
      continue;
    }
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      options[field.key] = entry;
    }
  }
  return { options, secretOptionKeys };
}
