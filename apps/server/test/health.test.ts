import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir: "./data-test",
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  adminUsername: "admin",
  isProduction: false,
};

describe("health", () => {
  it("returns ok", async () => {
    const app = await buildApp({ config, enableRateLimit: false });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it("returns ok with rate limiting enabled by default", async () => {
    const app = await buildApp({ config });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });
});
