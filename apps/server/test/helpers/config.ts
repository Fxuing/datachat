import type { AppConfig } from "../../src/config.js";

/** Shared AppConfig fixture; spread it when a test needs its own dataDir/dbPath. */
export const testConfig: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir: "./data-test",
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  appOrigins: [],
  adminUsername: "admin",
  isProduction: false,
  queryMaxRows: 1000,
  queryPreviewRows: 200,
  queryTimeoutMs: 5000,
};
