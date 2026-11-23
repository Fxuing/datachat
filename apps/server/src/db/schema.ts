import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  type: text("type").notNull(),
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
  /** Data-scope enforcement state; see docs/subsystems/auth-permissions.md. */
  dataScopeMode: text("data_scope_mode", { enum: ["off", "configuring", "enabled"] })
    .notNull()
    .default("off"),
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

export const departments = sqliteTable(
  "departments",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Stable business code; `app_code` row filtering reads this column directly. */
    code: text("code").notNull(),
    parentId: text("parent_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("departments_code_unique").on(t.code),
    index("departments_parent_idx").on(t.parentId),
    check("departments_status_check", sql`${t.status} in ('active', 'archived')`),
  ],
);

/** Transitive parent/child pairs; depth 0 is the department itself. */
export const departmentClosure = sqliteTable(
  "department_closure",
  {
    ancestorId: text("ancestor_id").notNull(),
    descendantId: text("descendant_id").notNull(),
    depth: integer("depth").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ancestorId, t.descendantId] }),
    index("department_closure_descendant_idx").on(t.descendantId, t.depth),
    check("department_closure_depth_check", sql`${t.depth} >= 0`),
  ],
);

export const userDepartments = sqliteTable(
  "user_departments",
  {
    userId: text("user_id").notNull(),
    departmentId: text("department_id").notNull(),
    /** Primary membership is display-only; every membership grants its subtree. */
    isPrimary: integer("is_primary").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.departmentId] }),
    index("user_departments_department_idx").on(t.departmentId),
    check("user_departments_primary_check", sql`${t.isPrimary} in (0, 1)`),
  ],
);

export const departmentDatasourceGrants = sqliteTable(
  "department_datasource_grants",
  {
    departmentId: text("department_id").notNull(),
    datasourceId: text("datasource_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.departmentId, t.datasourceId] }),
    index("department_datasource_grants_datasource_idx").on(t.datasourceId),
  ],
);

export const departmentOrgMap = sqliteTable(
  "department_org_map",
  {
    id: text("id").primaryKey(),
    datasourceId: text("datasource_id").notNull(),
    departmentId: text("department_id").notNull(),
    externalId: text("external_id"),
    externalCode: text("external_code"),
    externalOrgCode: text("external_org_code"),
    source: text("source", { enum: ["manual", "import"] }).notNull().default("manual"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("department_org_map_datasource_department_unique").on(
      t.datasourceId,
      t.departmentId,
    ),
    index("department_org_map_datasource_idx").on(t.datasourceId),
    check("department_org_map_source_check", sql`${t.source} in ('manual', 'import')`),
    check(
      "department_org_map_external_check",
      sql`(coalesce(${t.externalId}, '') <> '') or (coalesce(${t.externalCode}, '') <> '') or (coalesce(${t.externalOrgCode}, '') <> '')`,
    ),
  ],
);

export const dataScopePolicies = sqliteTable(
  "data_scope_policies",
  {
    id: text("id").primaryKey(),
    datasourceId: text("datasource_id").notNull(),
    tableName: text("table_name").notNull(),
    mode: text("mode", { enum: ["scoped", "public", "denied"] }).notNull(),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("data_scope_policies_table_unique").on(t.datasourceId, t.tableName),
    index("data_scope_policies_datasource_idx").on(t.datasourceId),
    check("data_scope_policies_mode_check", sql`${t.mode} in ('scoped', 'public', 'denied')`),
    check("data_scope_policies_enabled_check", sql`${t.enabled} in (0, 1)`),
  ],
);

/**
 * Conditions for a scoped table. All rules of one policy are ANDed. Literal
 * rules apply to every user (including admins); identity rules are skipped for
 * admins, who already have unrestricted access.
 */
export const dataScopeRules = sqliteTable(
  "data_scope_rules",
  {
    id: text("id").primaryKey(),
    policyId: text("policy_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    columnName: text("column_name").notNull(),
    operator: text("operator", {
      enum: ["eq", "in", "not_in", "gt", "gte", "lt", "lte"],
    }).notNull(),
    valueMode: text("value_mode", {
      enum: [
        "literal",
        "department_id",
        "department_code",
        "external_id",
        "external_code",
        "external_org_code",
        "user_id",
        "username",
        "role",
      ],
    }).notNull(),
    /** JSON string array; only used when valueMode is literal. */
    literalValuesJson: text("literal_values_json"),
    /** NULL rows stay visible (unassigned records) unless disabled. */
    nullVisible: integer("null_visible").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("data_scope_rules_policy_idx").on(t.policyId, t.sortOrder),
    check(
      "data_scope_rules_operator_check",
      sql`${t.operator} in ('eq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte')`,
    ),
    check(
      "data_scope_rules_value_mode_check",
      sql`${t.valueMode} in ('literal', 'department_id', 'department_code', 'external_id', 'external_code', 'external_org_code', 'user_id', 'username', 'role')`,
    ),
    check("data_scope_rules_null_visible_check", sql`${t.nullVisible} in (0, 1)`),
  ],
);

export const semanticMetrics = sqliteTable(
  "semantic_metrics",
  {
    id: text("id").primaryKey(),
    datasourceId: text("datasource_id")
      .notNull()
      .references(() => datasources.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    synonymsJson: text("synonyms_json").notNull().default("[]"),
    description: text("description"),
    sqlExpression: text("sql_expression").notNull(),
    tableName: text("table_name"),
    defaultFiltersJson: text("default_filters_json").notNull().default("[]"),
    timeColumn: text("time_column"),
    unit: text("unit"),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("semantic_metrics_ds_name_unique").on(t.datasourceId, t.name),
    index("semantic_metrics_ds_enabled_idx").on(t.datasourceId, t.enabled),
    check("semantic_metrics_enabled_check", sql`${t.enabled} in (0, 1)`),
  ],
);

export const semanticRelations = sqliteTable(
  "semantic_relations",
  {
    id: text("id").primaryKey(),
    datasourceId: text("datasource_id")
      .notNull()
      .references(() => datasources.id, { onDelete: "cascade" }),
    leftTable: text("left_table").notNull(),
    leftColumn: text("left_column").notNull(),
    rightTable: text("right_table").notNull(),
    rightColumn: text("right_column").notNull(),
    joinType: text("join_type", { enum: ["inner", "left", "right"] }).notNull().default("left"),
    description: text("description"),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("semantic_relations_ds_edge_unique").on(
      t.datasourceId,
      t.leftTable,
      t.leftColumn,
      t.rightTable,
      t.rightColumn,
    ),
    index("semantic_relations_ds_enabled_idx").on(t.datasourceId, t.enabled),
    check("semantic_relations_join_type_check", sql`${t.joinType} in ('inner', 'left', 'right')`),
    check("semantic_relations_enabled_check", sql`${t.enabled} in (0, 1)`),
  ],
);

export const dashboards = sqliteTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Optional 5-field cron expression for scheduled auto-refresh; null = disabled. */
    refreshCron: text("refresh_cron"),
    refreshTimezone: text("refresh_timezone").notNull().default("Asia/Shanghai"),
    nextRefreshAt: integer("next_refresh_at"),
    lastAutoRefreshedAt: integer("last_auto_refreshed_at"),
    lastAutoRefreshError: text("last_auto_refresh_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("dashboards_user_updated_idx").on(t.userId, t.updatedAt),
    index("dashboards_next_refresh_idx").on(t.nextRefreshAt),
  ],
);

export const dashboardCards = sqliteTable(
  "dashboard_cards",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    sourceConversationId: text("source_conversation_id"),
    sourceArtifactId: text("source_artifact_id"),
    datasourceId: text("datasource_id"),
    sqlText: text("sql_text"),
    chartConfigJson: text("chart_config_json"),
    specJson: text("spec_json").notNull(),
    points: integer("points").notNull().default(0),
    width: integer("width").notNull().default(1),
    position: integer("position").notNull().default(0),
    lastRefreshedAt: integer("last_refreshed_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("dashboard_cards_dashboard_pos_idx").on(t.dashboardId, t.position, t.createdAt),
    check("dashboard_cards_width_check", sql`${t.width} in (1, 2)`),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    sourceKind: text("source_kind", { enum: ["datasource", "file"] }).notNull().default("datasource"),
    datasourceId: text("datasource_id"),
    title: text("title"),
    modelId: text("model_id"),
    thinkingLevel: text("thinking_level").notNull().default("off"),
    kind: text("kind", { enum: ["chat", "scheduled"] }).notNull().default("chat"),
    piSessionFile: text("pi_session_file"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastMessageAt: integer("last_message_at"),
  },
  (t) => [
    index("conversations_user_last_message_idx").on(t.userId, t.lastMessageAt),
    check("conversations_kind_check", sql`${t.kind} in ('chat', 'scheduled')`),
    check(
      "conversations_source_check",
      sql`(${t.sourceKind} = 'datasource' and ${t.datasourceId} is not null) or (${t.sourceKind} = 'file' and ${t.datasourceId} is null)`,
    ),
  ],
);

export const conversationFiles = sqliteTable(
  "conversation_files",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    userId: text("user_id").notNull(),
    fileName: text("file_name").notNull(),
    fileType: text("file_type", { enum: ["xlsx", "csv"] }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    headerRow: integer("header_row").notNull().default(1),
    tableCount: integer("table_count").notNull().default(0),
    rowCount: integer("row_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("conversation_files_conversation_idx").on(t.conversationId, t.createdAt),
    index("conversation_files_user_idx").on(t.userId),
    check("conversation_files_type_check", sql`${t.fileType} in ('xlsx', 'csv')`),
    check("conversation_files_header_row_check", sql`${t.headerRow} >= 1`),
  ],
);

export const conversationFileTables = sqliteTable(
  "conversation_file_tables",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    fileId: text("file_id").notNull(),
    tableName: text("table_name").notNull(),
    displayName: text("display_name").notNull(),
    sheetName: text("sheet_name"),
    rowCount: integer("row_count").notNull().default(0),
    columnsJson: text("columns_json").notNull(),
    sampleRowsJson: text("sample_rows_json").notNull(),
    warningsJson: text("warnings_json").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("conversation_file_tables_conv_name_unique").on(t.conversationId, t.tableName),
    index("conversation_file_tables_conversation_idx").on(t.conversationId, t.createdAt),
    index("conversation_file_tables_file_idx").on(t.fileId),
  ],
);

export const fileDatasets = sqliteTable(
  "file_datasets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    fileType: text("file_type", { enum: ["xlsx", "csv"] }).notNull().default("xlsx"),
    fileCount: integer("file_count").notNull().default(1),
    tableCount: integer("table_count").notNull().default(0),
    rowCount: integer("row_count").notNull().default(0),
    sizeBytes: integer("size_bytes").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("file_datasets_user_updated_idx").on(t.userId, t.updatedAt),
    check("file_datasets_type_check", sql`${t.fileType} in ('xlsx', 'csv')`),
  ],
);

export const fileDatasetTables = sqliteTable(
  "file_dataset_tables",
  {
    id: text("id").primaryKey(),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => fileDatasets.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
    displayName: text("display_name").notNull(),
    sheetName: text("sheet_name"),
    rowCount: integer("row_count").notNull().default(0),
    columnsJson: text("columns_json").notNull(),
    sampleRowsJson: text("sample_rows_json").notNull(),
    warningsJson: text("warnings_json").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("file_dataset_tables_dataset_name_unique").on(t.datasetId, t.tableName),
    index("file_dataset_tables_dataset_idx").on(t.datasetId, t.createdAt),
  ],
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
    memoryExtractedAt: integer("memory_extracted_at"),
    /** Frozen data scope at run start; legacy runs have no snapshot. */
    scopeSnapshot: text("scope_snapshot"),
    /** Cached follow-up question suggestions JSON (`string[]`); null = not generated yet. */
    suggestionsJson: text("suggestions_json"),
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
    /** Admin triage state for promoting feedback into verified SQL examples. */
    reviewStatus: text("review_status", { enum: ["pending", "promoted", "dismissed"] })
      .notNull()
      .default("pending"),
    reviewedAt: integer("reviewed_at"),
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
        "department_change",
        "data_scope_change",
        "data_scope_enable",
        "skill_change",
        "mcp_change",
        "role_change",
        "ops",
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
    /** Why a query was rejected or narrowed by data scope. */
    scopeReason: text("scope_reason"),
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
    dashboardId: text("dashboard_id"),
    createdBy: text("created_by").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // A share points at exactly one target (conversation, report, or dashboard).
    check(
      "shares_target_check",
      sql`(${t.conversationId} is null) + (${t.reportId} is null) + (${t.dashboardId} is null) = 2`,
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

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    builtin: integer("builtin").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("roles_name_unique").on(t.name)],
);

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    roleId: text("role_id").notNull(),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id").notNull(),
    roleId: text("role_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index("user_roles_role_idx").on(t.roleId),
  ],
);

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    datasourceId: text("datasource_id").notNull(),
    modelId: text("model_id"),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").notNull(),
    enabled: integer("enabled").notNull().default(1),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunAt: integer("last_run_at"),
    lastStatus: text("last_status", { enum: ["success", "failed", "skipped"] }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("scheduled_tasks_due_idx").on(t.enabled, t.nextRunAt),
    index("scheduled_tasks_user_idx").on(t.userId),
  ],
);

export const scheduledTaskRuns = sqliteTable(
  "scheduled_task_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    trigger: text("trigger", { enum: ["schedule", "manual"] }).notNull(),
    status: text("status", {
      enum: ["running", "success", "failed", "skipped"],
    }).notNull(),
    error: text("error"),
    conversationId: text("conversation_id"),
    reportId: text("report_id"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("scheduled_task_runs_task_idx").on(t.taskId),
    index("scheduled_task_runs_created_idx").on(t.createdAt),
  ],
);

export const userMemories = sqliteTable(
  "user_memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    datasourceId: text("datasource_id"),
    kind: text("kind", {
      enum: ["profile", "instruction", "preference", "fact"],
    }).notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    core: integer("core").notNull().default(0),
    enabled: integer("enabled").notNull().default(1),
    confidence: integer("confidence").notNull().default(60),
    dedupeKey: text("dedupe_key").notNull(),
    sourceConversationId: text("source_conversation_id"),
    sourceRunId: text("source_run_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("user_memories_dedupe_unique").on(t.userId, t.dedupeKey),
    index("user_memories_user_idx").on(t.userId, t.enabled, t.datasourceId),
    index("user_memories_updated_idx").on(t.userId, t.updatedAt),
  ],
);

export const userMemorySettings = sqliteTable("user_memory_settings", {
  userId: text("user_id").primaryKey(),
  enabled: integer("enabled").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type", {
      enum: ["task_success", "task_failed", "task_disabled"],
    }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    readAt: integer("read_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_unread_idx").on(t.userId, t.readAt),
  ],
);

export const datasourcePlugins = sqliteTable("datasource_plugins", {
  driverId: text("driver_id").primaryKey(),
  label: text("label").notNull(),
  version: text("version").notNull(),
  fileName: text("file_name").notNull(),
  /** Entry path relative to `DATA_DIR/plugins/datasources` (POSIX slashes). */
  entryPath: text("entry_path").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  enabled: integer("enabled").notNull().default(1),
  uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Verified Few-shot NL2SQL examples per datasource, curated manually or from user feedback. */
export const sqlExamples = sqliteTable(
  "sql_examples",
  {
    id: text("id").primaryKey(),
    datasourceId: text("datasource_id")
      .notNull()
      .references(() => datasources.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    sqlText: text("sql_text").notNull(),
    notes: text("notes"),
    /** JSON array of normalized physical table names extracted from SQL AST for scope filtering. */
    tablesJson: text("tables_json").notNull().default("[]"),
    source: text("source", { enum: ["manual", "feedback_up", "feedback_fix"] })
      .notNull()
      .default("manual"),
    sourceRunId: text("source_run_id"),
    enabled: integer("enabled").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: integer("last_used_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("sql_examples_datasource_idx").on(t.datasourceId, t.enabled),
    index("sql_examples_source_run_idx").on(t.sourceRunId),
  ],
);
