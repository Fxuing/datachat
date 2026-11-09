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
import { fetchRemoteModels } from "../src/routes/admin-llm-providers.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let db: Db;
let adminId: string;
let aliceId: string;
let adminCookie: string;
let aliceCookie: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-llm-"));
  db = createDb(":memory:").db;
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
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function config() {
  return {
    ...testConfig,
    dataDir: root,
    // No legacy models.json here: the suite starts from an empty provider list.
    agentDir: path.join(root, "agent-config"),
    agentAuthPath: path.join(root, "agent", "auth.json"),
  };
}

async function withApp<T>(
  fn: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>,
): Promise<T> {
  const app = await buildApp({ config: config(), db, enableRateLimit: false });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const providerBody = {
  name: "测试网关",
  protocol: "openai-completions" as const,
  baseUrl: "https://llm.example.com/v1",
  apiKey: "sk-secret-value",
  models: [{ id: "acme-chat-1", name: "Acme Chat 1" }],
};

describe("LLM provider management", () => {
  it("creates, lists, edits, disables and deletes a provider without leaking keys", async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/llm-providers",
        cookies: { dc_session: adminCookie },
        payload: providerBody,
      });
      expect(created.statusCode).toBe(201);
      const provider = created.json().provider;
      expect(provider).toMatchObject({
        name: "测试网关",
        protocol: "openai-completions",
        enabled: true,
        baseUrl: "https://llm.example.com/v1",
      });
      expect(JSON.stringify(provider)).not.toContain("sk-secret-value");
      expect(provider.maskedKey).toContain("••••");

      const list = await app.inject({
        method: "GET",
        url: "/api/admin/llm-providers",
        cookies: { dc_session: adminCookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().providers).toHaveLength(1);

      const models = await app.inject({
        method: "GET",
        url: "/api/models",
        cookies: { dc_session: adminCookie },
      });
      expect(models.json()).toMatchObject({
        configured: true,
        defaultId: `${provider.id}::acme-chat-1`,
      });

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/admin/llm-providers/${provider.id}`,
        cookies: { dc_session: adminCookie },
        payload: { enabled: false, name: "测试网关 2" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().provider).toMatchObject({ enabled: false, name: "测试网关 2" });

      const disabled = await app.inject({
        method: "GET",
        url: "/api/models",
        cookies: { dc_session: adminCookie },
      });
      expect(disabled.json()).toMatchObject({ configured: false, models: [] });

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/admin/llm-providers/${provider.id}`,
        cookies: { dc_session: adminCookie },
      });
      expect(removed.statusCode).toBe(204);
    });
  });

  it("keeps the stored key when apiKey is omitted and clears a default on delete", async () => {
    await withApp(async (app) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/llm-providers",
        cookies: { dc_session: adminCookie },
        payload: providerBody,
      });
      const provider = created.json().provider;

      const saved = await app.inject({
        method: "PUT",
        url: "/api/admin/settings",
        cookies: { dc_session: adminCookie },
        payload: { defaultModelId: `${provider.id}::acme-chat-1` },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().settings.defaultModelId).toBe(`${provider.id}::acme-chat-1`);

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/admin/llm-providers/${provider.id}`,
        cookies: { dc_session: adminCookie },
        payload: { models: [{ id: "acme-chat-2", name: "Acme Chat 2" }] },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().provider.models.map((model: { id: string }) => model.id)).toEqual([
        "acme-chat-2",
      ]);

      await app.inject({
        method: "DELETE",
        url: `/api/admin/llm-providers/${provider.id}`,
        cookies: { dc_session: adminCookie },
      });
      const settings = await app.inject({
        method: "GET",
        url: "/api/admin/settings",
        cookies: { dc_session: adminCookie },
      });
      expect(settings.json().settings.defaultModelId).toBeNull();
    });
  });

  it("requires an admin and rejects duplicate names", async () => {
    await withApp(async (app) => {
      const denied = await app.inject({
        method: "POST",
        url: "/api/admin/llm-providers",
        cookies: { dc_session: aliceCookie },
        payload: providerBody,
      });
      expect(denied.statusCode).toBe(403);

      const first = await app.inject({
        method: "POST",
        url: "/api/admin/llm-providers",
        cookies: { dc_session: adminCookie },
        payload: providerBody,
      });
      expect(first.statusCode).toBe(201);
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/admin/llm-providers",
        cookies: { dc_session: adminCookie },
        payload: providerBody,
      });
      expect(duplicate.statusCode).toBe(409);
    });
  });
});

describe("fetchRemoteModels", () => {
  it("reads OpenAI-compatible /models with a bearer token", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const models = await fetchRemoteModels({
      protocol: "openai-completions",
      baseUrl: "https://llm.example.com/v1/",
      apiKey: "sk-test",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(input);
        seenAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m1" }, { id: "m2" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(seenUrl).toBe("https://llm.example.com/v1/models");
    expect(seenAuth).toBe("Bearer sk-test");
    expect(models.map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(models[0]).toMatchObject({ name: "m1", contextWindow: 128_000, maxTokens: 8_192 });
  });

  it("uses Anthropic headers and surfaces upstream errors", async () => {
    let seenKey = "";
    let seenVersion = "";
    await expect(
      fetchRemoteModels({
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant",
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          seenKey = headers.get("x-api-key") ?? "";
          seenVersion = headers.get("anthropic-version") ?? "";
          return new Response("unauthorized", { status: 401 });
        }) as typeof fetch,
      }),
    ).rejects.toThrow("上游返回 401");
    expect(seenKey).toBe("sk-ant");
    expect(seenVersion).toBe("2023-06-01");
  });
});
