#!/usr/bin/env node
/**
 * Manual server smoke test: boot the built server on an ephemeral port and
 * check `/api/health` plus `/api/models`. Requires `pnpm -r build` first.
 *
 * Run with `node scripts/smoke-server.mjs`. Never prints the API key.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadEnv, readModelWhitelist, repoRoot } from "./load-env.mjs";

loadEnv();

const entry = path.join(repoRoot, "apps", "server", "dist", "index.js");
const adminUsername = process.env.ADMIN_USERNAME?.trim() || "admin";
const apiKey = process.env.SILICONFLOW_API_KEY?.trim();
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`✗ ${message}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, stderr) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`服务进程提前退出（code ${child.exitCode}）：${stderr().slice(-500)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待 /api/health 超时：${stderr().slice(-500)}`);
}

async function main() {
  if (!fs.existsSync(entry)) {
    console.error(`未找到构建产物 ${path.relative(repoRoot, entry)}，请先运行 pnpm -r build。`);
    return 1;
  }

  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-smoke-server-"));
  const adminPassword =
    process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 8
      ? process.env.ADMIN_PASSWORD
      : `smoke-admin-${crypto.randomBytes(6).toString("hex")}`;
  const appSecret =
    process.env.APP_SECRET && process.env.APP_SECRET.length >= 32
      ? process.env.APP_SECRET
      : crypto.randomBytes(32).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;

  let stderrText = "";
  // `@datachat/shared` ships TS sources (see Plan 4 packaging note), so the
  // built server still needs the tsx loader to resolve its workspace imports.
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      APP_SECRET: appSecret,
      DATA_DIR: dataDir,
      LOG_LEVEL: "warn",
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD: adminPassword,
      APP_ORIGIN: baseUrl,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
  });

  try {
    const health = await waitForHealth(baseUrl, child, () => stderrText);
    if (health.ok !== true || health.db !== "ok") {
      fail(`/api/health 返回 ${JSON.stringify(health)}`);
    } else {
      console.log(`✓ /api/health ok（db=${health.db}, version=${health.version}）`);
    }

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!login.ok) {
      fail(`/api/auth/login 返回 HTTP ${login.status}`);
      return 1;
    }
    const cookie = (login.headers.getSetCookie?.() ?? [])
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith("dc_session="));
    if (!cookie) {
      fail("/api/auth/login 未返回 dc_session cookie");
      return 1;
    }
    console.log("✓ 管理员登录成功（bootstrap 管理员已创建）");

    const response = await fetch(`${baseUrl}/api/models`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      fail(`/api/models 返回 HTTP ${response.status}`);
      return 1;
    }
    const catalog = await response.json();

    if (!apiKey) {
      if (catalog.configured !== false || (catalog.models ?? []).length !== 0) {
        fail(`未配置密钥时 /api/models 应返回 configured:false 和空列表，实际 ${JSON.stringify(catalog)}`);
      } else {
        console.log("✓ /api/models configured=false（未设置 SILICONFLOW_API_KEY，跳过白名单断言）");
      }
    } else {
      const whitelist = readModelWhitelist();
      // /api/models exposes composite `provider::model` ids; the whitelist is per provider.
      const ids = (catalog.models ?? []).map((model) => model.modelId ?? model.id);
      if (catalog.configured !== true) fail("/api/models 未返回 configured:true");
      if (JSON.stringify(ids) !== JSON.stringify(whitelist)) {
        fail(`模型列表与 agent/models.json 不一致：${JSON.stringify(ids)}`);
      }
      if (!catalog.defaultId) fail("/api/models 缺少 defaultId");
      if (failures.length === 0) {
        console.log(`✓ /api/models configured=true，${ids.length} 个模型：${ids.join(", ")}`);
      }
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`服务冒烟失败（${failures.length} 项）。`);
    return 1;
  }
  console.log("服务冒烟通过。");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`服务冒烟异常：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
