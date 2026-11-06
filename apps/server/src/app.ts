import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import type { AppConfig } from "./config.js";

export interface BuildAppOptions {
  config: AppConfig;
  /** Only skips registering the plugin for isolated unit tests; there is no global limit. */
  enableRateLimit?: boolean;
}

export async function buildApp({ config, enableRateLimit = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  await app.register(import("@fastify/cookie"));
  // Global limiting is off by design (`global: false`); individual routes opt in via
  // `config: { rateLimit: { max, timeWindow } }`.
  if (enableRateLimit) {
    await app.register(import("@fastify/rate-limit"), { global: false });
  }
  await app.register(healthRoutes);
  return app;
}
