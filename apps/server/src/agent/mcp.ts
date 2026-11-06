import { and, eq, isNull, or } from "drizzle-orm";
import type { LoadedMcpConfig, McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import { mcpServers } from "../db/schema.js";
import { decryptSecret, deriveSecretKey } from "./datasource/crypto.js";

export interface LoadMcpInput {
  db: Db;
  config: AppConfig;
  datasourceId: string;
}

export type McpServerRow = typeof mcpServers.$inferSelect;

function decryptJsonMap(
  ciphertext: string,
  key: Buffer,
  label: string,
): Record<string, string> {
  const parsed: unknown = JSON.parse(decryptSecret(ciphertext, key));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 解密后不是 JSON 对象`);
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

/**
 * Decrypt one `mcp_servers` row into the runtime config. Throws with a human readable
 * message (no secret values) when the row is unreadable, so both the conversation loader
 * and the admin connection test can surface the same diagnostics.
 */
export function buildMcpServerConfig(row: McpServerRow, key: Buffer): McpServerConfig {
  const label = `MCP 服务器 "${row.name}"`;
  if (row.transport === "stdio") {
    if (!row.command) throw new Error("缺少 command");
    const args: unknown = row.argsJson ? JSON.parse(row.argsJson) : [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error("args 必须是字符串数组");
    }
    return {
      type: "stdio",
      command: row.command,
      args,
      ...(row.envCipher
        ? { env: decryptJsonMap(row.envCipher, key, `${label} 的 env`) }
        : {}),
    };
  }
  if (!row.url) throw new Error("缺少 url");
  return {
    type: "http",
    url: row.url,
    ...(row.headersCipher
      ? { headers: decryptJsonMap(row.headersCipher, key, `${label} 的 headers`) }
      : {}),
  };
}

/**
 * Load MCP servers visible to a conversation: enabled global servers plus enabled servers
 * scoped to the current datasource. Broken ciphertext becomes an `errors` entry so one bad
 * row never blocks the conversation.
 */
export function loadMcpFor(input: LoadMcpInput): LoadedMcpConfig {
  const rows = input.db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.enabled, 1),
        or(isNull(mcpServers.datasourceId), eq(mcpServers.datasourceId, input.datasourceId)),
      ),
    )
    .all();

  const result: LoadedMcpConfig = { servers: [], errors: [] };
  if (rows.length === 0) return result;

  const key = deriveSecretKey(input.config.appSecret);
  for (const row of rows) {
    const label = `MCP 服务器 "${row.name}"`;
    try {
      result.servers.push({
        name: row.name,
        config: buildMcpServerConfig(row, key),
        source: row.datasourceId ? "datasource" : "global",
      });
    } catch (error) {
      result.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
