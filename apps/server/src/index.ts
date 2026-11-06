import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = await buildApp({ config });
app.log.info({ dataDir: config.dataDir, dbPath: config.dbPath }, "resolved storage paths");
await app.listen({ port: config.port, host: "0.0.0.0" });
