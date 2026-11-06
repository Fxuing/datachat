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
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { appendRunEvent } from "../src/db/repositories/run-events.js";
import { createRun, findRun, markRun } from "../src/db/repositories/runs.js";
import { insertUser } from "../src/db/repositories/users.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let db: Db;
let userId: string;
let conversationId: string;
let cookie: string;
let runtime: {
  bus: RunEventBus;
  abort: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  getOrCreate: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-runs-sse-"));
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  userId = randomUUID();
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

  const datasourceId = randomUUID();
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
  conversationId = createConversation(db, { userId, datasourceId }).id;

  runtime = {
    bus: new RunEventBus(),
    abort: vi.fn(() => true),
    remove: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    getOrCreate: vi.fn(() => ({ enqueue: () => 1 })),
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeApp() {
  return buildApp({
    config: {
      ...testConfig,
      dataDir: root,
      agentAuthPath: path.join(root, "agent", "auth.json"),
    },
    db,
    enableRateLimit: false,
    agentRuntime: runtime as unknown as RuntimeManager,
  });
}

function createTestRun(): string {
  return createRun(db, { conversationId, userId }).id;
}

function append(runId: string, type: string, payload: unknown): void {
  appendRunEvent(db, { runId, conversationId, type, payload });
}

describe("run routes", () => {
  it("replays persisted events after Last-Event-ID and then closes", async () => {
    const runId = createTestRun();
    append(runId, "run_start", { startedAt: 1 });
    append(runId, "text_delta", { text: "你好" });
    append(runId, "run_end", { status: "ok" });
    markRun(db, runId, { status: "ok", endedAt: Date.now() });

    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/stream`,
        headers: { "last-event-id": "1" },
        cookies: { dc_session: cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      const body = response.body;
      expect(body).not.toContain("id: 1\n");
      expect(body).toContain("id: 2\nevent: text_delta\ndata: {\"text\":\"你好\"}\n\n");
      expect(body).toContain("id: 3\nevent: run_end\ndata: {\"status\":\"ok\"}\n\n");
    } finally {
      await app.close();
    }
  });

  it("streams live bus events and does not abort the run when the client closes", async () => {
    const runId = createTestRun();
    const app = await makeApp();
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/runs/${runId}/stream`,
        cookies: { dc_session: cookie },
      });

      await vi.waitFor(() => expect(runtime.bus.listenerCount(conversationId)).toBe(1));
      runtime.bus.publish({
        runId,
        conversationId,
        seq: 1,
        createdAt: Date.now(),
        event: { type: "run_end", payload: { status: "aborted" } },
      });

      const response = await pending;
      expect(response.body).toContain(
        "id: 1\nevent: run_end\ndata: {\"status\":\"aborted\"}\n\n",
      );
      expect(runtime.abort).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("dedupes a replayed event that arrives on the bus while history is loading", async () => {
    const runId = createTestRun();
    append(runId, "run_start", { startedAt: 1 });
    markRun(db, runId, { status: "running" });

    const app = await makeApp();
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/runs/${runId}/stream?after=0`,
        cookies: { dc_session: cookie },
      });
      await vi.waitFor(() => expect(runtime.bus.listenerCount(conversationId)).toBe(1));

      runtime.bus.publish({
        runId,
        conversationId,
        seq: 1,
        createdAt: Date.now(),
        event: { type: "run_start", payload: { startedAt: 1 } },
      });
      runtime.bus.publish({
        runId,
        conversationId,
        seq: 2,
        createdAt: Date.now(),
        event: { type: "run_end", payload: { status: "ok" } },
      });

      const response = await pending;
      expect(response.body.split("id: 1\n")).toHaveLength(2);
      expect(response.body).toContain("id: 2\nevent: run_end");
    } finally {
      await app.close();
    }
  });

  it("returns run status and aborts through the runtime", async () => {
    const runId = createTestRun();
    markRun(db, runId, {
      status: "running",
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    const app = await makeApp();
    try {
      const detail = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}`,
        cookies: { dc_session: cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual({
        id: runId,
        status: "running",
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
        error: null,
      });

      const abort = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/abort`,
        cookies: { dc_session: cookie },
      });
      expect(abort.statusCode).toBe(204);
      expect(runtime.abort).toHaveBeenCalledWith(conversationId, runId);
    } finally {
      await app.close();
    }
  });

  it("persists and publishes an aborted run_end when no runtime owns the run", async () => {
    const runId = createTestRun();
    runtime.abort.mockReturnValue(false);
    const busEvents: Array<{ type: string; payload: unknown }> = [];
    runtime.bus.subscribe(conversationId, (event) => {
      if (event.runId === runId) busEvents.push(event.event);
    });
    const app = await makeApp();
    try {
      const abort = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/abort`,
        cookies: { dc_session: cookie },
      });
      expect(abort.statusCode).toBe(204);
      expect(findRun(db, runId)?.status).toBe("aborted");
      expect(busEvents.at(-1)).toEqual({ type: "run_end", payload: { status: "aborted" } });

      // A client that subscribes after the abort must still see the terminal event.
      const stream = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/stream`,
        cookies: { dc_session: cookie },
      });
      expect(stream.body).toContain(
        "event: run_end\ndata: {\"status\":\"aborted\"}\n\n",
      );
    } finally {
      await app.close();
    }
  });

  it("emits a synthetic terminal run_end when a finished run never stored one", async () => {
    const runId = createTestRun();
    append(runId, "run_start", { startedAt: 1 });
    markRun(db, runId, { status: "error", error: "boom", endedAt: Date.now() });

    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/stream`,
        cookies: { dc_session: cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        "event: run_end\ndata: {\"status\":\"error\",\"error\":\"boom\"}\n\n",
      );
    } finally {
      await app.close();
    }
  });

  it("requires ownership and authentication", async () => {
    const runId = createTestRun();
    const app = await makeApp();
    try {
      const noCookie = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}`,
      });
      expect(noCookie.statusCode).toBe(401);

      const otherUser = randomUUID();
      insertUser(db, {
        id: otherUser,
        username: "bob",
        passwordHash: await hashPassword("bob-pass-123"),
        role: "user",
        createdAt: Date.now(),
      });
      const otherCookie = await createSessionSigner(testConfig.appSecret).sign({
        sub: otherUser,
        username: "bob",
        role: "user",
      });
      const forbidden = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/stream`,
        cookies: { dc_session: otherCookie },
      });
      expect(forbidden.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
