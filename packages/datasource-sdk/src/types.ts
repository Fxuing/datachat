export const DATASOURCE_SDK_VERSION = 1 as const;

export type ConnectionMode = "network";

export type SslMode = "disable" | "require" | "no-verify";

export type OptionValue = string | number | boolean;

export type OptionFieldSchema =
  | {
      key: string;
      label: string;
      type: "text" | "number" | "boolean";
      required?: boolean;
      /** Encrypted at rest by DataChat core via AES-GCM; never returned by GET APIs. */
      secret?: boolean;
      defaultValue?: OptionValue;
      placeholder?: string;
      description?: string;
    }
  | {
      key: string;
      label: string;
      type: "select";
      required?: boolean;
      defaultValue?: string;
      options: Array<{ value: string; label: string }>;
      description?: string;
    };

export interface DatasourceDriverCapabilities {
  /** Whether the engine supports EXPLAIN plans for db_explain. */
  explain: boolean;
  /** Whether probe() can verify that the configured account is read-only. */
  readOnlyProbe: boolean;
  /** Whether DataChat core can rewrite SQL ASTs with parameterized row-level scope filters. */
  rowScope: boolean;
}

export interface DatasourceDriverManifest {
  sdkVersion: typeof DATASOURCE_SDK_VERSION;
  /** Lowercase driver identifier, e.g. "mysql", "postgres", "clickhouse". */
  id: string;
  /** Human-readable display label shown in Admin & Chat UI. */
  label: string;
  connectionMode: ConnectionMode;
  defaultPort: number;
  supportsSsl: boolean;
  /** Extra driver-specific configuration fields rendered dynamically in Admin UI. */
  optionsSchema: OptionFieldSchema[];
  capabilities: DatasourceDriverCapabilities;
}

/** Dialects understood by DataChat core's AST SQL guard (`node-sql-parser`). */
export type AstParserDialect =
  | "mysql"
  | "postgresql"
  | "sqlite"
  | "transactsql"
  | "bigquery"
  | "snowflake"
  | "hive"
  | "mariadb"
  | "flinksql"
  | "redshift"
  | "trino"
  | "athena";

/** Parameter placeholder style used when core rewrites row-level scope conditions. */
export type PlaceholderStyle = "qmark" | "dollar" | "at" | "colon";

export interface DialectProfile {
  parserDialect: AstParserDialect;
  placeholderStyle: PlaceholderStyle;
  quoteChar: "`" | '"' | "[";
  /** Additional dangerous SQL functions blocked by guardSql (merged with core global list). */
  extraForbiddenFunctions?: string[];
  /** Additional internal/system schemas blocked by guardSql (merged with core global list). */
  extraSystemSchemas?: string[];
  /** Optional concise SQL dialect guidance injected into the agent system prompt (max 800 chars). */
  promptGuidance?: string;
}

export interface ResolvedConnectionConfig {
  id: string;
  type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: SslMode;
  /** Validated & decrypted driver options declared in manifest.optionsSchema. */
  options: Record<string, OptionValue | undefined>;
}

export interface ProbeResult {
  ok: boolean;
  serverVersion?: string;
  readOnly: boolean;
  warnings: string[];
  error?: string;
}

export type NormalizedColumnType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "unknown";

export interface NormalizedColumn {
  name: string;
  type: NormalizedColumnType;
}

export interface QueryBatch {
  columns: NormalizedColumn[];
  rows: unknown[][];
}

export interface QueryExecutionRequest {
  /** Guarded (and optionally scope-rewritten) read-only SQL statement. */
  sql: string;
  /** Positional bound parameters matching DialectProfile.placeholderStyle. */
  params: unknown[];
  /** Suggested batch size for streaming rows back to core. */
  batchSize: number;
  /** Hard row cap; core also enforces this cap independently. */
  maxRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string | null;
}

export interface SchemaIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface SchemaForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface SchemaTable {
  schema: string;
  name: string;
  comment: string | null;
  /** Approximate row count from table statistics; null when unavailable. */
  rowEstimate: number | null;
  columns: SchemaColumn[];
  primaryKey: string[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
}

export interface SchemaSnapshot {
  tables: SchemaTable[];
  refreshedAt: number;
}

export interface DatasourceDriverPool {
  introspect(signal?: AbortSignal): Promise<SchemaSnapshot>;
  executeQuery(
    request: QueryExecutionRequest,
    emitBatch: (batch: QueryBatch) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

export type DriverErrorKind = "timeout" | "aborted" | "sql_error";

export interface DatasourceDriver {
  readonly manifest: DatasourceDriverManifest;
  readonly dialect: DialectProfile;
  probe(config: ResolvedConnectionConfig, signal?: AbortSignal): Promise<ProbeResult>;
  createPool(config: ResolvedConnectionConfig): DatasourceDriverPool;
  classifyError?(error: unknown): DriverErrorKind;
}

/** Public wire representation returned by GET /api/datasources/drivers. */
export interface PublicDriverDescriptor extends DatasourceDriverManifest {
  builtin: boolean;
}
