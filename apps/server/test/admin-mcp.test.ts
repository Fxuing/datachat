import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { mcpServers, queryAudit } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { loadMcpFor } from "../src/agent/mcp.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;
const SECRET = "s3cr3t-token-value";

let db: Db;
let adminId: string;
let adminCookie: string;
let userCookie: string;
let datasourceId: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  adminId = randomUUID();
  const userId = randomUUID();
  insertUser(db, {
    id: adminId,
    username: "root",
    passwordHash: await hashPassword("admin-pass"),
    role: "admin",
    createdAt: Date.now(),
  });
  insertUser(db, {
    id: userId,
    username: "bob",
    passwordHash: await hashPassword("user-pass"),
    role: "user",
    createdAt: Date.now(),
  });
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
    createdBy: adminId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const signer = createSessionSigner(config.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  userCookie = await signer.sign({ sub: userId, username: "bob", role: "user" });
});

function app(overrides: Partial<typeof config> = {}) {
  return buildApp({ config: { ...config, ...overrides }, db, enableRateLimit: false });
}

const stdioServer = {
  name: "demo-stdio",
  transport: "stdio" as const,
  command: "node",
  args: ["server.mjs", "--flag"],
  env: { API_TOKEN: SECRET, EMPTY: "" },
};

describe("admin mcp servers", () => {
  it("requires an admin", async () => {
    const a = await app();
    const anonymous = await a.inject({ method: "GET", url: "/api/admin/mcp-servers" });
    expect(anonymous.statusCode).toBe(401);

    const user = await a.inject({
      method: "GET",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: userCookie },
    });
    expect(user.statusCode).toBe(403);

    const asUser = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: userCookie },
      payload: stdioServer,
    });
    expect(asUser.statusCode).toBe(403);
  });

  it("creates a stdio server, encrypts env and never returns values", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: stdioServer,
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(SECRET);
    const server = created.json().server;
    expect(server).toMatchObject({
      name: "demo-stdio",
      transport: "stdio",
      scope: "global",
      datasourceId: null,
      command: "node",
      args: ["server.mjs", "--flag"],
      enabled: true,
      env: [
        { key: "API_TOKEN", hasValue: true },
        { key: "EMPTY", hasValue: false },
      ],
      headers: [],
    });

    const row = db.select().from(mcpServers).all()[0]!;
    expect(row.envCipher).toBeTruthy();
    expect(row.envCipher).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain(SECRET);

    // The stored ciphertext must round-trip through the conversation loader.
    const loaded = loadMcpFor({ db, config, datasourceId });
    expect(loaded.errors).toEqual([]);
    expect(loaded.servers).toHaveLength(1);
    const loadedConfig = loaded.servers[0]!.config;
    expect(loadedConfig).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["server.mjs", "--flag"],
      env: { API_TOKEN: SECRET, EMPTY: "" },
    });

    const list = await a.inject({
      method: "GET",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(SECRET);
    expect(list.json().servers).toHaveLength(1);

    const detail = await a.inject({
      method: "GET",
      url: `/api/admin/mcp-servers/${server.id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(SECRET);
  });

  it("creates an http server with masked headers in list and detail", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: {
        name: "remote-http",
        transport: "http",
        url: "https://mcp.example.com/sse",
        headers: { Authorization: `Bearer ${SECRET}` },
        datasourceId,
        enabled: false,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(SECRET);
    const server = created.json().server;
    expect(server).toMatchObject({
      transport: "http",
      scope: "datasource",
      datasourceId,
      url: "https://mcp.example.com/sse",
      command: null,
      args: [],
      enabled: false,
      headers: [{ key: "Authorization", hasValue: true }],
    });

    const loaded = loadMcpFor({ db, config, datasourceId });
    expect(loaded.servers).toEqual([]); // disabled servers are not loaded

    const row = db.select().from(mcpServers).all()[0]!;
    expect(row.enabled).toBe(0);
    db.update(mcpServers).set({ enabled: 1 }).run();
    const enabled = loadMcpFor({ db, config, datasourceId });
    expect(enabled.servers[0]!.config).toMatchObject({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    // A datasource-scoped server is hidden from other datasources.
    expect(loadMcpFor({ db, config, datasourceId: randomUUID() }).servers).toEqual([]);

    const detail = await a.inject({
      method: "GET",
      url: `/api/admin/mcp-servers/${server.id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(SECRET);
    expect(detail.json().server.headers).toEqual([{ key: "Authorization", hasValue: true }]);
  });

  it("patches with keep-unchanged values, deletes missing keys and switches transport", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: stdioServer,
    });
    const id = created.json().server.id as string;

    const kept = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { env: { API_TOKEN: null, NEW_KEY: "new-value" } },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().server.env).toEqual([
      { key: "API_TOKEN", hasValue: true },
      { key: "NEW_KEY", hasValue: true },
    ]);
    let loaded = loadMcpFor({ db, config, datasourceId });
    expect((loaded.servers[0]!.config as { env?: Record<string, string> }).env).toEqual({
      API_TOKEN: SECRET,
      NEW_KEY: "new-value",
    });

    const switched = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
      payload: {
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { "X-Api-Key": "header-secret-value" },
        enabled: false,
        name: "renamed-http",
      },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().server).toMatchObject({
      name: "renamed-http",
      transport: "http",
      command: null,
      args: [],
      env: [],
      url: "https://mcp.example.com/mcp",
      headers: [{ key: "X-Api-Key", hasValue: true }],
      enabled: false,
    });
    loaded = loadMcpFor({ db, config, datasourceId });
    expect(loaded.servers).toEqual([]);

    const backing = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { transport: "stdio" },
    });
    expect(backing.statusCode).toBe(400);
    expect(Object.keys(backing.json().error.details.fieldErrors)).toEqual(["command"]);
  });

  it("redacts credentials in urls and args in admin views", async () => {
    const a = await app();
    const http = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: {
        name: "redacted-http",
        transport: "http",
        url: "https://alice:hunter2@mcp.example.com/sse?token=abc123&x=1#frag",
      },
    });
    expect(http.statusCode).toBe(201);
    expect(http.body).not.toContain("alice");
    expect(http.body).not.toContain("hunter2");
    expect(http.body).not.toContain("abc123");
    expect(http.json().server.url).toBe(
      "https://mcp.example.com/sse?token=***&x=***",
    );
    expect(http.json().server.secretsUnreadable).toBe(false);

    const stdio = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: {
        name: "redacted-stdio",
        transport: "stdio",
        command: "node",
        args: ["server.mjs", "--token=abc123", "--api-key", "sk-live-123"],
      },
    });
    expect(stdio.statusCode).toBe(201);
    expect(stdio.body).not.toContain("abc123");
    expect(stdio.body).not.toContain("sk-live-123");
    expect(stdio.json().server.args).toEqual([
      "server.mjs",
      "--token=***",
      "--api-key",
      "***",
    ]);

    const row = db.select().from(mcpServers).all().find((item) => item.name === "redacted-http")!;
    expect(row.url).toContain("token=abc123");
  });

  it("clears env when PATCH sends a top-level null", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: stdioServer,
    });
    const id = created.json().server.id as string;

    const cleared = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { env: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().server.env).toEqual([]);
    const row = db.select().from(mcpServers).all()[0]!;
    expect(row.envCipher).toBeNull();
  });

  it("refuses to overwrite unreadable secrets unless replaceSecrets is set", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: stdioServer,
    });
    const id = created.json().server.id as string;
    db.update(mcpServers).set({ envCipher: "corrupted-ciphertext" }).run();

    const detail = await a.inject({
      method: "GET",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().server.secretsUnreadable).toBe(true);
    expect(detail.json().server.env).toEqual([]);

    const replace = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { env: { API_TOKEN: "new-secret" } },
    });
    expect(replace.statusCode).toBe(409);
    expect(replace.json().error.code).toBe("SECRETS_UNREADABLE");

    const clear = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { env: null },
    });
    expect(clear.statusCode).toBe(409);
    expect(db.select().from(mcpServers).all()[0]!.envCipher).toBe("corrupted-ciphertext");

    const forced = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { env: { API_TOKEN: "new-secret" }, replaceSecrets: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().server.secretsUnreadable).toBe(false);
    expect(forced.json().server.env).toEqual([{ key: "API_TOKEN", hasValue: true }]);
    expect(loadMcpFor({ db, config, datasourceId }).servers[0]!.config).toMatchObject({
      env: { API_TOKEN: "new-secret" },
    });
  });

  it("rejects http endpoints on private, loopback or metadata addresses", async () => {
    const a = await app();
    for (const url of [
      "http://127.0.0.1:9000/mcp",
      "http://[::1]/mcp",
      "http://169.254.169.254/latest/meta-data",
      "http://10.1.2.3/mcp",
      "http://localhost:9000/mcp",
    ]) {
      const response = await a.inject({
        method: "POST",
        url: "/api/admin/mcp-servers",
        cookies: { dc_session: adminCookie },
        payload: { name: `blocked-${randomUUID().slice(0, 8)}`, transport: "http", url },
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error.code, url).toBe("HOST_NOT_ALLOWED");
    }

    const stdio = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: { name: "switch-to-private", transport: "stdio", command: "node" },
    });
    const patched = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${stdio.json().server.id}`,
      cookies: { dc_session: adminCookie },
      payload: { transport: "http", url: "http://127.0.0.1:9000/mcp" },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error.code).toBe("HOST_NOT_ALLOWED");

    const permissive = await app({ mcpAllowPrivateHosts: true });
    const stored = await permissive.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: {
        name: "private-test",
        transport: "http",
        url: "http://169.254.169.254/latest/meta-data",
      },
    });
    expect(stored.statusCode).toBe(201);

    const tested = await a.inject({
      method: "POST",
      url: `/api/admin/mcp-servers/${stored.json().server.id}/test`,
      cookies: { dc_session: adminCookie },
    });
    expect(tested.statusCode).toBe(400);
    expect(tested.json().error.code).toBe("HOST_NOT_ALLOWED");
  });

  it("validates transport fields, bounds and datasource scope", async () => {
    const a = await app();
    const cases: Array<{ payload: Record<string, unknown>; field: string }> = [
      { payload: { name: "no-command", transport: "stdio" }, field: "command" },
      { payload: { name: "stdio-url", transport: "stdio", command: "node", url: "https://x.dev" }, field: "url" },
      {
        payload: { name: "http-command", transport: "http", url: "https://x.dev", command: "node" },
        field: "command",
      },
      { payload: { name: "http-missing", transport: "http" }, field: "url" },
      { payload: { name: "http-bad", transport: "http", url: "ftp://x.dev" }, field: "url" },
      {
        payload: { name: "too-many-args", transport: "stdio", command: "node", args: Array.from({ length: 21 }, () => "a") },
        field: "args",
      },
      {
        payload: { name: "too-many-env", transport: "stdio", command: "node", env: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`K${i}`, "v"])) },
        field: "env",
      },
      {
        payload: { name: "long-env", transport: "stdio", command: "node", env: { K: "x".repeat(2001) } },
        field: "env",
      },
      { payload: { name: "Bad Name", transport: "stdio", command: "node" }, field: "name" },
      { payload: { name: "UPPER", transport: "stdio", command: "node" }, field: "name" },
      {
        payload: { name: "bad-datasource", transport: "stdio", command: "node", datasourceId: randomUUID() },
        field: "datasourceId",
      },
    ];

    for (const { payload, field } of cases) {
      const response = await a.inject({
        method: "POST",
        url: "/api/admin/mcp-servers",
        cookies: { dc_session: adminCookie },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(
        Object.keys(response.json().error.details.fieldErrors),
        JSON.stringify(payload),
      ).toContain(field);
    }

    await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: { name: "unique-name", transport: "stdio", command: "node" },
    });
    const duplicate = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: { name: "unique-name", transport: "stdio", command: "node" },
    });
    expect(duplicate.statusCode).toBe(409);

    const missing = await a.inject({
      method: "DELETE",
      url: `/api/admin/mcp-servers/${randomUUID()}`,
      cookies: { dc_session: adminCookie },
    });
    expect(missing.statusCode).toBe(404);

    const missingPatch = await a.inject({
      method: "PATCH",
      url: `/api/admin/mcp-servers/${randomUUID()}`,
      cookies: { dc_session: adminCookie },
      payload: { enabled: false },
    });
    expect(missingPatch.statusCode).toBe(404);
  });

  it("deletes a server and audits mcp_change without secrets", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/mcp-servers",
      cookies: { dc_session: adminCookie },
      payload: { ...stdioServer, datasourceId },
    });
    const id = created.json().server.id as string;

    const deleted = await a.inject({
      method: "DELETE",
      url: `/api/admin/mcp-servers/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(db.select().from(mcpServers).all()).toEqual([]);

    const audits = db.select().from(queryAudit).all();
    const mcpAudits = audits.filter((row) => row.action === "mcp_change");
    expect(mcpAudits).toHaveLength(2);
    for (const row of mcpAudits) {
      expect(row.detailJson).toBeTruthy();
      expect(row.detailJson).not.toContain(SECRET);
      const detail = JSON.parse(row.detailJson!) as Record<string, unknown>;
      // `ip` is added by the shared audit helper; everything else is ours.
      expect(Object.keys(detail).sort()).toEqual(["enabled", "ip", "name", "transport"]);
      expect(detail).toMatchObject({ name: "demo-stdio", transport: "stdio", enabled: true });
    }
  });
});
