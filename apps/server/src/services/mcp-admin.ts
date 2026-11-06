import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { decryptSecret, encryptSecret } from "../agent/datasource/crypto.js";
import type { McpServerRow } from "../agent/mcp.js";

/** Default tool discovery budget for `POST /api/admin/mcp-servers/:id/test`. */
export const DEFAULT_MCP_TEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_LENGTH = 500;
const MAX_TOOL_DESCRIPTION_LENGTH = 300;
const MAX_TOOL_NAME_LENGTH = 200;

/** One configured env var / header without its value. */
export interface MaskedSecretEntry {
  key: string;
  hasValue: boolean;
}

export interface McpServerView {
  id: string;
  name: string;
  transport: "stdio" | "http";
  scope: "global" | "datasource";
  datasourceId: string | null;
  command: string | null;
  /** Redacted: sensitive flags keep their name but never their value. */
  args: string[];
  /** Redacted: userinfo and query values are replaced, scheme/host/path kept. */
  url: string | null;
  /** Values are never returned; only the configured key names. */
  env: MaskedSecretEntry[];
  /** Values are never returned; only the configured key names. */
  headers: MaskedSecretEntry[];
  /** True when the stored env/headers ciphertext cannot be decrypted or parsed. */
  secretsUnreadable: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface McpTestTool {
  name: string;
  description: string;
}

export interface McpTestResult {
  ok: boolean;
  tools: McpTestTool[];
  serverInfo?: { name: string; version: string };
  error?: string;
}

/** Copy of a decrypted secret map with masked values, for admin responses. */
export function maskSecretEntries(
  ciphertext: string | null,
  key: Buffer,
): MaskedSecretEntry[] {
  const result = readSecretMap(ciphertext, key);
  return Object.entries(result.map).map(([name, value]) => ({
    key: name,
    hasValue: value.length > 0,
  }));
}

export type ReadSecretMapResult =
  | { ok: true; map: Record<string, string> }
  | { ok: false; map: Record<string, string> };

/**
 * Decrypt a stored env/header blob. A broken ciphertext or malformed payload returns
 * `{ok:false}` with an empty map so callers can distinguish "no secrets configured" from
 * "secrets exist but are unreadable" (and never silently overwrite the latter).
 */
export function readSecretMap(
  ciphertext: string | null,
  key: Buffer,
): ReadSecretMapResult {
  if (!ciphertext) return { ok: true, map: {} };
  try {
    const parsed: unknown = JSON.parse(decryptSecret(ciphertext, key));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, map: {} };
    }
    const map: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") map[name] = value;
    }
    return { ok: true, map };
  } catch {
    return { ok: false, map: {} };
  }
}

/** Encrypt a full env/header map; an empty map is stored as NULL. */
export function encryptSecretMap(
  map: Record<string, string>,
  key: Buffer,
): string | null {
  const entries = Object.entries(map).filter(([name]) => name.length > 0);
  if (entries.length === 0) return null;
  return encryptSecret(JSON.stringify(Object.fromEntries(entries)), key);
}

/**
 * Apply a PATCH map to the stored map. A `null` value means "keep the current value" so the
 * admin form can resubmit masked entries; a missing key means "delete this entry".
 */
export function mergeSecretPatch(
  patch: Record<string, string | null>,
  current: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) {
      const existing = current[name];
      if (existing !== undefined) next[name] = existing;
      continue;
    }
    next[name] = value;
  }
  return next;
}

export function parseArgsJson(argsJson: string | null): string[] {
  if (!argsJson) return [];
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((arg): arg is string => typeof arg === "string");
  } catch {
    return [];
  }
}

export function toMcpServerView(row: McpServerRow, key: Buffer): McpServerView {
  const stdio = row.transport === "stdio";
  const secrets = readSecretMap(stdio ? row.envCipher : row.headersCipher, key);
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    scope: row.datasourceId ? "datasource" : "global",
    datasourceId: row.datasourceId,
    command: stdio ? row.command : null,
    args: stdio ? redactMcpArgs(parseArgsJson(row.argsJson)) : [],
    url: stdio ? null : redactMcpUrl(row.url),
    env: stdio ? maskSecretEntries(row.envCipher, key) : [],
    headers: stdio ? [] : maskSecretEntries(row.headersCipher, key),
    secretsUnreadable: !secrets.ok,
    enabled: row.enabled === 1,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/**
 * Display-safe URL: credentials and query values are replaced with `***` while the
 * scheme, host and path stay readable (an admin still recognises the endpoint).
 */
export function redactMcpUrl(raw: string | null): string | null {
  if (raw === null || raw === "") return raw;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, "***");
    url.hash = "";
    return url.toString();
  } catch {
    // Not a parseable URL: mask anything that looks like a query value.
    return raw.replace(/([?&][^=&#\s]+=)[^&#\s]*/g, "$1***");
  }
}

const SENSITIVE_ARG = /(?:^|[^a-z0-9])(?:token|secret|password|key)(?:[^a-z0-9]|$)/i;

/**
 * Mask command arguments that carry credentials. `--token=abc` keeps the flag name,
 * a bare `--token abc` masks the following argument, and a standalone sensitive value is
 * replaced entirely.
 */
export function redactMcpArgs(args: readonly string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!SENSITIVE_ARG.test(arg)) {
      redacted.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals >= 0) {
      redacted.push(`${arg.slice(0, equals + 1)}***`);
      continue;
    }
    redacted.push(arg);
    if (index + 1 < args.length) {
      redacted.push("***");
      index += 1;
    }
  }
  return redacted;
}

function createTransport(config: McpServerConfig): Transport {
  // `type` is optional in pi's config union, so discriminate on the presence of `command`.
  if ("command" in config) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      // Never echo server stderr into the API process logs.
      stderr: "ignore",
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
}

function secretValues(config: McpServerConfig): string[] {
  const map = "command" in config ? config.env : config.headers;
  const values = map
    ? Object.values(map).filter((value): value is string => typeof value === "string")
    : [];
  // Raw urls/args may be echoed by transport errors; redact those too.
  if ("command" in config) values.push(...(config.args ?? []));
  else values.push(config.url);
  return values;
}

/** Strip configured secret values and any newlines from a transport/library error. */
export function sanitizeMcpError(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  let text = raw;
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join("***");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_ERROR_LENGTH) text = `${text.slice(0, MAX_ERROR_LENGTH)}…`;
  return text || "连接失败";
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs >= 1000) return `${timeoutMs / 1000} 秒`;
  return `${timeoutMs} 毫秒`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Connect to a stored MCP server, run `tools/list` and always close the transport.
 * Errors are sanitized (no env/header values) and returned as `{ok:false,error}`; this
 * function never throws so the route can audit both outcomes uniformly.
 */
export async function testMcpConnection(
  config: McpServerConfig,
  timeoutMs: number = DEFAULT_MCP_TEST_TIMEOUT_MS,
): Promise<McpTestResult> {
  const secrets = secretValues(config);
  let timer: NodeJS.Timeout | undefined;
  const client = new Client(
    { name: "datachat-admin-mcp-test", version: "0.0.0" },
    { capabilities: {} },
  );
  try {
    const transport = createTransport(config);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`连接超时：${formatTimeout(timeoutMs)}内未完成 tools/list`));
      }, timeoutMs);
    });
    const run = (async (): Promise<McpTestResult> => {
      await client.connect(transport);
      const listed = await client.listTools();
      const server = client.getServerVersion();
      const tools = (listed.tools ?? []).map((tool) => ({
        name: truncate(tool.name, MAX_TOOL_NAME_LENGTH),
        description: truncate(tool.description ?? "", MAX_TOOL_DESCRIPTION_LENGTH),
      }));
      return {
        ok: true,
        tools,
        ...(server ? { serverInfo: { name: server.name, version: server.version } } : {}),
      };
    })();
    // Losing the race must not leak an unhandled rejection.
    run.catch(() => undefined);
    return await Promise.race([run, deadline]);
  } catch (error) {
    return { ok: false, tools: [], error: sanitizeMcpError(error, secrets) };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // The connection is already gone; nothing to clean up.
    }
  }
}
