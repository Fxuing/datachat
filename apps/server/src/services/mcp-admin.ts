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
  args: string[];
  url: string | null;
  /** Values are never returned; only the configured key names. */
  env: MaskedSecretEntry[];
  /** Values are never returned; only the configured key names. */
  headers: MaskedSecretEntry[];
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
  const map = readSecretMap(ciphertext, key);
  return Object.entries(map).map(([name, value]) => ({
    key: name,
    hasValue: value.length > 0,
  }));
}

/**
 * Decrypt a stored env/header blob. Unreadable ciphertext yields an empty map so the admin
 * list never fails because of a single broken row; the edit form simply shows no entries.
 */
export function readSecretMap(
  ciphertext: string | null,
  key: Buffer,
): Record<string, string> {
  if (!ciphertext) return {};
  try {
    const parsed: unknown = JSON.parse(decryptSecret(ciphertext, key));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") result[name] = value;
    }
    return result;
  } catch {
    return {};
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
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    scope: row.datasourceId ? "datasource" : "global",
    datasourceId: row.datasourceId,
    command: stdio ? row.command : null,
    args: stdio ? parseArgsJson(row.argsJson) : [],
    url: stdio ? null : row.url,
    env: stdio ? maskSecretEntries(row.envCipher, key) : [],
    headers: stdio ? [] : maskSecretEntries(row.headersCipher, key),
    enabled: row.enabled === 1,
    createdAt: new Date(row.createdAt).toISOString(),
  };
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
  if (!map) return [];
  return Object.values(map).filter((value) => typeof value === "string");
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
