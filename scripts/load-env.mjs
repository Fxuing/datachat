import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Minimal `.env` loader for the manual smoke scripts. No dependency, never
 * overrides values already present in the environment, never logs values.
 */
export function loadEnv(file = path.join(repoRoot, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** The model whitelist lives in `agent/models.json`; both scripts read it from there. */
export function readModelWhitelist() {
  const file = path.join(repoRoot, "agent", "models.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.providers.siliconflow.models.map((model) => model.id);
}
