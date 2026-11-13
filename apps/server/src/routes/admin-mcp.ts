import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import { datasources, mcpServers } from "../db/schema.js";
import { buildMcpServerConfig } from "../agent/mcp.js";
import { deriveSecretKey } from "../agent/datasource/crypto.js";
import { safeRecordAuditEvent, type AuditStatus } from "../services/audit.js";
import {
  DEFAULT_MCP_TEST_TIMEOUT_MS,
  encryptSecretMap,
  mergeSecretPatch,
  readSecretMap,
  testMcpConnection,
  toMcpServerView,
} from "../services/mcp-admin.js";

export interface AdminMcpRouteOptions {
  db: Db;
  config: AppConfig;
  /** Tool discovery budget for the connection test; tests shorten it. */
  mcpTestTimeoutMs?: number;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SECRET_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_ARGS = 20;
const MAX_SECRET_ENTRIES = 30;
const MAX_SECRET_VALUE_LENGTH = 2000;
const MAX_COMMAND_LENGTH = 500;
const MAX_URL_LENGTH = 2000;

const idParamsSchema = z.object({ id: z.string().min(1) });

const nameSchema = z
  .string()
  .trim()
  .regex(NAME_PATTERN, "名称需为 2-64 位小写字母、数字、下划线或短横线，且以字母或数字开头");
const commandSchema = z
  .string()
  .trim()
  .max(MAX_COMMAND_LENGTH, `command 最多 ${MAX_COMMAND_LENGTH} 个字符`)
  .nullable()
  .optional();
const urlSchema = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH, `url 最多 ${MAX_URL_LENGTH} 个字符`)
  .nullable()
  .optional();
const argsSchema = z
  .array(z.string().max(MAX_SECRET_VALUE_LENGTH, `参数最多 ${MAX_SECRET_VALUE_LENGTH} 个字符`))
  .max(MAX_ARGS, `参数最多 ${MAX_ARGS} 个`)
  .optional();
const secretKeySchema = z
  .string()
  .regex(SECRET_KEY_PATTERN, "键只能包含字母、数字、下划线、点或短横线（1-128 位）");
const secretValueSchema = z
  .string()
  .max(MAX_SECRET_VALUE_LENGTH, `值最多 ${MAX_SECRET_VALUE_LENGTH} 个字符`);

function secretMapSchema<T extends z.ZodTypeAny>(value: T) {
  return z
    .record(secretKeySchema, value)
    .refine(
      (map) => Object.keys(map).length <= MAX_SECRET_ENTRIES,
      `最多 ${MAX_SECRET_ENTRIES} 项`,
    );
}

const createMcpServerSchema = z.object({
  name: nameSchema,
  transport: z.enum(["stdio", "http"]),
  command: commandSchema,
  args: argsSchema,
  url: urlSchema,
  env: secretMapSchema(secretValueSchema).optional(),
  headers: secretMapSchema(secretValueSchema).optional(),
  datasourceId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});

const updateMcpServerSchema = z.object({
  name: nameSchema.optional(),
  transport: z.enum(["stdio", "http"]).optional(),
  command: commandSchema,
  args: argsSchema,
  url: urlSchema,
  // Top-level `null` clears the map to `{}`; `null` on a value means "keep the stored
  // value" so the masked edit form can resubmit; a missing key removes the entry.
  env: z.union([secretMapSchema(secretValueSchema.nullable()), z.null()]).optional(),
  headers: z.union([secretMapSchema(secretValueSchema.nullable()), z.null()]).optional(),
  // Required to overwrite env/headers whose stored ciphertext cannot be decrypted.
  replaceSecrets: z.boolean().optional(),
  datasourceId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});

type McpServerInput = z.infer<typeof createMcpServerSchema>;
type McpServerUpdate = z.infer<typeof updateMcpServerSchema>;
type FieldErrors = Record<string, string[]>;

function validationError(details: unknown): { error: { code: string; message: string; details: unknown } } {
  return { error: { code: "VALIDATION", message: "参数不合法", details } };
}

function fieldValidationError(fieldErrors: FieldErrors): {
  error: { code: string; message: string; details: unknown };
} {
  return validationError({ fieldErrors, formErrors: [] });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/** Loopback, link-local, RFC1918 and IPv6 unique-local addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return false;
  const host = address.toLowerCase().split("%")[0]!;
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  return mapped ? isPrivateIpv4(mapped[1]!) : false;
}

/**
 * True when an http(s) MCP endpoint resolves to a loopback/link-local/private/metadata
 * address. Literal IPs are checked directly; hostnames go through `dns.lookup({all:true})`
 * so multi-record names cannot hide a private address behind a public one.
 */
export async function isBlockedMcpUrl(rawUrl: string): Promise<boolean> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "metadata.google.internal" || hostname === "fd00:ec2::254") return true;
  if (isIP(hostname)) return isPrivateAddress(hostname);
  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address));
  } catch {
    // Unresolvable: let the connection attempt report the DNS failure itself.
    return false;
  }
}

const HOST_NOT_ALLOWED = {
  error: { code: "HOST_NOT_ALLOWED", message: "不允许连接回环、内网或元数据地址" },
};

function datasourceExists(db: Db, id: string): boolean {
  return db.select({ id: datasources.id }).from(datasources).where(eq(datasources.id, id)).get() !== undefined;
}

function findByName(db: Db, name: string): { id: string } | undefined {
  return db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, name)).get();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export async function adminMcpRoutes(
  app: FastifyInstance,
  opts: AdminMcpRouteOptions,
): Promise<void> {
  const { db, config } = opts;
  const testTimeoutMs = opts.mcpTestTimeoutMs ?? DEFAULT_MCP_TEST_TIMEOUT_MS;
  const key = deriveSecretKey(config.appSecret);

  const audit = (
    request: FastifyRequest,
    detail: Record<string, unknown>,
    status: AuditStatus = "ok",
  ) => {
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser?.id ?? request.user?.sub ?? null,
      action: "mcp_change",
      status,
      ip: request.ip,
      detail,
    });
  };

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "MCP 服务器不存在" } });

  app.get("/api/admin/mcp-servers", { preHandler: app.requirePermission("admin.mcp") }, async () => {
    const rows = db.select().from(mcpServers).orderBy(asc(mcpServers.name)).all();
    return { servers: rows.map((row) => toMcpServerView(row, key)) };
  });

  app.get("/api/admin/mcp-servers/:id", { preHandler: app.requirePermission("admin.mcp") }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, params.data.id)).get();
    if (!row) return notFound(reply);
    return { server: toMcpServerView(row, key) };
  });

  app.post("/api/admin/mcp-servers", { preHandler: app.requirePermission("admin.mcp") }, async (request, reply) => {
    const parsed = createMcpServerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(parsed.error.flatten()));
    const input: McpServerInput = parsed.data;
    const fieldErrors: FieldErrors = {};

    if (input.transport === "stdio") {
      if (!input.command) fieldErrors.command = ["stdio 传输必须填写 command"];
      if (input.url != null) fieldErrors.url = ["stdio 传输不能填写 url"];
    } else {
      if (input.command != null) fieldErrors.command = ["HTTP 传输不能填写 command"];
      if (!input.url) fieldErrors.url = ["HTTP 传输必须填写 url"];
      else if (!isHttpUrl(input.url)) fieldErrors.url = ["url 需以 http:// 或 https:// 开头"];
    }
    const datasourceId = input.datasourceId ?? null;
    if (datasourceId && !datasourceExists(db, datasourceId)) {
      fieldErrors.datasourceId = ["数据源不存在"];
    }
    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send(fieldValidationError(fieldErrors));
    }
    if (findByName(db, input.name)) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: "MCP 服务器名称已存在" } });
    }
    if (
      input.transport === "http" &&
      input.url &&
      !config.mcpAllowPrivateHosts &&
      (await isBlockedMcpUrl(input.url))
    ) {
      return reply.code(400).send(HOST_NOT_ALLOWED);
    }

    const stdio = input.transport === "stdio";
    const row = {
      id: randomUUID(),
      name: input.name,
      transport: input.transport,
      command: stdio ? (input.command ?? null) : null,
      argsJson: stdio && input.args && input.args.length > 0 ? JSON.stringify(input.args) : null,
      envCipher: stdio ? encryptSecretMap(input.env ?? {}, key) : null,
      url: stdio ? null : (input.url ?? null),
      headersCipher: stdio ? null : encryptSecretMap(input.headers ?? {}, key),
      datasourceId,
      enabled: input.enabled === false ? 0 : 1,
      createdBy: request.user!.sub,
      createdAt: Date.now(),
    };
    try {
      db.insert(mcpServers).values(row).run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "MCP 服务器名称已存在" } });
      }
      throw error;
    }
    audit(request, { name: row.name, transport: row.transport, enabled: row.enabled === 1 });
    return reply.code(201).send({ server: toMcpServerView(row, key) });
  });

  app.patch("/api/admin/mcp-servers/:id", { preHandler: app.requirePermission("admin.mcp") }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const existing = db.select().from(mcpServers).where(eq(mcpServers.id, params.data.id)).get();
    if (!existing) return notFound(reply);
    const parsed = updateMcpServerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(parsed.error.flatten()));
    const input: McpServerUpdate = parsed.data;

    const nextName = input.name ?? existing.name;
    const nextTransport = input.transport ?? existing.transport;
    const nextEnabled = input.enabled ?? existing.enabled === 1;
    const nextDatasourceId =
      input.datasourceId !== undefined ? input.datasourceId : existing.datasourceId;
    const nextCommand =
      nextTransport === "stdio"
        ? input.command !== undefined
          ? input.command
          : existing.command
        : null;
    const nextUrl =
      nextTransport === "http" ? (input.url !== undefined ? input.url : existing.url) : null;

    const fieldErrors: FieldErrors = {};
    if (nextTransport === "stdio") {
      if (!nextCommand) fieldErrors.command = ["stdio 传输必须填写 command"];
      if (input.url != null) fieldErrors.url = ["stdio 传输不能填写 url"];
    } else {
      if (input.command != null) fieldErrors.command = ["HTTP 传输不能填写 command"];
      if (!nextUrl) fieldErrors.url = ["HTTP 传输必须填写 url"];
      else if (!isHttpUrl(nextUrl)) fieldErrors.url = ["url 需以 http:// 或 https:// 开头"];
    }
    if (nextDatasourceId && !datasourceExists(db, nextDatasourceId)) {
      fieldErrors.datasourceId = ["数据源不存在"];
    }
    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send(fieldValidationError(fieldErrors));
    }
    if (input.name && input.name !== existing.name) {
      const duplicate = findByName(db, input.name);
      if (duplicate && duplicate.id !== existing.id) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "MCP 服务器名称已存在" } });
      }
    }
    if (
      nextTransport === "http" &&
      nextUrl &&
      !config.mcpAllowPrivateHosts &&
      (await isBlockedMcpUrl(nextUrl))
    ) {
      return reply.code(400).send(HOST_NOT_ALLOWED);
    }

    let envCipher: string | null;
    if (nextTransport !== "stdio") {
      envCipher = null;
    } else if (input.env === undefined) {
      envCipher = existing.transport === "stdio" ? existing.envCipher : null;
    } else {
      const stored = existing.transport === "stdio" ? existing.envCipher : null;
      const current = readSecretMap(stored, key);
      if (!current.ok && !input.replaceSecrets) {
        return reply.code(409).send({
          error: {
            code: "SECRETS_UNREADABLE",
            message: "已保存的 env 无法解密，请确认替换密钥后重试",
          },
        });
      }
      envCipher = encryptSecretMap(mergeSecretPatch(input.env ?? {}, current.map), key);
    }

    let headersCipher: string | null;
    if (nextTransport !== "http") {
      headersCipher = null;
    } else if (input.headers === undefined) {
      headersCipher = existing.transport === "http" ? existing.headersCipher : null;
    } else {
      const stored = existing.transport === "http" ? existing.headersCipher : null;
      const current = readSecretMap(stored, key);
      if (!current.ok && !input.replaceSecrets) {
        return reply.code(409).send({
          error: {
            code: "SECRETS_UNREADABLE",
            message: "已保存的 headers 无法解密，请确认替换密钥后重试",
          },
        });
      }
      headersCipher = encryptSecretMap(
        mergeSecretPatch(input.headers ?? {}, current.map),
        key,
      );
    }

    let argsJson: string | null;
    if (nextTransport !== "stdio") {
      argsJson = null;
    } else if (input.args === undefined) {
      argsJson = existing.transport === "stdio" ? existing.argsJson : null;
    } else {
      argsJson = input.args.length > 0 ? JSON.stringify(input.args) : null;
    }

    try {
      db.update(mcpServers)
        .set({
          name: nextName,
          transport: nextTransport,
          command: nextTransport === "stdio" ? (nextCommand ?? null) : null,
          argsJson,
          envCipher,
          url: nextTransport === "http" ? (nextUrl ?? null) : null,
          headersCipher,
          datasourceId: nextDatasourceId,
          enabled: nextEnabled ? 1 : 0,
        })
        .where(eq(mcpServers.id, existing.id))
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: { code: "CONFLICT", message: "MCP 服务器名称已存在" } });
      }
      throw error;
    }

    const updated = db.select().from(mcpServers).where(eq(mcpServers.id, existing.id)).get()!;
    audit(request, {
      name: updated.name,
      transport: updated.transport,
      enabled: updated.enabled === 1,
    });
    return { server: toMcpServerView(updated, key) };
  });

  app.delete("/api/admin/mcp-servers/:id", { preHandler: app.requirePermission("admin.mcp") }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, params.data.id)).get();
    if (!row) return notFound(reply);
    db.delete(mcpServers).where(eq(mcpServers.id, row.id)).run();
    audit(request, { name: row.name, transport: row.transport, enabled: row.enabled === 1 });
    return { ok: true };
  });

  app.post("/api/admin/mcp-servers/:id/test", { preHandler: app.requirePermission("admin.mcp") }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, params.data.id)).get();
    if (!row) return notFound(reply);
    if (
      row.transport === "http" &&
      row.url &&
      !config.mcpAllowPrivateHosts &&
      (await isBlockedMcpUrl(row.url))
    ) {
      audit(
        request,
        { name: row.name, transport: row.transport, enabled: row.enabled === 1 },
        "error",
      );
      return reply.code(400).send(HOST_NOT_ALLOWED);
    }

    let result;
    try {
      result = await testMcpConnection(buildMcpServerConfig(row, key), testTimeoutMs);
    } catch (error) {
      // buildMcpServerConfig only reports structural/decryption problems, never secrets.
      result = {
        ok: false as const,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    audit(
      request,
      { name: row.name, transport: row.transport, enabled: row.enabled === 1 },
      result.ok ? "ok" : "error",
    );
    return result;
  });
}
