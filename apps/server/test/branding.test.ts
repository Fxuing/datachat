import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function makeApp(envOverrides: Record<string, string | undefined> = {}): Promise<{
  app: FastifyInstance;
  dir: string;
  db: Db;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "datachat-branding-"));
  const config = loadConfig({
    APP_SECRET: "branding-test-secret-with-at-least-32-chars",
    DATA_DIR: dir,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ...envOverrides,
  });
  const { db, sqlite } = createDb(config.dbPath);
  migrateDb(db);
  const app = await buildApp({ config, db, enableRateLimit: false });
  cleanups.push(async () => {
    await app.close();
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, dir, db };
}

describe("public branding routes", () => {
  it("returns default DataChat branding when env vars are unset", async () => {
    const { app } = await makeApp();

    const res = await app.inject({ method: "GET", url: "/api/public/branding" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      title: "DataChat",
      subtitle: "数据工作台",
      iconUrl: "/logo.svg",
      faviconUrl: "/favicon.svg",
    });

    const iconRes = await app.inject({ method: "GET", url: "/api/public/branding/icon" });
    expect(iconRes.statusCode).toBe(404);
  });

  it("supports custom title, subtitle, https icon URL (reused as favicon), and web paths", async () => {
    const { app } = await makeApp({
      APP_TITLE: "星云问数",
      APP_SUBTITLE: "企业级智能分析",
      APP_ICON: "https://cdn.example.com/brand/logo.png",
    });

    const res = await app.inject({ method: "GET", url: "/api/public/branding" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      title: "星云问数",
      subtitle: "企业级智能分析",
      iconUrl: "https://cdn.example.com/brand/logo.png",
      faviconUrl: "https://cdn.example.com/brand/logo.png",
    });

    const { app: app2 } = await makeApp({
      APP_ICON: "/custom/logo.webp",
      APP_FAVICON: "/custom/fav.ico",
    });
    const res2 = await app2.inject({ method: "GET", url: "/api/public/branding" });
    expect(res2.json()).toEqual({
      title: "DataChat",
      subtitle: "数据工作台",
      iconUrl: "/custom/logo.webp",
      faviconUrl: "/custom/fav.ico",
    });
  });

  it("serves local mounted icon and favicon files safely without leaking host paths", async () => {
    const assetDir = mkdtempSync(path.join(tmpdir(), "datachat-brand-files-"));
    cleanups.push(() => rmSync(assetDir, { recursive: true, force: true }));

    const svgPath = path.join(assetDir, "corp-logo.svg");
    const pngPath = path.join(assetDir, "corp-fav.png");
    writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const { app } = await makeApp({
      APP_TITLE: "Acme BI",
      APP_ICON: svgPath,
      APP_FAVICON: pngPath,
    });

    const metaRes = await app.inject({ method: "GET", url: "/api/public/branding" });
    expect(metaRes.statusCode).toBe(200);
    const meta = metaRes.json() as {
      title: string;
      subtitle: string;
      iconUrl: string;
      faviconUrl: string;
    };
    expect(meta.title).toBe("Acme BI");
    expect(meta.iconUrl).toMatch(/^\/api\/public\/branding\/icon\?v=/);
    expect(meta.faviconUrl).toMatch(/^\/api\/public\/branding\/favicon\?v=/);
    // Must never leak host filesystem paths
    expect(JSON.stringify(meta)).not.toContain(assetDir);
    expect(JSON.stringify(meta)).not.toContain("corp-logo.svg");

    const iconRes = await app.inject({ method: "GET", url: meta.iconUrl });
    expect(iconRes.statusCode).toBe(200);
    expect(iconRes.headers["content-type"]).toContain("image/svg+xml");
    expect(iconRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(iconRes.headers["content-security-policy"]).toContain("sandbox");
    expect(iconRes.body).toContain("<svg");

    const favRes = await app.inject({ method: "GET", url: meta.faviconUrl });
    expect(favRes.statusCode).toBe(200);
    expect(favRes.headers["content-type"]).toBe("image/png");
    expect(favRes.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects non-image local files and unsafe URLs by falling back to defaults", async () => {
    const assetDir = mkdtempSync(path.join(tmpdir(), "datachat-brand-bad-"));
    cleanups.push(() => rmSync(assetDir, { recursive: true, force: true }));
    const secretFile = path.join(assetDir, "secrets.txt");
    writeFileSync(secretFile, "TOP_SECRET=123");

    const { app } = await makeApp({
      APP_ICON: secretFile,
      APP_FAVICON: "javascript:alert(1)",
    });

    const metaRes = await app.inject({ method: "GET", url: "/api/public/branding" });
    expect(metaRes.statusCode).toBe(200);
    expect(metaRes.json()).toEqual({
      title: "DataChat",
      subtitle: "数据工作台",
      iconUrl: "/logo.svg",
      faviconUrl: "/favicon.svg",
    });

    const iconRes = await app.inject({ method: "GET", url: "/api/public/branding/icon" });
    expect(iconRes.statusCode).toBe(404);
  });
});
