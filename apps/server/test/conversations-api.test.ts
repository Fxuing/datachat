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
import { artifacts, runs } from "../src/db/schema.js";
import {
  createConversation,
  findConversation,
  findOwnedConversation,
  updateConversation,
} from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { appendRunEvent, listRunEventsAfter } from "../src/db/repositories/run-events.js";
import { createRun, findRun, markRun } from "../src/db/repositories/runs.js";
import { insertUser } from "../src/db/repositories/users.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let db: Db;
let userId: string;
let otherUserId: string;
let datasourceId: string;
let cookie: string;
let otherCookie: string;

const fakeRuntime = {
  bus: new RunEventBus(),
  enqueued: [] as Array<{ runId: string; content: string }>,
  position: 1,
  abort: vi.fn(() => true),
  remove: vi.fn(async () => undefined),
  isBusy: vi.fn(() => false),
  shutdown: vi.fn(async () => undefined),
  getOrCreate: vi.fn(() => ({
    queueLength: 0,
    enqueue: (input: { runId: string; content: string }) => {
      fakeRuntime.enqueued.push(input);
      return fakeRuntime.position++;
    },
  })),
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-conversations-"));
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  userId = randomUUID();
  otherUserId = randomUUID();
  for (const [id, username] of [
    [userId, "alice"],
    [otherUserId, "bob"],
  ] as const) {
    insertUser(db, {
      id,
      username,
      passwordHash: await hashPassword(`${username}-pass-123`),
      role: "user",
      createdAt: Date.now(),
    });
  }
  cookie = await createSessionSigner(testConfig.appSecret).sign({
    sub: userId,
    username: "alice",
    role: "user",
  });
  otherCookie = await createSessionSigner(testConfig.appSecret).sign({
    sub: otherUserId,
    username: "bob",
    role: "user",
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
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  replaceGrants(db, datasourceId, [userId]);

  fakeRuntime.enqueued.length = 0;
  fakeRuntime.position = 1;
  fakeRuntime.bus = new RunEventBus();
  fakeRuntime.abort.mockClear();
  fakeRuntime.remove.mockClear();
  fakeRuntime.isBusy.mockReturnValue(false);
  fakeRuntime.getOrCreate.mockClear();
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

async function makeApp() {
  return buildApp({
    config: config(),
    db,
    enableRateLimit: false,
    agentRuntime: fakeRuntime as unknown as RuntimeManager,
  });
}

async function createTestConversation(withCookie = cookie): Promise<string> {
  const app = await makeApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/conversations",
      cookies: { dc_session: withCookie },
      payload: { datasourceId },
    });
    expect(response.statusCode).toBe(201);
    return response.json().conversation.id as string;
  } finally {
    await app.close();
  }
}

describe("conversation routes", () => {
  it("creates, lists, renames and validates models", async () => {
    const app = await makeApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/conversations",
        cookies: { dc_session: cookie },
        payload: { datasourceId, title: "  my chat  " },
      });
      expect(created.statusCode).toBe(201);
      const conversationId = created.json().conversation.id as string;
      expect(created.json().conversation.title).toBe("my chat");

      const list = await app.inject({
        method: "GET",
        url: "/api/conversations?limit=30",
        cookies: { dc_session: cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0].id).toBe(conversationId);
      expect(list.json().nextCursor).toBeNull();

      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: cookie },
        payload: { title: "renamed" },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().conversation.title).toBe("renamed");

      const invalid = await app.inject({
        method: "PATCH",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: cookie },
        payload: { modelId: "not-a-model" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("VALIDATION");

      const valid = await app.inject({
        method: "PATCH",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: cookie },
        payload: { modelId: "deepseek-ai/DeepSeek-V3.2" },
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.json().conversation.modelId).toBe("deepseek-ai/DeepSeek-V3.2");
      expect(valid.json().conversation).not.toHaveProperty("piSessionFile");
    } finally {
      await app.close();
    }
  });

  it("aggregates messages from run events", async () => {
    const conversation = createConversation(db, { userId, datasourceId });
    const run = createRun(db, {
      conversationId: conversation.id,
      userId,
      modelId: "deepseek-ai/DeepSeek-V3.2",
    });
    const events = [
      { type: "run_queued", payload: { position: 1 } },
      { type: "run_start", payload: { startedAt: Date.now() } },
      { type: "user_message", payload: { content: "你好" } },
      { type: "text_delta", payload: { text: "你" } },
      { type: "text_delta", payload: { text: "好" } },
      { type: "assistant_message", payload: { content: "你好！" } },
      {
        type: "tool_start",
        payload: { toolCallId: "call-1", name: "db_query", args: { sql: "select 1" } },
      },
      {
        type: "tool_end",
        payload: {
          toolCallId: "call-1",
          name: "db_query",
          isError: false,
          durationMs: 3,
          summary: "1 行",
        },
      },
      {
        type: "result",
        payload: {
          artifactId: "artifact-1",
          columns: [{ name: "x", type: "number" }],
          rows: [[1]],
          rowCount: 1,
          truncated: false,
        },
      },
      {
        type: "sql",
        payload: { sql: "select 1", auditId: "audit-1", status: "ok" },
      },
      { type: "run_end", payload: { status: "ok" } },
    ];
    for (const event of events) {
      appendRunEvent(db, {
        runId: run.id,
        conversationId: conversation.id,
        type: event.type,
        payload: event.payload,
      });
    }
    markRun(db, run.id, { status: "ok", endedAt: Date.now() });

    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}`,
        cookies: { dc_session: cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({
        runId: run.id,
        status: "ok",
        user: { content: "你好" },
        assistant: { content: "你好！" },
        tools: [
          {
            toolCallId: "call-1",
            name: "db_query",
            status: "ok",
            durationMs: 3,
            summary: "1 行",
          },
        ],
      });
      expect(body.messages[0].results).toEqual([
        {
          artifactId: "artifact-1",
          columns: [{ name: "x", type: "number" }],
          rows: [[1]],
          rowCount: 1,
          truncated: false,
        },
      ]);
      expect(body.messages[0].sqls).toEqual([
        { sql: "select 1", auditId: "audit-1", status: "ok" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("skips artifacts with malformed JSON columns instead of failing the detail", async () => {
    const conversation = createConversation(db, { userId, datasourceId });
    const now = Date.now();
    db.insert(artifacts)
      .values([
        {
          id: "artifact-bad",
          conversationId: conversation.id,
          userId,
          kind: "result",
          columnsJson: "{not-json",
          rowCount: 1,
          truncated: 0,
          createdAt: now,
        },
        {
          id: "artifact-good",
          conversationId: conversation.id,
          userId,
          kind: "result",
          columnsJson: JSON.stringify([{ name: "x", type: "number" }]),
          specJson: "{broken",
          rowCount: 2,
          truncated: 0,
          createdAt: now + 1,
        },
      ])
      .run();

    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}`,
        cookies: { dc_session: cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().artifacts).toEqual([
        {
          id: "artifact-good",
          runId: null,
          kind: "result",
          columns: [{ name: "x", type: "number" }],
          rowCount: 2,
          truncated: false,
          spec: null,
          createdAt: now + 1,
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("enqueues a message, returns 202 and sets the title from the first message", async () => {
    const conversationId = await createTestConversation();
    updateConversation(db, conversationId, { title: null });
    const app = await makeApp();
    try {
      const content = "  第一行\n第二行\nthe rest should be cut at forty characters  ";
      const response = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/messages`,
        cookies: { dc_session: cookie },
        payload: { content },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().runId).toEqual(expect.any(String));
      expect(response.json().position).toBe(1);
      expect(fakeRuntime.enqueued).toHaveLength(1);
      expect(fakeRuntime.enqueued[0]?.content).toBe(content.trim());

      const stored = findConversation(db, conversationId);
      expect(stored?.title).toBe(content.trim().replace(/\s+/g, " ").slice(0, 40));

      const second = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/messages`,
        cookies: { dc_session: cookie },
        payload: { content: "second" },
      });
      expect(second.statusCode).toBe(202);
      expect(second.json().position).toBe(2);
      expect(findConversation(db, conversationId)?.title).not.toBe("second");

      const blank = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/messages`,
        cookies: { dc_session: cookie },
        payload: { content: "   " },
      });
      expect(blank.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("hides other users' conversations behind 404", async () => {
    const conversationId = await createTestConversation();
    const app = await makeApp();
    try {
      const detail = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: otherCookie },
      });
      expect(detail.statusCode).toBe(404);

      const message = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/messages`,
        cookies: { dc_session: otherCookie },
        payload: { content: "hi" },
      });
      expect(message.statusCode).toBe(404);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: otherCookie },
      });
      expect(deleted.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("deletes the session file, artifacts, rows and runtime on DELETE", async () => {
    const conversation = createConversation(db, { userId, datasourceId });
    const sessionFile = path.join(root, "pi-sessions", `${conversation.id}.jsonl`);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n");
    updateConversation(db, conversation.id, { piSessionFile: sessionFile });

    const run = createRun(db, { conversationId: conversation.id, userId });
    appendRunEvent(db, {
      runId: run.id,
      conversationId: conversation.id,
      type: "run_end",
      payload: { status: "ok" },
    });

    const artifactId = randomUUID();
    const artifactPath = path.join(root, "artifacts", `${artifactId}.jsonl.gz`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "data");
    db.insert(artifacts)
      .values({
        id: artifactId,
        conversationId: conversation.id,
        userId,
        runId: run.id,
        kind: "result",
        storagePath: `${artifactId}.jsonl.gz`,
        rowCount: 1,
        truncated: 0,
        createdAt: Date.now(),
      })
      .run();

    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/conversations/${conversation.id}`,
        cookies: { dc_session: cookie },
      });
      expect(response.statusCode).toBe(204);
      expect(fakeRuntime.remove).toHaveBeenCalledWith(conversation.id);
      expect(findConversation(db, conversation.id)).toBeUndefined();
      expect(findOwnedConversation(db, conversation.id, userId)).toBeUndefined();
      expect(listRunEventsAfter(db, run.id, 0)).toEqual([]);
      expect(fs.existsSync(sessionFile)).toBe(false);
      expect(fs.existsSync(artifactPath)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("exposes the active run so a reloaded page can resume streaming", async () => {
    const conversation = createConversation(db, { userId, datasourceId });
    const run = createRun(db, {
      conversationId: conversation.id,
      userId,
      modelId: "deepseek-ai/DeepSeek-V3.2",
    });
    markRun(db, run.id, { status: "running", startedAt: Date.now() });

    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}`,
        cookies: { dc_session: cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().activeRun).toEqual({ id: run.id, status: "running" });

      markRun(db, run.id, { status: "ok", endedAt: Date.now() });
      const finished = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}`,
        cookies: { dc_session: cookie },
      });
      expect(finished.json().activeRun).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("includes the terminal run error in history", async () => {
    const conversation = createConversation(db, { userId, datasourceId });
    const run = createRun(db, { conversationId: conversation.id, userId });
    appendRunEvent(db, {
      runId: run.id,
      conversationId: conversation.id,
      type: "user_message",
      payload: { content: "hello" },
    });
    appendRunEvent(db, {
      runId: run.id,
      conversationId: conversation.id,
      type: "run_end",
      payload: { status: "error", error: "upstream exploded" },
    });
    markRun(db, run.id, { status: "error", error: "upstream exploded", endedAt: Date.now() });

    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}`,
        cookies: { dc_session: cookie },
      });
      expect(response.json().messages[0]).toMatchObject({
        status: "error",
        error: "upstream exploded",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a message when the conversation queue is full", async () => {
    const conversationId = await createTestConversation();
    fakeRuntime.getOrCreate.mockImplementationOnce(() => ({
      queueLength: 5,
      enqueue: () => {
        throw new Error("should not enqueue");
      },
    }));
    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/messages`,
        cookies: { dc_session: cookie },
        payload: { content: "hello" },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe("RATE_LIMITED");
      expect(fakeRuntime.enqueued).toHaveLength(0);
      expect(db.select().from(runs).all()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("refuses to delete a conversation while its runtime is busy", async () => {
    const conversationId = await createTestConversation();
    fakeRuntime.isBusy.mockReturnValueOnce(true);
    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: cookie },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({
        code: "CONFLICT",
        message: "请先停止当前回答",
      });
      expect(findConversation(db, conversationId)).toBeDefined();
      expect(fakeRuntime.remove).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("marks the run error when the runtime rejects the enqueue", async () => {
    const conversationId = await createTestConversation();
    fakeRuntime.getOrCreate.mockImplementationOnce(() => ({
      queueLength: 0,
      enqueue: () => {
        throw new Error("runtime closed");
      },
    }));
    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/messages`,
        cookies: { dc_session: cookie },
        payload: { content: "hello" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe("ENQUEUE_FAILED");

      const stored = db.select().from(runs).all();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ status: "error", error: "runtime closed" });
      expect(stored[0]!.endedAt).toEqual(expect.any(Number));
      expect(listRunEventsAfter(db, stored[0]!.id, 0).at(-1)).toMatchObject({
        type: "run_end",
        payloadJson: JSON.stringify({ status: "error", error: "runtime closed" }),
      });
    } finally {
      await app.close();
    }
  });
});

describe("datasource access for conversations", () => {
  it("rejects a datasource without a grant", async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/conversations",
        cookies: { dc_session: otherCookie },
        payload: { datasourceId },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  it("requires authentication", async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/conversations" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
