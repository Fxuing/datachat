import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { registerAuthGuards } from "./auth/guard.js";
import { createSessionSigner } from "./auth/jwt.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import { datasourceRoutes } from "./routes/datasources.js";
import { datasourceSchemaRoutes } from "./routes/datasource-schema.js";
import { PoolRegistry } from "./agent/datasource/pool.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** Only skips registering the plugin for isolated unit tests; there is no global limit. */
  enableRateLimit?: boolean;
}

export async function buildApp({
  config,
  db,
  enableRateLimit = true,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  const signer = createSessionSigner(config.appSecret);

  await app.register(import("@fastify/cookie"));
  // Global limiting is off by design (`global: false`); individual routes opt in via
  // `config: { rateLimit: { max, timeWindow } }`.
  if (enableRateLimit) {
    await app.register(import("@fastify/rate-limit"), { global: false });
  }

  // CSRF: SameSite=Lax plus a same-origin check for state-changing requests.
  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (!origin) return;
    const host = request.headers.host;
    try {
      if (new URL(origin).host !== host) {
        return reply.code(403).send({ error: { code: "CSRF", message: "跨站请求被拒绝" } });
      }
    } catch {
      return reply.code(403).send({ error: { code: "CSRF", message: "非法 Origin" } });
    }
  });

  registerAuthGuards(app, signer);
  await app.register(healthRoutes);
  await app.register(authRoutes, { config, db, signer });
  await app.register(adminUserRoutes, { db });
  await app.register(datasourceRoutes, { config, db });
  // TODO(Task 8): create the ArtifactStore at `path.join(config.dataDir, "artifacts")`
  // here and close it in the onClose hook once `services/artifacts.ts` exists.
  const pools = new PoolRegistry();
  await app.register(datasourceSchemaRoutes, { config, db, pools });
  app.addHook("onClose", async () => {
    await pools.closeAll();
  });
  return app;
}
