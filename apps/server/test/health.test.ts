import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { buildApp } from "../src/app.js";
import { healthRoutes } from "../src/routes/health.js";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

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
    expect(res.json()).toMatchObject({ ok: true, db: "ok" });
  });

  it("reports a database error without failing the health endpoint", async () => {
    const broken = Fastify();
    await broken.register(healthRoutes, {
      db: {
        get: () => {
          throw new Error("database unavailable");
        },
      } as never,
    });
    const res = await broken.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: "error" });
    await broken.close();
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
