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
import { insertUser } from "../src/db/repositories/users.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let db: Db;
let cookie: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-models-route-"));
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  const userId = randomUUID();
  insertUser(db, {
    id: userId,
    username: "alice",
    passwordHash: await hashPassword("alice-pass-123"),
    role: "user",
    createdAt: Date.now(),
  });
  cookie = await createSessionSigner(testConfig.appSecret).sign({
    sub: userId,
    username: "alice",
    role: "user",
  });
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

async function getModels(appConfig: ReturnType<typeof config>, withCookie = true) {
  const app = await buildApp({ config: appConfig, db, enableRateLimit: false });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/models",
      cookies: withCookie ? { dc_session: cookie } : {},
    });
    return { statusCode: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
}

describe("GET /api/models", () => {
  it("returns the whitelist and default id when the key is configured", async () => {
    const { statusCode, body } = await getModels(config({ siliconflowApiKey: "sk-test" }));

    expect(statusCode).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.defaultId).toBe("deepseek-ai/DeepSeek-V3.2");
    expect(body.models).toHaveLength(4);
    expect(body.models.map((model: { id: string }) => model.id)).toEqual([
      "deepseek-ai/DeepSeek-V3.2",
      "zai-org/GLM-5.3",
      "Qwen/Qwen3.8-27B",
      "moonshotai/Kimi-K2.7-Code",
    ]);
    expect(body.models[0]).not.toHaveProperty("cost");
  });

  it("reports configured=false without a key and never builds the runtime", async () => {
    const appConfig = config();
    const { statusCode, body } = await getModels(appConfig);

    expect(statusCode).toBe(200);
    expect(body).toEqual({ configured: false, models: [], defaultId: null });
    // The runtime lazily creates dataDir/agent; an unconfigured server must not touch it.
    expect(fs.existsSync(appConfig.agentAuthPath)).toBe(false);
  });

  it("requires authentication", async () => {
    const { statusCode } = await getModels(config({ siliconflowApiKey: "sk-test" }), false);
    expect(statusCode).toBe(401);
  });
});
