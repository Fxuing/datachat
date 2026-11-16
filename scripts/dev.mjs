import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let stopping = false;

function envValue(name, fallback) {
  try {
    const text = readFileSync(path.join(root, ".env"), "utf8");
    const line = text.split(/\r?\n/).find((item) => item.trim().startsWith(`${name}=`));
    return line ? line.slice(line.indexOf("=") + 1).trim() : fallback;
  } catch {
    return fallback;
  }
}

function start(label, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`[dev] ${label} exited (${code ?? "signal"})`);
    stop();
    process.exitCode = code ?? 1;
  });
  children.push({ label, child });
  return child;
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (!child.pid) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
}

function waitForHealth(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: 800 },
        (response) => {
          response.resume();
          if (response.statusCode === 200) return resolve(true);
          retry();
        },
      );
      request.on("error", retry);
      request.on("timeout", () => {
        request.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });

console.log("[dev] building shared package…");
const build = spawnSync("pnpm", ["--filter", "@datachat/shared", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);

start("shared", "pnpm", ["--filter", "@datachat/shared", "dev"], root);
start(
  "server",
  "pnpm",
  ["exec", "tsx", "watch", "--env-file-if-exists=../../.env", "src/index.ts"],
  path.join(root, "apps/server"),
);

const port = Number(envValue("PORT", "8080"));
const ready = await waitForHealth(port, 60_000);
if (ready) {
  console.log(`[dev] server ready on http://127.0.0.1:${port}`);
} else {
  console.error(`[dev] server did not become healthy on port ${port}; starting web anyway`);
}

start("web", "pnpm", ["--filter", "@datachat/web", "dev"], root);
