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
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_SECRET: z.string().min(32, "APP_SECRET 至少 32 个字符"),
    DATA_DIR: z.string().default("./data"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    SILICONFLOW_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    SILICONFLOW_BASE_URL: z.string().url().default("https://api.siliconflow.cn/v1"),
    ADMIN_USERNAME: z.string().default("admin"),
    ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  })
  .superRefine((env, ctx) => {
    if (PLACEHOLDER_SECRETS.has(env.APP_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_SECRET"],
        message: "APP_SECRET must be a real random secret",
      });
    }
    if (env.ADMIN_PASSWORD !== undefined && PLACEHOLDER_PASSWORDS.has(env.ADMIN_PASSWORD)) {
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
  logLevel: string;
  siliconflowApiKey?: string;
  siliconflowBaseUrl: string;
  adminUsername: string;
  adminPassword?: string;
  isProduction: boolean;
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
    logLevel: parsed.LOG_LEVEL,
    siliconflowApiKey: parsed.SILICONFLOW_API_KEY,
    siliconflowBaseUrl: parsed.SILICONFLOW_BASE_URL,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    isProduction: parsed.NODE_ENV === "production",
  };
}
