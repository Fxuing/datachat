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

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });

const handle = createDb(config.dbPath);
const { adminPassword: _adminPassword, ...appConfig } = config;

let app: FastifyInstance;
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
  app = await buildApp({
    config: appConfig,
    db: handle.db,
    artifacts,
    pools,
    agentRuntime,
  });
} catch (error) {
  handle.sqlite.close();
  throw error;
}

app.addHook("onClose", () => {
  handle.sqlite.close();
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
  migrateDb(handle.db, { logger: app.log });
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
