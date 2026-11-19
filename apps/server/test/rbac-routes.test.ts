import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { skills } from "../src/db/schema.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { createRole, setUserRoles } from "../src/db/repositories/roles.js";
import { insertUser } from "../src/db/repositories/users.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { ArtifactStore, type ColumnInfo } from "../src/services/artifacts.js";
import { testConfig } from "./helpers/config.js";

const columns: ColumnInfo[] = [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
];

let root: string;
let db: Db;
let store: ArtifactStore;
let app: Awaited<ReturnType<typeof buildApp>>;
let datasourceId: string;
let skillUserId: string;
let chatOnlyUserId: string;
let noChatUserId: string;
let adminId: string;
let skillCookie: string;
let chatOnlyCookie: string;
let noChatCookie: string;
let adminCookie: string;
let skillConversationId: string;
let chatOnlyConversationId: string;
let noChatConversationId: string;

const fakeRuntime = {
  bus: new RunEventBus(),
  enqueued: [] as Array<{ runId: string; content: string; displayContent?: string; skill?: string }>,
  abort: vi.fn(() => true),
  remove: vi.fn(async () => undefined),
  isBusy: vi.fn(() => false),
  shutdown: vi.fn(async () => undefined),
  getOrCreate: vi.fn(() => ({
    queueLength: 0,
    enqueue: (input: { runId: string; content: string; displayContent?: string; skill?: string }) => {
      fakeRuntime.enqueued.push(input);
      return 1;
    },
  })),
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-rbac-routes-"));
  db = createDb(":memory:").db;
  migrateDb(db);

  const signer = createSessionSigner(testConfig.appSecret);
  skillUserId = randomUUID();
  chatOnlyUserId = randomUUID();
  noChatUserId = randomUUID();
  adminId = randomUUID();
  for (const [id, username, role] of [
    [skillUserId, "skiller", "user"],
    [chatOnlyUserId, "chatter", "user"],
    [noChatUserId, "outsider", "user"],
    [adminId, "root", "admin"],
  ] as const) {
    insertUser(db, {
      id,
      username,
      passwordHash: await hashPassword(`${username}-pass-123`),
      role,
      createdAt: Date.now(),
    });
  }
  skillCookie = await signer.sign({ sub: skillUserId, username: "skiller", role: "user" });
  chatOnlyCookie = await signer.sign({ sub: chatOnlyUserId, username: "chatter", role: "user" });
  noChatCookie = await signer.sign({ sub: noChatUserId, username: "outsider", role: "user" });
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });

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

  // Roles carry functional permissions only; datasource access comes from
  // department or direct grants.
  const skillRole = createRole(db, {
    name: "skill-user",
    permissions: ["chat.use", "skill.use"],
  });
  const chatOnlyRole = createRole(db, {
    name: "chat-only",
    permissions: ["chat.use"],
  });
  const noChatRole = createRole(db, {
    name: "no-chat",
    permissions: [],
  });
  setUserRoles(db, skillUserId, [skillRole.id]);
  setUserRoles(db, chatOnlyUserId, [chatOnlyRole.id]);
  setUserRoles(db, noChatUserId, [noChatRole.id]);
  replaceGrants(db, datasourceId, [skillUserId, chatOnlyUserId, noChatUserId]);

  const now = Date.now();
  db.insert(skills)
    .values({
      id: randomUUID(),
      scope: "global",
      datasourceId: null,
      name: "sql-helper",
      description: "helper",
      content: "# sql-helper\n\nbody",
      enabled: 1,
      updatedBy: "test",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  skillConversationId = createConversation(db, {
    userId: skillUserId,
    datasourceId,
    title: "skiller chat",
  }).id;
  chatOnlyConversationId = createConversation(db, {
    userId: chatOnlyUserId,
    datasourceId,
    title: "chatter chat",
  }).id;
  noChatConversationId = createConversation(db, {
    userId: noChatUserId,
    datasourceId,
    title: "outsider chat",
  }).id;

  fakeRuntime.enqueued.length = 0;
  fakeRuntime.bus = new RunEventBus();
  fakeRuntime.getOrCreate.mockClear();

  store = new ArtifactStore(db, path.join(root, "artifacts"));
  await store.init();
  app = await buildApp({
    config: {
      ...testConfig,
      dataDir: root,
      agentAuthPath: path.join(root, "agent", "auth.json"),
    },
    db,
    enableRateLimit: false,
    agentRuntime: fakeRuntime as unknown as RuntimeManager,
    artifacts: store,
  });
});

afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedResult(owner: string): Promise<string> {
  const writer = store.openResult({
    userId: owner,
    conversationId: owner === chatOnlyUserId ? chatOnlyConversationId : skillConversationId,
    runId: null,
  });
  await writer.write([1, "alpha"]);
  const meta = await writer.finish({ columns, rowCount: 1, truncated: false });
  return meta.id;
}

function inject(
  cookie: string,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    cookies: { dc_session: cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe("rbac http gates", () => {
  it("allows chat.use and denies report/share/export/admin for a chat-only member", async () => {
    const artifactId = await seedResult(chatOnlyUserId);

    const conversations = await inject(chatOnlyCookie, "GET", "/api/conversations");
    expect(conversations.statusCode).toBe(200);

    const preview = await inject(chatOnlyCookie, "GET", `/api/artifacts/${artifactId}`);
    expect(preview.statusCode).toBe(200);

    const report = await inject(chatOnlyCookie, "POST", "/api/reports", {
      conversationId: chatOnlyConversationId,
      artifactIds: [artifactId],
    });
    expect(report.statusCode).toBe(403);
    expect(report.json().error.code).toBe("PERMISSION_DENIED");
    expect(report.json().error.permission).toBe("report.create");

    const share = await inject(chatOnlyCookie, "POST", "/api/shares", {
      conversationId: chatOnlyConversationId,
    });
    expect(share.statusCode).toBe(403);
    expect(share.json().error.permission).toBe("share.create");

    const download = await inject(
      chatOnlyCookie,
      "GET",
      `/api/artifacts/${artifactId}/download?format=csv`,
    );
    expect(download.statusCode).toBe(403);
    expect(download.json().error.permission).toBe("export.data");

    for (const url of ["/api/admin/roles", "/api/admin/users", "/api/admin/skills"]) {
      const denied = await inject(chatOnlyCookie, "GET", url);
      expect(denied.statusCode, url).toBe(403);
    }
  });

  it("denies conversation routes without chat.use", async () => {
    const list = await inject(noChatCookie, "GET", "/api/conversations");
    expect(list.statusCode).toBe(403);
    expect(list.json().error.permission).toBe("chat.use");

    const message = await inject(noChatCookie, "POST", `/api/conversations/${noChatConversationId}/messages`, {
      content: "你好",
    });
    expect(message.statusCode).toBe(403);
    expect(message.json().error.permission).toBe("chat.use");

    const retry = await inject(noChatCookie, "POST", `/api/runs/${randomUUID()}/retry`);
    expect(retry.statusCode).toBe(403);

    // Model listing is login-only, not chat-gated.
    const models = await inject(noChatCookie, "GET", "/api/models");
    expect(models.statusCode).toBe(200);
  });

  it("requires skill.use only when the message sends a skill", async () => {
    const plain = await inject(chatOnlyCookie, "POST", `/api/conversations/${chatOnlyConversationId}/messages`, {
      content: "你好",
    });
    expect(plain.statusCode).toBe(202);

    const withSkill = await inject(chatOnlyCookie, "POST", `/api/conversations/${chatOnlyConversationId}/messages`, {
      content: "你好",
      skill: "sql-helper",
    });
    expect(withSkill.statusCode).toBe(403);
    expect(withSkill.json().error.code).toBe("PERMISSION_DENIED");
    expect(withSkill.json().error.permission).toBe("skill.use");

    const allowed = await inject(skillCookie, "POST", `/api/conversations/${skillConversationId}/messages`, {
      content: "你好",
      skill: "sql-helper",
    });
    expect(allowed.statusCode).toBe(202);
    expect(fakeRuntime.enqueued.at(-1)?.skill).toBe("sql-helper");
  });

  it("lets an admin through every gate", async () => {
    const artifactId = await seedResult(adminId);

    expect((await inject(adminCookie, "GET", "/api/conversations")).statusCode).toBe(200);
    expect((await inject(adminCookie, "GET", "/api/admin/roles")).statusCode).toBe(200);
    expect((await inject(adminCookie, "GET", "/api/admin/users")).statusCode).toBe(200);
    expect((await inject(adminCookie, "GET", "/api/admin/settings")).statusCode).toBe(200);
    expect((await inject(adminCookie, "GET", "/api/admin/audit")).statusCode).toBe(200);
    expect(
      (await inject(adminCookie, "GET", `/api/artifacts/${artifactId}/download?format=csv`)).statusCode,
    ).toBe(200);
  });

  it("filters the datasource list by datasource grants", async () => {
    const chatOnly = await inject(chatOnlyCookie, "GET", "/api/datasources");
    expect(chatOnly.statusCode).toBe(200);
    expect(chatOnly.json().datasources.map((row: { id: string }) => row.id)).toEqual([datasourceId]);

    const admin = await inject(adminCookie, "GET", "/api/datasources");
    expect(admin.json().datasources.map((row: { id: string }) => row.id)).toEqual([datasourceId]);

    replaceGrants(db, datasourceId, [skillUserId, noChatUserId]);
    const empty = await inject(chatOnlyCookie, "GET", "/api/datasources");
    expect(empty.statusCode).toBe(200);
    expect(empty.json().datasources).toEqual([]);
  });
});
