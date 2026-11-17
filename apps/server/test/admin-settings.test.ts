import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { settings } from "../src/db/schema.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { insertUser } from "../src/db/repositories/users.js";
import { testConfig } from "./helpers/config.js";

const DAY_MS = 86_400_000;

let root: string;
let db: Db;
let adminId: string;
let aliceId: string;
let datasourceId: string;
let adminCookie: string;
let aliceCookie: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-settings-"));
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  adminId = randomUUID();
  aliceId = randomUUID();
  insertUser(db, {
    id: adminId,
    username: "root",
    passwordHash: await hashPassword("admin-pass-123"),
    role: "admin",
    createdAt: Date.now(),
  });
  insertUser(db, {
    id: aliceId,
    username: "alice",
    passwordHash: await hashPassword("alice-pass-123"),
    role: "user",
    createdAt: Date.now(),
  });
  const signer = createSessionSigner(testConfig.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  aliceCookie = await signer.sign({ sub: aliceId, username: "alice", role: "user" });

  datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "demo",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "demo",
    username: "demo",
    passwordCipher: "cipher",
    createdBy: aliceId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  replaceGrants(db, datasourceId, [aliceId]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function config(overrides: Partial<typeof testConfig> = {}) {
  return {
    ...testConfig,
    dataDir: root,
    agentAuthPath: path.join(root, "agent", "auth.json"),
    ...overrides,
  };
}

async function withApp<T>(
  fn: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>,
  appConfig: ReturnType<typeof config> = config(),
): Promise<T> {
  const app = await buildApp({ config: appConfig, db, enableRateLimit: false });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function getSettings(
  appConfig: ReturnType<typeof config> = config(),
  cookie = adminCookie,
) {
  return withApp(async (app) => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/settings",
      cookies: cookie ? { dc_session: cookie } : {},
    });
    return { statusCode: response.statusCode, body: response.json() };
  }, appConfig);
}

async function putSettings(
  payload: unknown,
  appConfig: ReturnType<typeof config> = config(),
  cookie = adminCookie,
) {
  return withApp(async (app) => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: cookie ? { dc_session: cookie } : {},
      payload: payload as Record<string, unknown>,
    });
    return { statusCode: response.statusCode, body: response.json() };
  }, appConfig);
}

describe("admin settings", () => {
  it("is admin-only", async () => {
    const deniedGet = await getSettings(config(), aliceCookie);
    expect(deniedGet.statusCode).toBe(403);
    const deniedPut = await putSettings({ queryMaxRows: 10 }, config(), aliceCookie);
    expect(deniedPut.statusCode).toBe(403);
    const anonymous = await getSettings(config(), "");
    expect(anonymous.statusCode).toBe(401);
  });

  it("returns config defaults before anything is saved", async () => {
    const { statusCode, body } = await getSettings();
    expect(statusCode).toBe(200);
    expect(body.settings).toEqual({
      defaultModelId: null,
      queryMaxRows: testConfig.queryMaxRows,
      queryPreviewRows: testConfig.queryPreviewRows,
      queryTimeoutMs: testConfig.queryTimeoutMs,
      shareMaxDays: 365,
      retentionConversationDays: 0,
      memoryEnabled: true,
      retentionAuditDays: 0,
    });
  });

  it("persists overrides across app instances", async () => {
    const saved = await putSettings({
      queryMaxRows: 50_000,
      queryPreviewRows: 50,
      queryTimeoutMs: 60_000,
      shareMaxDays: 30,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings).toMatchObject({
      queryMaxRows: 50_000,
      queryPreviewRows: 50,
      queryTimeoutMs: 60_000,
      shareMaxDays: 30,
    });

    const reread = await getSettings();
    expect(reread.body.settings).toMatchObject({
      queryMaxRows: 50_000,
      queryPreviewRows: 50,
      queryTimeoutMs: 60_000,
      shareMaxDays: 30,
    });

    const rows = db.select().from(settings).all();
    expect(rows.map((row) => row.key).sort()).toEqual([
      "queryMaxRows",
      "queryPreviewRows",
      "queryTimeoutMs",
      "shareMaxDays",
    ]);
    expect(JSON.parse(rows.find((row) => row.key === "queryMaxRows")!.valueJson)).toBe(50_000);
  });

  it("accepts the boundary values and rejects out-of-range ones", async () => {
    const ok = await putSettings({
      queryMaxRows: 100_000,
      queryPreviewRows: 1_000,
      queryTimeoutMs: 300_000,
      shareMaxDays: 365,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.settings).toMatchObject({
      queryMaxRows: 100_000,
      queryPreviewRows: 1_000,
      queryTimeoutMs: 300_000,
      shareMaxDays: 365,
    });

    const low = await putSettings({
      queryMaxRows: 1,
      queryPreviewRows: 1,
      queryTimeoutMs: 1_000,
      shareMaxDays: 1,
    });
    expect(low.statusCode).toBe(200);
    expect(low.body.settings).toMatchObject({
      queryMaxRows: 1,
      queryPreviewRows: 1,
      queryTimeoutMs: 1_000,
      shareMaxDays: 1,
    });

    for (const payload of [
      { queryMaxRows: 0 },
      { queryMaxRows: 100_001 },
      { queryMaxRows: 1.5 },
      { queryPreviewRows: 0 },
      { queryPreviewRows: 1_001 },
      { queryTimeoutMs: 999 },
      { queryTimeoutMs: 300_001 },
      { shareMaxDays: 0 },
      { shareMaxDays: 366 },
      { unknownKey: 1 },
      {},
    ]) {
      const rejected = await putSettings(payload);
      expect(rejected.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("applies the default model to /api/models and new conversations", async () => {
    const appConfig = config({ siliconflowApiKey: "sk-test" });

    const saved = await putSettings({ defaultModelId: "zai-org/GLM-5.3" }, appConfig);
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings.defaultModelId).toBe("siliconflow::zai-org/GLM-5.3");

    const models = await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/models",
        cookies: { dc_session: aliceCookie },
      });
      return { statusCode: response.statusCode, body: response.json() };
    }, appConfig);
    expect(models.statusCode).toBe(200);
    expect(models.body.defaultId).toBe("siliconflow::zai-org/GLM-5.3");

    const created = await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/conversations",
        cookies: { dc_session: aliceCookie },
        payload: { datasourceId },
      });
      return { statusCode: response.statusCode, body: response.json() };
    }, appConfig);
    expect(created.statusCode).toBe(201);
    expect(created.body.conversation.modelId).toBe("siliconflow::zai-org/GLM-5.3");

    const explicit = await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/conversations",
        cookies: { dc_session: aliceCookie },
        payload: { datasourceId, modelId: "Qwen/Qwen3.8-27B" },
      });
      return { statusCode: response.statusCode, body: response.json() };
    }, appConfig);
    expect(explicit.statusCode).toBe(201);
    expect(explicit.body.conversation.modelId).toBe("siliconflow::Qwen/Qwen3.8-27B");

    const invalid = await putSettings({ defaultModelId: "not-a-model" }, appConfig);
    expect(invalid.statusCode).toBe(400);

    const cleared = await putSettings({ defaultModelId: null }, appConfig);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.settings.defaultModelId).toBeNull();

    const fallback = await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/models",
        cookies: { dc_session: aliceCookie },
      });
      return response.json() as { defaultId: string | null };
    }, appConfig);
    expect(fallback.defaultId).toBe("siliconflow::deepseek-ai/DeepSeek-V3.2");
  });

  it("rejects defaultModelId when the model runtime is not configured", async () => {
    const rejected = await putSettings({ defaultModelId: "zai-org/GLM-5.3" });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.error.code).toBe("VALIDATION");
  });

  it("leaves new conversations unpinned when no default is configured", async () => {
    const created = await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/conversations",
        cookies: { dc_session: aliceCookie },
        payload: { datasourceId },
      });
      return { statusCode: response.statusCode, body: response.json() };
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.conversation.modelId).toBeNull();
  });

  it("caps share expiry at shareMaxDays", async () => {
    const appConfig = config();
    const saved = await putSettings({ shareMaxDays: 2 }, appConfig);
    expect(saved.statusCode).toBe(200);

    const conversation = createConversation(db, {
      userId: aliceId,
      datasourceId,
      title: "share me",
    });

    const tooLong = await withApp(
      async (app) =>
        app.inject({
          method: "POST",
          url: "/api/shares",
          cookies: { dc_session: aliceCookie },
          payload: { conversationId: conversation.id, expiresInDays: 7 },
        }),
      appConfig,
    );
    expect(tooLong.statusCode).toBe(400);

    const boundary = await withApp(
      async (app) =>
        app.inject({
          method: "POST",
          url: "/api/shares",
          cookies: { dc_session: aliceCookie },
          payload: { conversationId: conversation.id, expiresInDays: 2 },
        }),
      appConfig,
    );
    expect(boundary.statusCode).toBe(201);
    const boundaryExpiry = boundary.json().share.expiresAt as number;
    expect(Math.abs(boundaryExpiry - (Date.now() + 2 * DAY_MS))).toBeLessThan(60_000);

    const defaulted = await withApp(
      async (app) =>
        app.inject({
          method: "POST",
          url: "/api/shares",
          cookies: { dc_session: aliceCookie },
          payload: { conversationId: conversation.id },
        }),
      appConfig,
    );
    expect(defaulted.statusCode).toBe(201);
    const defaultExpiry = defaulted.json().share.expiresAt as number;
    expect(Math.abs(defaultExpiry - (Date.now() + 2 * DAY_MS))).toBeLessThan(60_000);
  });
});
