import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  lastLoginAt: integer("last_login_at"),
});

export const datasources = sqliteTable("datasources", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type", { enum: ["mysql", "postgres"] }).notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  database: text("database").notNull(),
  username: text("username").notNull(),
  passwordCipher: text("password_cipher").notNull(),
  sslMode: text("ssl_mode", { enum: ["disable", "require"] }).notNull().default("disable"),
  readOnlyVerified: integer("read_only_verified").notNull().default(0),
  status: text("status").notNull().default("unknown"),
  lastCheckedAt: integer("last_checked_at"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const datasourceGrants = sqliteTable("datasource_grants", {
  id: text("id").primaryKey(),
  datasourceId: text("datasource_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const datasourceSchemaCache = sqliteTable("datasource_schema_cache", {
  datasourceId: text("datasource_id").primaryKey(),
  payloadJson: text("payload_json").notNull(),
  tableCount: integer("table_count").notNull().default(0),
  refreshedAt: integer("refreshed_at").notNull(),
  error: text("error"),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  datasourceId: text("datasource_id").notNull(),
  title: text("title"),
  modelId: text("model_id"),
  thinkingLevel: text("thinking_level").notNull().default("off"),
  piSessionFile: text("pi_session_file"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastMessageAt: integer("last_message_at"),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("queued"),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
});

export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const queryAudit = sqliteTable("query_audit", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  conversationId: text("conversation_id"),
  userId: text("user_id").notNull(),
  datasourceId: text("datasource_id").notNull(),
  action: text("action", { enum: ["query", "explain", "export"] }).notNull().default("query"),
  sqlText: text("sql_text").notNull(),
  sqlHash: text("sql_hash").notNull(),
  status: text("status", { enum: ["ok", "rejected", "error", "timeout"] }).notNull(),
  rowCount: integer("row_count"),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  runId: text("run_id"),
  kind: text("kind", { enum: ["result", "chart"] }).notNull(),
  storagePath: text("storage_path"),
  columnsJson: text("columns_json"),
  rowCount: integer("row_count").notNull().default(0),
  truncated: integer("truncated").notNull().default(0),
  specJson: text("spec_json"),
  createdAt: integer("created_at").notNull(),
});

export const reports = sqliteTable("reports", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  markdown: text("markdown").notNull(),
  artifactIdsJson: text("artifact_ids_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  conversationId: text("conversation_id"),
  reportId: text("report_id"),
  createdBy: text("created_by").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
});

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  transport: text("transport", { enum: ["stdio", "http"] }).notNull(),
  command: text("command"),
  argsJson: text("args_json"),
  envCipher: text("env_cipher"),
  url: text("url"),
  headersCipher: text("headers_cipher"),
  datasourceId: text("datasource_id"),
  enabled: integer("enabled").notNull().default(1),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  scope: text("scope", { enum: ["global", "datasource"] }).notNull(),
  datasourceId: text("datasource_id"),
  name: text("name").notNull(),
  description: text("description").notNull(),
  content: text("content").notNull(),
  enabled: integer("enabled").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});
