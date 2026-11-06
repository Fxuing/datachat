import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { registerAuthGuards } from "./auth/guard.js";
import { createSessionSigner } from "./auth/jwt.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import { datasourceRoutes } from "./routes/datasources.js";
import { datasourceSchemaRoutes } from "./routes/datasource-schema.js";
import { modelsRoutes } from "./routes/models.js";
import { PoolRegistry } from "./agent/datasource/pool.js";
import { ArtifactStore } from "./services/artifacts.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** Only skips registering the plugin for isolated unit tests; there is no global limit. */
  enableRateLimit?: boolean;
}

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hostWithScheme(host: string, scheme: string): string {
  const normalized = host.trim().toLowerCase();
  const defaultPort = scheme === "https" ? ":443" : ":80";
  return normalized.endsWith(defaultPort)
    ? normalized.slice(0, -defaultPort.length)
    : normalized;
}

/** Compare scheme + host + port, treating :80/:443 as the scheme default. */
export function isSameOrigin(origin: string, protocol: string, host: string): boolean {
  const url = new URL(origin);
  const scheme = protocol.replace(/:$/, "");
  if (url.protocol !== `${scheme}:`) return false;
  return hostWithScheme(url.host, scheme) === hostWithScheme(host, scheme);
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
  // Browsers send Origin (or Referer on older clients); compare the full origin,
  // not just Host, so http://host cannot post to https://host and default ports
  // normalize correctly. APP_ORIGIN is the escape hatch for reverse proxies.
  const trustedOrigins = new Set(
    config.appOrigins.map((value) => normalizeOrigin(value)).filter((value): value is string => Boolean(value)),
  );
  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const candidate = request.headers.origin ?? request.headers.referer;
    if (!candidate) return;
    const origin = normalizeOrigin(candidate);
    if (!origin) {
      return reply.code(403).send({ error: { code: "CSRF", message: "非法 Origin" } });
    }
    if (trustedOrigins.has(origin)) return;
    const host = request.headers.host;
    if (!host || !isSameOrigin(origin, request.protocol, host)) {
      return reply.code(403).send({ error: { code: "CSRF", message: "跨站请求被拒绝" } });
    }
  });

  registerAuthGuards(app, { signer, db });
  await app.register(healthRoutes, { db });
  await app.register(authRoutes, { config, db, signer });
  await app.register(adminUserRoutes, { db });
  const artifacts = new ArtifactStore(db, path.join(config.dataDir, "artifacts"));
  await artifacts.init();
  const pools = new PoolRegistry();
  await app.register(datasourceRoutes, { config, db, pools });
  await app.register(datasourceSchemaRoutes, { config, db, pools });
  await app.register(modelsRoutes, { config });
  app.addHook("onClose", async () => {
    await artifacts.close();
    await pools.closeAll();
  });
  return app;
}
