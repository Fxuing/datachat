import fs from "node:fs";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { migrateDb } from "./db/migrate.js";
import { bootstrapAdmin } from "./auth/bootstrap.js";

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const { db } = createDb(config.dbPath);
migrateDb(db);
await bootstrapAdmin(db, config);
const app = await buildApp({ config });
app.log.info({ dataDir: config.dataDir, dbPath: config.dbPath }, "resolved storage paths");
await app.listen({ port: config.port, host: "0.0.0.0" });
