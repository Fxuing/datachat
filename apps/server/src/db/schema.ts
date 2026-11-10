import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    lastLoginAt: integer("last_login_at"),
  },
  (t) => [
    // Case-insensitive uniqueness even for writes that bypass normalizeUsername().
    // Drizzle cannot express `COLLATE NOCASE` in indexes, so migration 0001 spells it out.
    uniqueIndex("users_username_nocase_unique").on(t.username),
    check("users_role_check", sql`${t.role} in ('admin', 'user')`),
  ],
);

export const datasources = sqliteTable("datasources", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type", { enum: ["mysql", "postgres"] }).notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  database: text("database").notNull(),
  username: text("username").notNull(),
  passwordCipher: text("password_cipher").notNull(),
  sslMode: text("ssl_mode", { enum: ["disable", "require", "no-verify"] })
    .notNull()
    .default("disable"),
  /** Connection options (charset, TLS extras) as JSON; spec §6 requires the column. */
  optionsJson: text("options_json"),
  readOnlyVerified: integer("read_only_verified").notNull().default(0),
  /** Admin opted in to a write-capable account; the query guard is unaffected. */
  allowWriteAccount: integer("allow_write_account").notNull().default(0),
  status: text("status").notNull().default("unknown"),
  lastCheckedAt: integer("last_checked_at"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  // The migration spells out `COLLATE NOCASE`; Drizzle only needs the index name.
  uniqueIndex("datasources_name_nocase_unique").on(t.name),
]);

export const datasourceGrants = sqliteTable(
  "datasource_grants",
  {
    id: text("id").primaryKey(),
    datasourceId: text("datasource_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("datasource_grants_datasource_user_unique").on(t.datasourceId, t.userId),
    index("datasource_grants_user_idx").on(t.userId),
  ],
);

export const datasourceSchemaCache = sqliteTable("datasource_schema_cache", {
  datasourceId: text("datasource_id").primaryKey(),
  payloadJson: text("payload_json").notNull(),
  tableCount: integer("table_count").notNull().default(0),
  refreshedAt: integer("refreshed_at").notNull(),
  error: text("error"),
});

export const conversations = sqliteTable(
  "conversations",
  {
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
  },
  (t) => [index("conversations_user_last_message_idx").on(t.userId, t.lastMessageAt)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    userId: text("user_id").notNull(),
    status: text("status").notNull().default("queued"),
    modelId: text("model_id"),
    retryOfRunId: text("retry_of_run_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("runs_conversation_idx").on(t.conversationId),
    index("runs_conversation_created_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("runs_retry_of_unique").on(t.retryOfRunId),
  ],
);

export const runFeedback = sqliteTable(
  "run_feedback",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    /** 1 = helpful, -1 = not helpful. */
    rating: integer("rating").notNull(),
    comment: text("comment"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("run_feedback_run_user_unique").on(t.runId, t.userId),
    index("run_feedback_user_idx").on(t.userId),
    check("run_feedback_rating_check", sql`${t.rating} in (-1, 1)`),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("run_events_run_seq_unique").on(t.runId, t.seq),
    index("run_events_conversation_seq_idx").on(t.conversationId, t.seq),
  ],
);

export const queryAudit = sqliteTable(
  "query_audit",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    conversationId: text("conversation_id"),
    userId: text("user_id"),
    datasourceId: text("datasource_id"),
    action: text("action", {
      enum: [
        "query",
        "explain",
        "export",
        "login",
        "login_failed",
        "user_create",
        "user_update",
        "datasource_create",
        "datasource_update",
        "datasource_delete",
        "grant_update",
        "skill_change",
        "mcp_change",
      ],
    })
      .notNull()
      .default("query"),
    sqlText: text("sql_text").notNull(),
    sqlHash: text("sql_hash").notNull(),
    status: text("status", { enum: ["ok", "rejected", "error", "timeout"] }).notNull(),
    rowCount: integer("row_count"),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
    detailJson: text("detail_json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("query_audit_datasource_created_idx").on(t.datasourceId, t.createdAt),
    index("query_audit_created_idx").on(t.createdAt),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id"),
    userId: text("user_id"),
    runId: text("run_id"),
    kind: text("kind", { enum: ["result", "chart"] }).notNull(),
    storagePath: text("storage_path"),
    columnsJson: text("columns_json"),
    rowCount: integer("row_count").notNull().default(0),
    truncated: integer("truncated").notNull().default(0),
    specJson: text("spec_json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("artifacts_run_idx").on(t.runId),
    index("artifacts_user_idx").on(t.userId),
  ],
);

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

export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    conversationId: text("conversation_id"),
    reportId: text("report_id"),
    createdBy: text("created_by").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // A share points at exactly one target.
    check(
      "shares_target_check",
      sql`(${t.conversationId} is null) + (${t.reportId} is null) = 1`,
    ),
  ],
);

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

export const skills = sqliteTable(
  "skills",
  {
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
  },
  (t) => [
    // Global skills have no datasource; datasource scoped skills always do.
    check(
      "skills_scope_check",
      sql`(${t.scope} = 'global' and ${t.datasourceId} is null) or (${t.scope} = 'datasource' and ${t.datasourceId} is not null)`,
    ),
  ],
);

export const llmProviders = sqliteTable("llm_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  protocol: text("protocol", { enum: ["openai-completions", "anthropic-messages"] }).notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyCipher: text("api_key_cipher").notNull(),
  modelsJson: text("models_json").notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});
