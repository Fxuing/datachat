import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import { brandingRoutes } from "./routes/branding.js";
import { authRoutes } from "./routes/auth.js";
import { registerAuthGuards } from "./auth/guard.js";
import { createSessionSigner } from "./auth/jwt.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import { adminDepartmentRoutes } from "./routes/admin-departments.js";
import { adminDatasourcePluginRoutes } from "./routes/admin-datasource-plugins.js";
import { adminDataScopeRoutes } from "./routes/admin-data-scope.js";
import { adminSemanticRoutes } from "./routes/admin-semantic.js";
import { adminRoleRoutes } from "./routes/admin-roles.js";
import { adminSkillRoutes } from "./routes/admin-skills.js";
import { adminMcpRoutes } from "./routes/admin-mcp.js";
import { adminAuditRoutes } from "./routes/admin-audit.js";
import { adminSettingsRoutes } from "./routes/admin-settings.js";
import { datasourceRoutes } from "./routes/datasources.js";
import { skillRoutes } from "./routes/skills.js";
import { datasourceSchemaRoutes } from "./routes/datasource-schema.js";
import { modelsRoutes } from "./routes/models.js";
import { conversationRoutes } from "./routes/conversations.js";
import { conversationFileRoutes } from "./routes/conversation-files.js";
import { fileDatasetRoutes } from "./routes/file-datasets.js";
import { FILE_MAX_FILES_PER_UPLOAD, FILE_MAX_SIZE_BYTES } from "./services/file-import.js";
import { questionRoutes } from "./routes/questions.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { runRoutes } from "./routes/runs.js";
import { reportRoutes } from "./routes/reports.js";
import { dashboardRoutes } from "./routes/dashboards.js";
import { shareRoutes } from "./routes/shares.js";
import { PoolRegistry } from "./agent/datasource/pool.js";
import { DriverRegistry } from "./drivers/registry.js";
import { loadPersistedDatasourcePlugins } from "./services/datasource-plugins.js";
import { RuntimeManager } from "./agent/runtime.js";
import { ModelRuntimeManager } from "./agent/model-runtime.js";
import { seedLegacyLlmProvider } from "./services/llm-catalog.js";
import { llmProviderRoutes } from "./routes/admin-llm-providers.js";
import { opsRoutes } from "./routes/ops.js";
import { createRetentionService, type RetentionService } from "./services/ops-retention.js";
import { scheduledTaskRoutes } from "./routes/scheduled-tasks.js";
import { notificationRoutes } from "./routes/notifications.js";
import { memoryRoutes } from "./routes/memories.js";
import { createScheduledTaskService, type ScheduledTaskService } from "./services/scheduled-tasks.js";
import { ArtifactStore } from "./services/artifacts.js";
import { createRunSuggestionsService } from "./services/suggestions.js";
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
  /** Test seam; production creates a registry and loads DATASOURCE_PLUGINS. */
  drivers?: DriverRegistry;
  /** Test seam; shortens the MCP connection test timeout. */
  mcpTestTimeoutMs?: number;
  /** Reuse the retention service so the scheduler and routes share one lock. */
  retention?: RetentionService;
  /** Reuse the scheduled task service so the scheduler and routes share one instance. */
  scheduledTasks?: ScheduledTaskService;
  /** Test seam for post-reply follow-up suggestion generation. */
  suggestionsGenerator?: (prompt: string) => Promise<string>;
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
  drivers: injectedDrivers,
  mcpTestTimeoutMs,
  retention: injectedRetention,
  scheduledTasks: injectedScheduledTasks,
  suggestionsGenerator,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
  });
  const signer = createSessionSigner(config.appSecret);

  await app.register(import("@fastify/cookie"));
  await app.register(import("@fastify/multipart"), {
    limits: {
      fileSize: FILE_MAX_SIZE_BYTES,
      files: FILE_MAX_FILES_PER_UPLOAD,
      fields: 20,
      fieldSize: 64 * 1024,
    },
  });
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
  await app.register(brandingRoutes, { config });
  await app.register(authRoutes, { config, db, signer });
  await app.register(adminUserRoutes, { db });
  await app.register(adminDepartmentRoutes, { db });
  const drivers = injectedDrivers ?? new DriverRegistry();
  const pluginLog = (
    level: "info" | "warn" | "error",
    message: string,
    detail?: Record<string, unknown>,
  ) => {
    if (level === "error") app.log.error(detail ?? {}, message);
    else if (level === "warn") app.log.warn(detail ?? {}, message);
    else app.log.info(detail ?? {}, message);
  };
  if (!injectedDrivers && (config.datasourcePlugins?.length ?? 0) > 0) {
    await drivers.loadExternalPlugins(config.datasourcePlugins ?? [], {
      strict: config.datasourcePluginsStrict,
      log: pluginLog,
    });
  }
  if (!injectedDrivers) {
    await loadPersistedDatasourcePlugins({ db, config, drivers, log: pluginLog });
  }

  await app.register(adminDataScopeRoutes, { db, drivers });
  await app.register(adminSemanticRoutes, { db, drivers });
  await app.register(adminRoleRoutes, { db });
  await app.register(adminSkillRoutes, { db, agentDir: config.agentDir });
  await app.register(adminMcpRoutes, { db, config, mcpTestTimeoutMs });
  await app.register(adminAuditRoutes, { db });
  await app.register(adminSettingsRoutes, { db, config, getRuntime: () => modelRuntime.get() });
  await app.register(llmProviderRoutes, { db, config, manager: modelRuntime });
  const artifacts =
    injectedArtifacts ??
    new ArtifactStore(db, path.join(config.dataDir, "artifacts"));
  await artifacts.init();
  const pools = injectedPools ?? new PoolRegistry(drivers);
  const agentRuntime =
    injectedAgentRuntime ??
    new RuntimeManager({
      config,
      db,
      pools,
      artifacts,
      drivers,
      getModelRuntime: () => modelRuntime.get(),
    });
  const retention =
    injectedRetention ??
    createRetentionService({ db, config, runtime: agentRuntime, artifacts });
  const scheduledTasks =
    injectedScheduledTasks ??
    createScheduledTaskService({ db, config, pools, artifacts, runtime: agentRuntime });
  await app.register(datasourceRoutes, { config, db, pools, drivers });
  await app.register(adminDatasourcePluginRoutes, { config, db, pools, drivers });
  await app.register(skillRoutes, { db });
  await app.register(datasourceSchemaRoutes, { config, db, pools, drivers });
  await app.register(modelsRoutes, { config, db, getRuntime: () => modelRuntime.get() });
  await app.register(conversationRoutes, {
    config,
    db,
    artifacts,
    runtime: agentRuntime,
    getRuntime: () => modelRuntime.get(),
  });
  await app.register(conversationFileRoutes, {
    config,
    db,
    runtime: agentRuntime,
    getRuntime: () => modelRuntime.get(),
  });
  await app.register(fileDatasetRoutes, {
    config,
    db,
    runtime: agentRuntime,
    getRuntime: () => modelRuntime.get(),
  });
  await app.register(questionRoutes, { db, runtime: agentRuntime });
  await app.register(artifactRoutes, { db, artifacts });
  await app.register(reportRoutes, { db, artifacts });
  await app.register(dashboardRoutes, { config, db, pools, artifacts, drivers });
  await app.register(shareRoutes, { db, artifacts, config });
  const runSuggestions = createRunSuggestionsService({
    db,
    config,
    getModelRuntime: () => modelRuntime.get(),
    ...(suggestionsGenerator ? { generateOverride: suggestionsGenerator } : {}),
    log: (event, data) => console.info(JSON.stringify({ event, ...data })),
  });
  await app.register(runRoutes, { db, runtime: agentRuntime, suggestions: runSuggestions });
  await app.register(opsRoutes, { db, dataDir: config.dataDir, retention });
  await app.register(scheduledTaskRoutes, { db, scheduledTasks });
  await app.register(notificationRoutes, { db });
  await app.register(memoryRoutes, { db });
  app.addHook("onClose", async () => {
    await scheduledTasks.shutdown();
    await agentRuntime.shutdown();
    await artifacts.close();
    await pools.closeAll();
  });
  return app;
}
