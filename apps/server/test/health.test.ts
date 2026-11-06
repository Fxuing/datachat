import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
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
  let app: FastifyInstance | undefined;
  const handle = createDb(":memory:");
  migrateDb(handle.db);

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(() => {
    handle.sqlite.close();
  });

  it("returns ok", async () => {
    app = await buildApp({ config, db: handle.db, enableRateLimit: false });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("registers rate limiting without throwing", async () => {
    app = await buildApp({ config, db: handle.db });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("enforces per-route rate limits", async () => {
    app = await buildApp({ config, db: handle.db });
    app.get(
      "/api/limited",
      { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } },
      async () => ({ ok: true }),
    );

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: "GET", url: "/api/limited" });
      statuses.push(res.statusCode);
    }

    expect(statuses).toEqual([200, 200, 429]);
  });
});
