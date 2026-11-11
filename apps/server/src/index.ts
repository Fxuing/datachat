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

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });

const handle = createDb(config.dbPath);
const { adminPassword: _adminPassword, ...appConfig } = config;

// Migrations must run before buildApp: startup wiring (LLM provider seeding,
// settings defaults) reads tables that a fresh database does not have yet.
const appliedMigrations = migrateDb(handle.db);

let app: FastifyInstance;
let retention: ReturnType<typeof createRetentionService>;
try {
  const artifacts = new ArtifactStore(
    handle.db,
    path.join(appConfig.dataDir, "artifacts"),
  );
  await artifacts.init();
  const pools = new PoolRegistry();
  const agentRuntime = new RuntimeManager({
    config: appConfig,
    db: handle.db,
    pools,
    artifacts,
  });
  retention = createRetentionService({
    db: handle.db,
    config: appConfig,
    runtime: agentRuntime,
    artifacts,
  });
  app = await buildApp({
    config: appConfig,
    db: handle.db,
    artifacts,
    pools,
    agentRuntime,
    retention,
  });
} catch (error) {
  handle.sqlite.close();
  throw error;
}

let sweepTimer: NodeJS.Timeout | undefined;
if (appConfig.retentionSweepHours > 0) {
  const intervalMs = appConfig.retentionSweepHours * 3_600_000;
  sweepTimer = setInterval(() => {
    void retention.run(null).catch((error: unknown) => {
      app.log.error({ err: error }, "scheduled retention sweep failed");
    });
  }, intervalMs);
  app.log.info(
    { hours: appConfig.retentionSweepHours },
    "scheduled retention sweep enabled",
  );
}

app.addHook("onClose", () => {
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
