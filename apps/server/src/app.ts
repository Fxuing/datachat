import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import type { AppConfig } from "./config.js";

export interface BuildAppOptions {
  config: AppConfig;
  enableRateLimit?: boolean;
}

export async function buildApp({ config, enableRateLimit = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  await app.register(import("@fastify/cookie"));
  if (enableRateLimit) {
    await app.register(import("@fastify/rate-limit"), { global: false });
  }
  await app.register(healthRoutes);
  return app;
}
