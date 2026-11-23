import path from "node:path";
import { z } from "zod";

/** Repo root: both `apps/server/src` and `apps/server/dist` sit three levels below it. */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const PLACEHOLDER_SECRETS = new Set(["replace-with-at-least-32-random-characters"]);
const PLACEHOLDER_PASSWORDS = new Set(["change-me-now", "changeme", "password"]);

/** Treat blank env vars (e.g. `FOO=` in .env) as unset so defaults/optional apply. */
const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

const envSchema = z
  .object({
    PORT: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(65535).default(8080),
    ),
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z.enum(["development", "test", "production"]).default("development"),
    ),
    APP_SECRET: z.string().min(32, "APP_SECRET 至少 32 个字符"),
    DATA_DIR: z.preprocess(emptyToUndefined, z.string().default("./data")),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z
        .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
        .default("info"),
    ),
    SILICONFLOW_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    SILICONFLOW_BASE_URL: z.string().url().default("https://api.siliconflow.cn/v1"),
    /** Comma-separated browser origins explicitly trusted for CSRF checks (proxy/TLS terminations). */
    APP_ORIGIN: z.preprocess(emptyToUndefined, z.string().optional()),
    ADMIN_USERNAME: z
      .string()
      .trim()
      .min(2, "ADMIN_USERNAME 至少 2 个字符")
      .max(64, "ADMIN_USERNAME 最多 64 个字符")
      .default("admin"),
    ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(8).max(200).optional()),
    QUERY_MAX_ROWS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(100_000),
    ),
    QUERY_PREVIEW_ROWS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(200),
    ),
    QUERY_TIMEOUT_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(30_000),
    ),
    /** Background retention sweep interval; 0 disables it (manual runs remain). */
    RETENTION_SWEEP_HOURS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).max(8760).default(0),
    ),
    /** Allow MCP http(s) endpoints on loopback/private/metadata addresses (tests only). */
    /** Trust X-Forwarded-* headers; enable only behind the bundled nginx. */
    TRUST_PROXY: z.preprocess(
      emptyToUndefined,
      z
        .enum(["true", "false", "1", "0"])
        .default("false")
        .transform((value) => value === "true" || value === "1"),
    ),
    /** Force the session cookie Secure flag; defaults to https when APP_ORIGIN is configured. */
    COOKIE_SECURE: z.preprocess(
      emptyToUndefined,
      z
        .enum(["true", "false", "1", "0"])
        .transform((value) => value === "true" || value === "1")
        .optional(),
    ),
    MCP_ALLOW_PRIVATE_HOSTS: z.preprocess(
      emptyToUndefined,
      z
        .enum(["true", "false", "1", "0"])
        .default("false")
        .transform((value) => value === "true" || value === "1"),
    ),
    /** Comma-separated npm package names or paths of external datasource driver plugins. */
    DATASOURCE_PLUGINS: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Fail server startup if any plugin in DATASOURCE_PLUGINS fails to load. */
    DATASOURCE_PLUGINS_STRICT: z.preprocess(
      emptyToUndefined,
      z
        .enum(["true", "false", "1", "0"])
        .default("false")
        .transform((value) => value === "true" || value === "1"),
    ),
    /** Allow admins to upload offline datasource driver plugins from the Web UI. */
    ALLOW_PLUGIN_UPLOAD: z.preprocess(
      emptyToUndefined,
      z
        .enum(["true", "false", "1", "0"])
        .default("true")
        .transform((value) => value === "true" || value === "1"),
    ),
    /** Optional white-label branding overrides (runtime env; defaults keep DataChat branding). */
    APP_TITLE: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(80).optional()),
    APP_SUBTITLE: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(120).optional()),
    APP_ICON: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(500).optional()),
    APP_FAVICON: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(500).optional()),
  })
  .superRefine((env, ctx) => {
    if (PLACEHOLDER_SECRETS.has(env.APP_SECRET.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_SECRET"],
        message: "APP_SECRET must be a real random secret",
      });
    }
    if (
      env.ADMIN_PASSWORD !== undefined &&
      PLACEHOLDER_PASSWORDS.has(env.ADMIN_PASSWORD.trim())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ADMIN_PASSWORD"],
        message: "ADMIN_PASSWORD must not be a placeholder value",
      });
    }
  });

export interface AppConfig {
  port: number;
  appSecret: string;
  dataDir: string;
  dbPath: string;
  /** Repo-level agent assets (models.json, prompts, skills). */
  agentDir: string;
  /** Pi credential store; kept out of the repo so it can be mounted as a volume. */
  agentAuthPath: string;
  logLevel: string;
  siliconflowApiKey?: string;
  siliconflowBaseUrl: string;
  /** Normalized trusted origins from `APP_ORIGIN`, e.g. https://chat.example.com. */
  appOrigins: string[];
  adminUsername: string;
  adminPassword?: string;
  isProduction: boolean;
  /** Explicit Secure flag for the session cookie; undefined means derive per request. */
  cookieSecure?: boolean;
  queryMaxRows: number;
  queryPreviewRows: number;
  queryTimeoutMs: number;
  /** Hours between automatic retention sweeps; 0 means manual-only. */
  retentionSweepHours: number;
  /** Whether MCP http(s) urls may target loopback/link-local/RFC1918 addresses. */
  mcpAllowPrivateHosts: boolean;
  trustProxy: boolean;
  /** External datasource driver plugin specifiers loaded at startup. */
  datasourcePlugins?: string[];
  datasourcePluginsStrict?: boolean;
  /** Allow admins to upload offline datasource driver plugins via the UI (default true). */
  allowPluginUpload?: boolean;
  /** Optional custom app title (default "DataChat"). */
  appTitle?: string;
  /** Optional custom sidebar subtitle (default "数据工作台"). */
  appSubtitle?: string;
  /** Optional custom logo URL, web path, or local file path (default "/logo.svg"). */
  appIcon?: string;
  /** Optional custom favicon URL, web path, or local file path (defaults to appIcon or "/favicon.svg"). */
  appFavicon?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let parsed: z.infer<typeof envSchema>;
  try {
    parsed = envSchema.parse(env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        "Invalid env: " +
          error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    throw error;
  }

  // Resolve relative data dirs against the repo root so the DB location does not
  // depend on the directory the process happened to be started from.
  const dataDir = path.isAbsolute(parsed.DATA_DIR)
    ? parsed.DATA_DIR
    : path.resolve(REPO_ROOT, parsed.DATA_DIR);

  return {
    port: parsed.PORT,
    appSecret: parsed.APP_SECRET,
    dataDir,
    dbPath: path.join(dataDir, "datachat.db"),
    agentDir: path.resolve(REPO_ROOT, "agent"),
    agentAuthPath: path.join(dataDir, "agent", "auth.json"),
    logLevel: parsed.LOG_LEVEL,
    siliconflowApiKey: parsed.SILICONFLOW_API_KEY,
    siliconflowBaseUrl: parsed.SILICONFLOW_BASE_URL,
    appOrigins: (parsed.APP_ORIGIN ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    isProduction: parsed.NODE_ENV === "production",
    cookieSecure: parsed.COOKIE_SECURE,
    queryMaxRows: parsed.QUERY_MAX_ROWS,
    queryPreviewRows: parsed.QUERY_PREVIEW_ROWS,
    queryTimeoutMs: parsed.QUERY_TIMEOUT_MS,
    retentionSweepHours: parsed.RETENTION_SWEEP_HOURS,
    mcpAllowPrivateHosts: parsed.MCP_ALLOW_PRIVATE_HOSTS,
    trustProxy: parsed.TRUST_PROXY,
    datasourcePlugins: (parsed.DATASOURCE_PLUGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    datasourcePluginsStrict: parsed.DATASOURCE_PLUGINS_STRICT,
    allowPluginUpload: parsed.ALLOW_PLUGIN_UPLOAD,
    appTitle: parsed.APP_TITLE,
    appSubtitle: parsed.APP_SUBTITLE,
    appIcon: parsed.APP_ICON,
    appFavicon: parsed.APP_FAVICON,
  };
}
