import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { queryAudit } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { testConfig } from "./helpers/config.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const SECRET = "sup3r-secret-env-value";

let db: Db;
let adminCookie: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  const adminId = randomUUID();
  insertUser(db, {
    id: adminId,
    username: "root",
    passwordHash: await hashPassword("admin-pass"),
    role: "admin",
    createdAt: Date.now(),
  });
  adminCookie = await createSessionSigner(testConfig.appSecret).sign({
    sub: adminId,
    username: "root",
    role: "admin",
  });
});

function app(mcpTestTimeoutMs?: number) {
  return buildApp({ config: testConfig, db, enableRateLimit: false, mcpTestTimeoutMs });
}

async function createServer(
  a: Awaited<ReturnType<typeof app>>,
  payload: Record<string, unknown>,
): Promise<string> {
  const response = await a.inject({
    method: "POST",
    url: "/api/admin/mcp-servers",
    cookies: { dc_session: adminCookie },
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json().server.id as string;
}

describe("mcp connection test", () => {
  it("lists tools from a local stdio server built with the official SDK", async () => {
    const a = await app();
    const id = await createServer(a, {
      name: "fake",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
    });

    const result = await a.inject({
      method: "POST",
      url: `/api/admin/mcp-servers/${id}/test`,
      cookies: { dc_session: adminCookie },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      ok: true,
      tools: [
        { name: "echo", description: "Echo the given text" },
        { name: "add", description: "Add two numbers" },
        { name: "now", description: "" },
      ],
      serverInfo: { name: "fake-mcp", version: "0.1.0" },
    });

    const audit = db.select().from(queryAudit).all().at(-1)!;
    expect(audit.action).toBe("mcp_change");
    expect(audit.status).toBe("ok");
  });

  it("times out when the server never answers tools/list", async () => {
    const a = await app(400);
    const id = await createServer(a, {
      name: "hanging",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE, "hang"],
    });

    const startedAt = Date.now();
    const result = await a.inject({
      method: "POST",
      url: `/api/admin/mcp-servers/${id}/test`,
      cookies: { dc_session: adminCookie },
    });
    const elapsed = Date.now() - startedAt;

    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.ok).toBe(false);
    expect(body.tools).toEqual([]);
    expect(body.error).toContain("连接超时");
    expect(elapsed).toBeLessThan(10_000);

    const audit = db.select().from(queryAudit).all().at(-1)!;
    expect(audit.status).toBe("error");
    expect(audit.detailJson).not.toContain(SECRET);
    expect(audit.detailJson).not.toContain("sup3r");
  });

  it("sanitizes secrets out of transport errors", async () => {
    const a = await app();
    const id = await createServer(a, {
      name: "leaky",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE, "leak"],
      env: { FAKE_MCP_SECRET: SECRET },
    });

    const result = await a.inject({
      method: "POST",
      url: `/api/admin/mcp-servers/${id}/test`,
      cookies: { dc_session: adminCookie },
    });

    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("***");
    expect(result.body).not.toContain(SECRET);
  });

  it("returns a sanitized failure for a missing executable", async () => {
    const a = await app();
    const id = await createServer(a, {
      name: "broken",
      transport: "stdio",
      command: "definitely-not-a-real-binary-xyz",
    });

    const result = await a.inject({
      method: "POST",
      url: `/api/admin/mcp-servers/${id}/test`,
      cookies: { dc_session: adminCookie },
    });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("404s for an unknown server id", async () => {
    const a = await app();
    const result = await a.inject({
      method: "POST",
      url: `/api/admin/mcp-servers/${randomUUID()}/test`,
      cookies: { dc_session: adminCookie },
    });
    expect(result.statusCode).toBe(404);
  });

  it("requires an admin", async () => {
    const a = await app();
    const result = await a.inject({
      method: "POST",
      url: `/api/admin/mcp-servers/${randomUUID()}/test`,
    });
    expect(result.statusCode).toBe(401);
  });
});
