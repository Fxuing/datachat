import {
  DATASOURCE_SDK_VERSION,
  type AstParserDialect,
  type DatasourceDriver,
  type DatasourceDriverManifest,
  type NormalizedColumnType,
  type PlaceholderStyle,
} from "./types.js";

export const DRIVER_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const MAX_PROMPT_GUIDANCE_LENGTH = 800;

const VALID_PARSER_DIALECTS = new Set<AstParserDialect>([
  "mysql",
  "postgresql",
  "sqlite",
  "transactsql",
  "bigquery",
  "snowflake",
  "hive",
  "mariadb",
  "flinksql",
  "redshift",
  "trino",
  "athena",
]);

const VALID_PLACEHOLDER_STYLES = new Set<PlaceholderStyle>(["qmark", "dollar", "at", "colon"]);

/** Collapse driver error strings into a single bounded line and scrub secrets. */
export function safeDriverErrorMessage(error: unknown, secrets: Array<string | undefined> = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      message = message.split(secret).join("***");
    }
  }
  message = message.replace(/\s+/g, " ").trim();
  return message.slice(0, 500) || "连接失败";
}

/** Map raw database type names (e.g. Int64, Decimal(18,2), DateTime64, JSONB) into DataChat column types. */
export function normalizeColumnType(rawType: string | null | undefined): NormalizedColumnType {
  if (!rawType) return "unknown";
  const normalized = rawType.toLowerCase().trim();
  if (!normalized) return "unknown";

  if (/\bbool(ean)?\b/.test(normalized) || normalized === "bit(1)") return "boolean";
  if (/\bjsonb?\b/.test(normalized)) return "json";
  if (/(date|time|year|interval)/.test(normalized) && !/(int|char|text|str)/.test(normalized)) {
    return "date";
  }
  if (
    /(int|uint|float|double|decimal|numeric|real|serial|money|number|fixed|dec)/.test(normalized)
  ) {
    return "number";
  }
  if (/(char|text|string|clob|uuid|enum|set|varchar|nvarchar|fixedstring|lowcardinality)/.test(normalized)) {
    return "string";
  }
  return "unknown";
}

/** Validate a driver manifest & runtime shape before registering it into DataChat core. */
export function validateDatasourceDriver(candidate: unknown): {
  ok: true;
  driver: DatasourceDriver;
} | {
  ok: false;
  reason: string;
} {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, reason: "驱动导出必须是对象" };
  }
  const driver = candidate as Partial<DatasourceDriver>;
  const manifest = driver.manifest as Partial<DatasourceDriverManifest> | undefined;
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, reason: "缺少 manifest 对象" };
  }
  if (manifest.sdkVersion !== DATASOURCE_SDK_VERSION) {
    return {
      ok: false,
      reason: `不兼容的 sdkVersion（期望 ${DATASOURCE_SDK_VERSION}，收到 ${String(manifest.sdkVersion)}）`,
    };
  }
  if (typeof manifest.id !== "string" || !DRIVER_ID_RE.test(manifest.id)) {
    return { ok: false, reason: `非法的驱动 id：${String(manifest.id)}` };
  }
  if (typeof manifest.label !== "string" || !manifest.label.trim() || manifest.label.length > 64) {
    return { ok: false, reason: "manifest.label 必须为 1-64 个字符" };
  }
  if (manifest.connectionMode !== "network") {
    return { ok: false, reason: `暂不支持的连接模式：${String(manifest.connectionMode)}` };
  }
  if (
    typeof manifest.defaultPort !== "number" ||
    !Number.isInteger(manifest.defaultPort) ||
    manifest.defaultPort < 1 ||
    manifest.defaultPort > 65535
  ) {
    return { ok: false, reason: "manifest.defaultPort 必须为 1-65535 整数" };
  }
  if (typeof manifest.supportsSsl !== "boolean") {
    return { ok: false, reason: "manifest.supportsSsl 必须为布尔值" };
  }
  if (!Array.isArray(manifest.optionsSchema)) {
    return { ok: false, reason: "manifest.optionsSchema 必须为数组" };
  }
  const seenKeys = new Set<string>();
  for (const field of manifest.optionsSchema) {
    if (!field || typeof field !== "object" || typeof field.key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field.key)) {
      return { ok: false, reason: `非法的 optionsSchema key：${String(field?.key)}` };
    }
    if (seenKeys.has(field.key)) {
      return { ok: false, reason: `重复的 optionsSchema key：${field.key}` };
    }
    seenKeys.add(field.key);
    if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0)) {
      return { ok: false, reason: `select 字段 ${field.key} 必须提供 options` };
    }
  }
  if (
    !manifest.capabilities ||
    typeof manifest.capabilities.explain !== "boolean" ||
    typeof manifest.capabilities.readOnlyProbe !== "boolean" ||
    typeof manifest.capabilities.rowScope !== "boolean"
  ) {
    return { ok: false, reason: "manifest.capabilities 缺少必需的布尔标志" };
  }

  const dialect = driver.dialect;
  if (!dialect || typeof dialect !== "object") {
    return { ok: false, reason: "缺少 dialect 声明" };
  }
  if (!VALID_PARSER_DIALECTS.has(dialect.parserDialect)) {
    return { ok: false, reason: `不支持的 parserDialect：${String(dialect.parserDialect)}` };
  }
  if (!VALID_PLACEHOLDER_STYLES.has(dialect.placeholderStyle)) {
    return { ok: false, reason: `不支持的 placeholderStyle：${String(dialect.placeholderStyle)}` };
  }
  if (dialect.quoteChar !== "`" && dialect.quoteChar !== '"' && dialect.quoteChar !== "[") {
    return { ok: false, reason: `非法的 quoteChar：${String(dialect.quoteChar)}` };
  }
  if (
    dialect.promptGuidance !== undefined &&
    (typeof dialect.promptGuidance !== "string" || dialect.promptGuidance.length > MAX_PROMPT_GUIDANCE_LENGTH)
  ) {
    return { ok: false, reason: `dialect.promptGuidance 不能超过 ${MAX_PROMPT_GUIDANCE_LENGTH} 字` };
  }

  if (typeof driver.probe !== "function") {
    return { ok: false, reason: "缺少 probe(config, signal) 方法" };
  }
  if (typeof driver.createPool !== "function") {
    return { ok: false, reason: "缺少 createPool(config) 方法" };
  }
  return { ok: true, driver: driver as DatasourceDriver };
}

/** Type-safe helper for plugin authors that validates manifest & dialect at definition time. */
export function defineDatasourceDriver(driver: DatasourceDriver): DatasourceDriver {
  const checked = validateDatasourceDriver(driver);
  if (!checked.ok) {
    throw new Error(`Invalid DataChat datasource driver: ${checked.reason}`);
  }
  return checked.driver;
}
