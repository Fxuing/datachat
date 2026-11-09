import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { registerAuthGuards } from "./auth/guard.js";
import { createSessionSigner } from "./auth/jwt.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import { adminSkillRoutes } from "./routes/admin-skills.js";
import { adminMcpRoutes } from "./routes/admin-mcp.js";
import { adminAuditRoutes } from "./routes/admin-audit.js";
import { adminSettingsRoutes } from "./routes/admin-settings.js";
import { datasourceRoutes } from "./routes/datasources.js";
import { datasourceSchemaRoutes } from "./routes/datasource-schema.js";
import { modelsRoutes } from "./routes/models.js";
import { conversationRoutes } from "./routes/conversations.js";
import { questionRoutes } from "./routes/questions.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { runRoutes } from "./routes/runs.js";
import { reportRoutes } from "./routes/reports.js";
import { shareRoutes } from "./routes/shares.js";
import { PoolRegistry } from "./agent/datasource/pool.js";
import { RuntimeManager } from "./agent/runtime.js";
import { ModelRuntimeManager } from "./agent/model-runtime.js";
import { seedLegacyLlmProvider } from "./services/llm-catalog.js";
import { llmProviderRoutes } from "./routes/admin-llm-providers.js";
import { ArtifactStore } from "./services/artifacts.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** Only skips registering the plugin for isolated unit tests; there is no global limit. */
  enableRateLimit?: boolean;
  /** Test seam; production passes the manager created in index.ts. */
  agentRuntime?: RuntimeManager;
  /** Reuse stores created by the production entrypoint. */
  artifacts?: ArtifactStore;
  pools?: PoolRegistry;
  /** Test seam; shortens the MCP connection test timeout. */
  mcpTestTimeoutMs?: number;
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
  agentRuntime: injectedAgentRuntime,
  artifacts: injectedArtifacts,
  pools: injectedPools,
  mcpTestTimeoutMs,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
  });
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

  // Import the legacy SiliconFlow config once so existing deployments keep working.
  seedLegacyLlmProvider(db, config);
  const modelRuntime = new ModelRuntimeManager(config, db);

  registerAuthGuards(app, { signer, db });
  await app.register(healthRoutes, { db });
  await app.register(authRoutes, { config, db, signer });
  await app.register(adminUserRoutes, { db });
  await app.register(adminSkillRoutes, { db, agentDir: config.agentDir });
  await app.register(adminMcpRoutes, { db, config, mcpTestTimeoutMs });
  await app.register(adminAuditRoutes, { db });
  await app.register(adminSettingsRoutes, { db, config, getRuntime: () => modelRuntime.get() });
  await app.register(llmProviderRoutes, { db, config, manager: modelRuntime });
  const artifacts =
    injectedArtifacts ??
    new ArtifactStore(db, path.join(config.dataDir, "artifacts"));
  await artifacts.init();
  const pools = injectedPools ?? new PoolRegistry();
  const agentRuntime =
    injectedAgentRuntime ??
    new RuntimeManager({
      config,
      db,
      pools,
      artifacts,
      getModelRuntime: () => modelRuntime.get(),
    });
  await app.register(datasourceRoutes, { config, db, pools });
  await app.register(datasourceSchemaRoutes, { config, db, pools });
  await app.register(modelsRoutes, { config, db, getRuntime: () => modelRuntime.get() });
  await app.register(conversationRoutes, {
    config,
    db,
    artifacts,
    runtime: agentRuntime,
    getRuntime: () => modelRuntime.get(),
  });
  await app.register(questionRoutes, { db, runtime: agentRuntime });
  await app.register(artifactRoutes, { db, artifacts });
  await app.register(reportRoutes, { db, artifacts });
  await app.register(shareRoutes, { db, artifacts, config });
  await app.register(runRoutes, { db, runtime: agentRuntime });
  app.addHook("onClose", async () => {
    await agentRuntime.shutdown();
    await artifacts.close();
    await pools.closeAll();
  });
  return app;
}
