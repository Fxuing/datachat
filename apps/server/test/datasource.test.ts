import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import type { ProbeResult } from "../src/agent/datasource/probe.js";

const probeMock = vi.hoisted(() => ({ probeDatasource: vi.fn() }));

vi.mock("../src/agent/datasource/probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/datasource/probe.js")>();
  return { ...actual, probeDatasource: probeMock.probeDatasource };
});

import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  findDatasource,
  findDatasourceByName,
  insertDatasource,
} from "../src/db/repositories/datasources.js";
import { listGrantedUserIds, replaceGrants } from "../src/db/repositories/grants.js";
import { conversations, mcpServers, queryAudit, skills } from "../src/db/schema.js";
import { PoolRegistry } from "../src/agent/datasource/pool.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

const connectionPayload = {
  name: "analytics",
  type: "mysql" as const,
  host: "127.0.0.1",
  port: 3306,
  database: "app",
  username: "reader",
  password: "super-secret",
  sslMode: "disable" as const,
};

const okProbe: ProbeResult = {
  ok: true,
  serverVersion: "8.0.36",
  readOnly: true,
  warnings: [],
};

let db: Db;
let adminId: string;
let userId: string;
let adminCookie: string;
let userCookie: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  adminId = randomUUID();
  userId = randomUUID();
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
  const signer = createSessionSigner(config.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  userCookie = await signer.sign({ sub: userId, username: "bob", role: "user" });
  probeMock.probeDatasource.mockReset();
  probeMock.probeDatasource.mockResolvedValue(okProbe);
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

describe("datasource crypto", () => {
  it("round-trips a secret and rejects tampering", () => {
    const key = deriveSecretKey("test-secret-test-secret-test-secret-32");
    const cipher = encryptSecret("p@ssw0rd:with:colons", key);
    expect(cipher.startsWith("v1:")).toBe(true);
    expect(decryptSecret(cipher, key)).toBe("p@ssw0rd:with:colons");

    const tampered = cipher.slice(0, -4) + "AAAA";
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("produces different ciphertexts for the same input", () => {
    const key = deriveSecretKey("test-secret-test-secret-test-secret-32");
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });
});

describe("datasource routes", () => {
  it("creates, lists, probes and deletes without leaking the password", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: connectionPayload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().readOnly).toBe(true);
    const id = created.json().id as string;

    // Duplicate names are rejected before dialing the database.
    const duplicate = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: { ...connectionPayload, host: "10.0.0.2" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(probeMock.probeDatasource).toHaveBeenCalledTimes(1);

    const listed = await a.inject({
      method: "GET",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().datasources).toHaveLength(1);
    expect(listed.json().datasources[0]).not.toHaveProperty("passwordCipher");
    expect(JSON.stringify(listed.json())).not.toContain("super-secret");

    // Grants decide what a regular user sees.
    const hidden = await a.inject({
      method: "GET",
      url: "/api/datasources",
      cookies: { dc_session: userCookie },
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().datasources).toEqual([]);

    const granted = await a.inject({
      method: "PUT",
      url: `/api/admin/datasources/${id}/grants`,
      cookies: { dc_session: adminCookie },
      payload: { userIds: [userId] },
    });
    expect(granted.statusCode).toBe(200);

    const visible = await a.inject({
      method: "GET",
      url: "/api/datasources",
      cookies: { dc_session: userCookie },
    });
    expect(visible.json().datasources).toHaveLength(1);

    probeMock.probeDatasource.mockResolvedValueOnce({
      ok: false,
      readOnly: false,
      warnings: [],
      error: "Access denied",
    });
    const tested = await a.inject({
      method: "POST",
      url: `/api/datasources/${id}/test`,
      cookies: { dc_session: adminCookie },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: false, error: "Access denied" });
    expect(findDatasource(db, id)?.status).toBe("error");
    const probeCall = probeMock.probeDatasource.mock.calls.at(-1)?.[0] as {
      password: string;
    };
    expect(probeCall.password).toBe("super-secret");

    const patched = await a.inject({
      method: "PATCH",
      url: `/api/datasources/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { name: "analytics-primary", password: "rotated-secret" },
    });
    expect(patched.statusCode).toBe(200);

    probeMock.probeDatasource.mockResolvedValueOnce(okProbe);
    await a.inject({
      method: "POST",
      url: `/api/datasources/${id}/test`,
      cookies: { dc_session: adminCookie },
    });
    const rotatedCall = probeMock.probeDatasource.mock.calls.at(-1)?.[0] as {
      password: string;
    };
    expect(rotatedCall.password).toBe("rotated-secret");

    const deleted = await a.inject({
      method: "DELETE",
      url: `/api/datasources/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(findDatasource(db, id)).toBeUndefined();
    expect(listGrantedUserIds(db, id)).toEqual([]);

    await a.close();
  });

  it("keeps a write-capable account when the admin opts in", async () => {
    const a = await app();
    const writeProbe = {
      ok: true,
      serverVersion: "8.0.36",
      readOnly: false,
      warnings: ["当前账号具有写权限，建议改用只读账号"],
    };
    probeMock.probeDatasource.mockResolvedValueOnce(writeProbe);

    const created = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: {
        ...connectionPayload,
        name: "root-db",
        username: "root",
        allowWriteAccount: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      readOnly: false,
      allowWriteAccount: true,
      warnings: [],
    });
    const id = created.json().id as string;

    const listed = await a.inject({
      method: "GET",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
    });
    expect(listed.json().datasources[0]).toMatchObject({
      allowWriteAccount: true,
      readOnlyVerified: false,
    });

    const tested = await a.inject({
      method: "POST",
      url: `/api/datasources/${id}/test`,
      cookies: { dc_session: adminCookie },
    });
    expect(tested.json().warnings).toEqual([]);

    // Turning the opt-in off restores the strict advice.
    const patched = await a.inject({
      method: "PATCH",
      url: `/api/datasources/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { allowWriteAccount: false },
    });
    expect(patched.statusCode).toBe(200);

    probeMock.probeDatasource.mockResolvedValueOnce(writeProbe);
    const strict = await a.inject({
      method: "POST",
      url: `/api/datasources/${id}/test`,
      cookies: { dc_session: adminCookie },
    });
    expect(strict.json().warnings).toHaveLength(1);

    await a.close();
  });

  it("deletes datasource-scoped MCP servers and skills with the datasource", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: connectionPayload,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const otherId = randomUUID();
    insertDatasource(db, {
      id: otherId,
      name: "other-db",
      type: "mysql",
      host: "127.0.0.2",
      port: 3306,
      database: "other",
      username: "reader",
      passwordCipher: "cipher",
      createdBy: adminId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const now = Date.now();
    const mcpRows = [
      { id: randomUUID(), name: "target-mcp", datasourceId: id },
      { id: randomUUID(), name: "other-mcp", datasourceId: otherId },
    ];
    for (const row of mcpRows) {
      db.insert(mcpServers)
        .values({
          ...row,
          transport: "stdio",
          command: "npx",
          enabled: 1,
          createdBy: adminId,
          createdAt: now,
        })
        .run();
    }

    const skillContent = "---\nname: scoped\ndescription: scoped\n---\n\nbody\n";
    const skillRows = [
      { id: randomUUID(), scope: "datasource" as const, datasourceId: id, name: "target-skill" },
      {
        id: randomUUID(),
        scope: "datasource" as const,
        datasourceId: otherId,
        name: "other-skill",
      },
      { id: randomUUID(), scope: "global" as const, datasourceId: null, name: "global-skill" },
    ];
    for (const row of skillRows) {
      db.insert(skills)
        .values({
          ...row,
          description: row.name,
          content: skillContent,
          enabled: 1,
          updatedBy: adminId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const deleted = await a.inject({
      method: "DELETE",
      url: `/api/datasources/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(deleted.statusCode).toBe(200);

    expect(db.select().from(mcpServers).all().map((row) => row.name)).toEqual(["other-mcp"]);
    expect(db.select().from(skills).all().map((row) => row.name).sort()).toEqual([
      "global-skill",
      "other-skill",
    ]);
    await a.close();
  });

  it("rejects duplicate datasource names regardless of case", async () => {
    const a = await app();
    const first = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: connectionPayload,
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: { ...connectionPayload, name: "ANALYTICS" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(probeMock.probeDatasource).toHaveBeenCalledTimes(1);
    await a.close();
  });

  it("blocks metadata/link-local hosts and requires a password when the host changes", async () => {
    const a = await app();
    for (const host of ["169.254.169.254", "metadata.google.internal", "[fd00:ec2::254]"]) {
      const blocked = await a.inject({
        method: "POST",
        url: "/api/datasources",
        cookies: { dc_session: adminCookie },
        payload: { ...connectionPayload, host },
      });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error.code).toBe("HOST_NOT_ALLOWED");
    }
    expect(probeMock.probeDatasource).not.toHaveBeenCalled();

    const created = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: connectionPayload,
    });
    const id = created.json().id as string;
    const evict = vi.spyOn(PoolRegistry.prototype, "evict");

    // A new host must not inherit the stored (encrypted) password.
    const noPassword = await a.inject({
      method: "PATCH",
      url: `/api/datasources/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { host: "10.0.0.9" },
    });
    expect(noPassword.statusCode).toBe(400);
    expect(noPassword.json().error.code).toBe("PASSWORD_REQUIRED");

    const patched = await a.inject({
      method: "PATCH",
      url: `/api/datasources/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { host: "10.0.0.9", password: "new-secret" },
    });
    expect(patched.statusCode).toBe(200);
    const row = findDatasource(db, id)!;
    expect(row.status).toBe("unknown");
    expect(row.readOnlyVerified).toBe(0);
    expect(row.lastCheckedAt).toBeNull();
    expect(evict).toHaveBeenCalledWith(id);
    const actions = db.select().from(queryAudit).all().map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["datasource_create", "datasource_update"]));
    evict.mockRestore();
    await a.close();
  });

  it("returns 409 instead of orphaning conversations that reference the datasource", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: connectionPayload,
    });
    const id = created.json().id as string;
    db.insert(conversations)
      .values({
        id: randomUUID(),
        userId: adminId,
        datasourceId: id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();

    const deleted = await a.inject({
      method: "DELETE",
      url: `/api/datasources/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error.code).toBe("DS_IN_USE");
    expect(findDatasource(db, id)).toBeDefined();

    const actions = db.select().from(queryAudit).all().map((row) => row.action);
    expect(actions).toEqual(["datasource_create"]);
    await a.close();
  });

  it("rejects unreachable datasources and scrubs the password from errors", async () => {
    const a = await app();
    probeMock.probeDatasource.mockResolvedValueOnce({
      ok: false,
      readOnly: false,
      warnings: [],
      error: `connect failed for super-secret`,
    });
    const created = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: connectionPayload,
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error.code).toBe("DS_UNREACHABLE");
    expect(created.json().error.message).not.toContain("super-secret");
    expect(created.json().error.message).toContain("***");

    const listed = await a.inject({
      method: "GET",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
    });
    expect(listed.json().datasources).toEqual([]);
    await a.close();
  });

  it("requires admin for mutations and validates input", async () => {
    const a = await app();
    const deniedCreate = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: userCookie },
      payload: connectionPayload,
    });
    expect(deniedCreate.statusCode).toBe(403);

    const invalid = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: { ...connectionPayload, port: 0 },
    });
    expect(invalid.statusCode).toBe(400);

    const missingPassword = await a.inject({
      method: "POST",
      url: "/api/datasources",
      cookies: { dc_session: adminCookie },
      payload: { ...connectionPayload, password: undefined },
    });
    expect(missingPassword.statusCode).toBe(400);

    insertDatasource(db, {
      id: randomUUID(),
      name: "seeded",
      type: "mysql",
      host: "127.0.0.1",
      port: 3306,
      database: "app",
      username: "reader",
      passwordCipher: encryptSecret("secret", deriveSecretKey(config.appSecret)),
      sslMode: "disable",
      readOnlyVerified: 0,
      allowWriteAccount: 0,
      status: "unknown",
      lastCheckedAt: null,
      createdBy: adminId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const seededId = findDatasourceByName(db, "seeded")!.id;
    const deniedPatch = await a.inject({
      method: "PATCH",
      url: `/api/datasources/${seededId}`,
      cookies: { dc_session: userCookie },
      payload: { name: "nope" },
    });
    expect(deniedPatch.statusCode).toBe(403);

    const deniedDelete = await a.inject({
      method: "DELETE",
      url: `/api/datasources/${seededId}`,
      cookies: { dc_session: userCookie },
    });
    expect(deniedDelete.statusCode).toBe(403);

    await a.close();
  });
});
