import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { RuntimeManager } from "./agent/runtime.js";
import { PoolRegistry } from "./agent/datasource/pool.js";
import { ArtifactStore } from "./services/artifacts.js";
import { createDb } from "./db/client.js";
import { migrateDb } from "./db/migrate.js";
import { bootstrapAdmin } from "./auth/bootstrap.js";
import { seedSkills } from "./agent/skills.js";
import { reconcileInterruptedRuns } from "./services/startup.js";
import { createRetentionService } from "./services/ops-retention.js";
import { createScheduledTaskService } from "./services/scheduled-tasks.js";
import { sweepDueDashboards } from "./services/dashboards.js";
import { DriverRegistry } from "./drivers/registry.js";
import { loadPersistedDatasourcePlugins } from "./services/datasource-plugins.js";
import { startScheduledTaskSweeper } from "./agent/scheduler.js";
import { failInterruptedScheduledRuns } from "./db/repositories/scheduled-tasks.js";

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });

const handle = createDb(config.dbPath);
const { adminPassword: _adminPassword, ...appConfig } = config;

// Migrations must run before buildApp: startup wiring (LLM provider seeding,
// settings defaults) reads tables that a fresh database does not have yet.
const appliedMigrations = migrateDb(handle.db);

let app: FastifyInstance;
let retention: ReturnType<typeof createRetentionService>;
let scheduledTasks: ReturnType<typeof createScheduledTaskService>;
let artifacts: ArtifactStore;
let pools: PoolRegistry;
let drivers: DriverRegistry;
try {
  drivers = new DriverRegistry();
  if ((appConfig.datasourcePlugins?.length ?? 0) > 0) {
    await drivers.loadExternalPlugins(appConfig.datasourcePlugins ?? [], {
      strict: appConfig.datasourcePluginsStrict,
    });
  }
  await loadPersistedDatasourcePlugins({ db: handle.db, config: appConfig, drivers });

  artifacts = new ArtifactStore(
    handle.db,
    path.join(appConfig.dataDir, "artifacts"),
  );
  await artifacts.init();
  pools = new PoolRegistry(drivers);
  const agentRuntime = new RuntimeManager({
    config: appConfig,
    db: handle.db,
    pools,
    artifacts,
    drivers,
  });
  retention = createRetentionService({
    db: handle.db,
    config: appConfig,
    runtime: agentRuntime,
    artifacts,
  });
  scheduledTasks = createScheduledTaskService({
    db: handle.db,
    config: appConfig,
    pools,
    artifacts,
    runtime: agentRuntime,
  });
  app = await buildApp({
    config: appConfig,
    db: handle.db,
    artifacts,
    pools,
    drivers,
    agentRuntime,
    retention,
    scheduledTasks,
  });
} catch (error) {
  handle.sqlite.close();
  throw error;
}

failInterruptedScheduledRuns(handle.db, Date.now());
const scheduledSweeper = startScheduledTaskSweeper(scheduledTasks, app.log, async () => {
  await sweepDueDashboards({
    db: handle.db,
    config: appConfig,
    pools,
    artifacts,
    drivers,
  });
});

let sweepTimer: NodeJS.Timeout | undefined;
if (appConfig.retentionSweepHours > 0) {
  const intervalMs = appConfig.retentionSweepHours * 3_600_000;
  sweepTimer = setInterval(() => {
    void retention.run(null).catch((error: unknown) => {
      app.log.error({ err: error }, "scheduled retention sweep failed");
    });
  }, intervalMs);
  sweepTimer.unref();
  app.log.info(
    { hours: appConfig.retentionSweepHours },
    "scheduled retention sweep enabled",
  );
}

app.addHook("onClose", () => {
  scheduledSweeper.stop();
  if (sweepTimer) clearInterval(sweepTimer);
  handle.sqlite.close();
});

// A stray rejected promise (for example from a driver adapter) must not take the
// whole server and every in-flight SSE stream down. Log it and keep serving.
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "unhandled promise rejection");
});

let closing = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error, signal }, "graceful shutdown failed");
      process.exitCode = 1;
    });
  });
}

try {
  app.log.info({ applied: appliedMigrations }, "drizzle migrations applied");
  seedSkills(handle.db, config.agentDir);
  const interrupted = reconcileInterruptedRuns(handle.db);
  if (interrupted > 0) {
    app.log.warn({ count: interrupted }, "closed runs interrupted by the previous shutdown");
  }
  await bootstrapAdmin(handle.db, config, app.log);
  app.log.info({ dataDir: config.dataDir, dbPath: config.dbPath }, "resolved storage paths");
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  await app.close().catch((closeError: unknown) => {
    app.log.error({ err: closeError }, "failed to close app after startup error");
  });
  throw error;
}
