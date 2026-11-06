import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(scriptsDir, "../drizzle");
const target = path.resolve(scriptsDir, "../dist/drizzle");

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copied migrations to ${target}`);
