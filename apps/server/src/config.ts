import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8080),
  APP_SECRET: z.string().min(32, "APP_SECRET 至少 32 个字符"),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.string().default("info"),
  SILICONFLOW_API_KEY: z.string().optional(),
  SILICONFLOW_BASE_URL: z.string().url().default("https://api.siliconflow.cn/v1"),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().min(8).optional(),
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
  const parsed = envSchema.parse(env);
  const dataDir = path.resolve(parsed.DATA_DIR);
  return {
    port: parsed.PORT,
    appSecret: parsed.APP_SECRET,
    dataDir,
    dbPath: path.join(dataDir, "datachat.db"),
    logLevel: parsed.LOG_LEVEL,
    siliconflowApiKey: parsed.SILICONFLOW_API_KEY || undefined,
    siliconflowBaseUrl: parsed.SILICONFLOW_BASE_URL,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    isProduction: env.NODE_ENV === "production",
  };
}
