import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { createDb, type Db, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { datasources } from "../src/db/schema.js";
import { insertUser } from "../src/db/repositories/users.js";
import { testConfig } from "./helpers/config.js";

let handle: DbHandle;
let db: Db;
let aliceCookie: string;
let bobCookie: string;

beforeEach(async () => {
  handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  db.insert(datasources).values({
    id: "ds-memory", name: "示例商城", type: "mysql", host: "localhost", port: 3306,
    database: "demo", username: "reader", passwordCipher: "cipher", createdBy: "seed",
    createdAt: 1, updatedAt: 1,
  }).run();
  const now = Date.now();
  insertUser(db, { id: "alice", username: "alice", passwordHash: await hashPassword("alice-pass"), role: "user", createdAt: now });
  insertUser(db, { id: "bob", username: "bob", passwordHash: await hashPassword("bob-pass"), role: "user", createdAt: now });
  const signer = createSessionSigner(testConfig.appSecret);
  aliceCookie = await signer.sign({ sub: "alice", username: "alice", role: "user" });
  bobCookie = await signer.sign({ sub: "bob", username: "bob", role: "user" });
});

afterEach(() => handle.sqlite.close());

async function app() {
  return buildApp({ config: testConfig, db, enableRateLimit: false });
}

function cookies(cookie: string) {
  return { dc_session: cookie };
}

describe("memory routes", () => {
  it("creates, lists, merges, updates and deletes own memories", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST", url: "/api/memories", cookies: cookies(aliceCookie),
      payload: { kind: "preference", title: "金额单位", content: "金额按万元展示" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().memory.id as string;

    const merged = await a.inject({
      method: "POST", url: "/api/memories", cookies: cookies(aliceCookie),
      payload: { kind: "preference", title: "金额 单位", content: "金额一律按万元展示" },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().merged).toBe(true);
    expect(merged.json().memory.id).toBe(id);

    const listed = await a.inject({
      method: "GET", url: "/api/memories?q=万元", cookies: cookies(aliceCookie),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().memories).toHaveLength(1);
    expect(listed.json().settings.enabled).toBe(true);

    const patched = await a.inject({
      method: "PATCH", url: `/api/memories/${id}`, cookies: cookies(aliceCookie),
      payload: { enabled: false, content: "金额一律按万元展示（含税）" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().memory.enabled).toBe(false);

    const removed = await a.inject({
      method: "DELETE", url: `/api/memories/${id}`, cookies: cookies(aliceCookie),
    });
    expect(removed.statusCode).toBe(204);
    expect((await a.inject({ method: "GET", url: "/api/memories", cookies: cookies(aliceCookie) })).json().memories).toEqual([]);
  });

  it("isolates memories by owner", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST", url: "/api/memories", cookies: cookies(aliceCookie),
      payload: { kind: "fact", title: "私有", content: "只属于 alice" },
    });
    const id = created.json().memory.id as string;

    const bobList = await a.inject({ method: "GET", url: "/api/memories", cookies: cookies(bobCookie) });
    expect(bobList.json().memories).toEqual([]);
    const bobPatch = await a.inject({
      method: "PATCH", url: `/api/memories/${id}`, cookies: cookies(bobCookie), payload: { enabled: false },
    });
    expect(bobPatch.statusCode).toBe(404);
    const bobDelete = await a.inject({ method: "DELETE", url: `/api/memories/${id}`, cookies: cookies(bobCookie) });
    expect(bobDelete.statusCode).toBe(404);
  });

  it("rejects secrets and datasource memories without access", async () => {
    const a = await app();
    const secret = await a.inject({
      method: "POST", url: "/api/memories", cookies: cookies(aliceCookie),
      payload: { kind: "fact", title: "密钥", content: "api_key=abcdefgh" },
    });
    expect(secret.statusCode).toBe(400);
    expect(secret.json().error.code).toBe("MEMORY_SECRET_DETECTED");

    const forbidden = await a.inject({
      method: "POST", url: "/api/memories", cookies: cookies(aliceCookie),
      payload: { kind: "fact", title: "订单口径", content: "只统计已支付", scope: "datasource", datasourceId: "ds-memory" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("DATASOURCE_FORBIDDEN");
  });

  it("persists the per-user enabled switch and clears all memories", async () => {
    const a = await app();
    await a.inject({
      method: "POST", url: "/api/memories", cookies: cookies(aliceCookie),
      payload: { kind: "profile", title: "角色", content: "电商运营" },
    });
    const off = await a.inject({
      method: "PATCH", url: "/api/memories/settings", cookies: cookies(aliceCookie), payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/api/memories/settings", cookies: cookies(aliceCookie) })).json().enabled).toBe(false);

    const cleared = await a.inject({ method: "POST", url: "/api/memories/clear", cookies: cookies(aliceCookie) });
    expect(cleared.json().cleared).toBe(1);
    expect((await a.inject({ method: "GET", url: "/api/memories", cookies: cookies(aliceCookie) })).json().memories).toEqual([]);
  });

  it("allows core on preferences and rejects core on facts", async () => {
    const a = await app();
    const pref = await a.inject({
      method: "POST",
      url: "/api/memories",
      cookies: cookies(aliceCookie),
      payload: { kind: "preference", title: "金额单位", content: "按万元展示" },
    });
    expect(pref.statusCode).toBe(201);
    const prefId = pref.json().memory.id as string;

    const promoted = await a.inject({
      method: "PATCH",
      url: `/api/memories/${prefId}`,
      cookies: cookies(aliceCookie),
      payload: { core: true },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().memory.core).toBe(true);

    const invalidCreate = await a.inject({
      method: "POST",
      url: "/api/memories",
      cookies: cookies(aliceCookie),
      payload: { kind: "fact", title: "事实", content: "有效订单", core: true },
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json().error.code).toBe("INVALID_MEMORY");

    const fact = await a.inject({
      method: "POST",
      url: "/api/memories",
      cookies: cookies(aliceCookie),
      payload: { kind: "fact", title: "事实", content: "有效订单" },
    });
    expect(fact.statusCode).toBe(201);
    const invalidPatch = await a.inject({
      method: "PATCH",
      url: `/api/memories/${fact.json().memory.id as string}`,
      cookies: cookies(aliceCookie),
      payload: { core: true },
    });
    expect(invalidPatch.statusCode).toBe(400);
    expect(invalidPatch.json().error.code).toBe("INVALID_MEMORY");
  });
});
