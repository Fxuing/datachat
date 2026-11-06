import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { insertUser } from "../src/db/repositories/users.js";
import { PoolRegistry } from "../src/agent/datasource/pool.js";
import { RuntimeManager } from "../src/agent/runtime.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { testConfig } from "./helpers/config.js";
import { asAgentSession, FakeAgentSession } from "./helpers/fake-agent-session.js";

const USERNAME = "alice";
const PASSWORD = "alice-pass-123";
const USER_MESSAGE = "统计 users 表的行数";
const ASSISTANT_TEXT = "users 表共有 3 行：alice、bob、carol。";
const SQL = "select id, name from users limit 3";
const AUDIT_ID = "audit-e2e-1";
const TOOL_CALL_ID = "call-1";
const COLUMNS = [
  { name: "id", type: "number" as const },
  { name: "name", type: "string" as const },
];
const ROWS = [
  [1, "alice"],
  [2, "bob"],
  [3, "carol"],
];

let root: string;
let handle: ReturnType<typeof createDb>;
let db: Db;
let app: FastifyInstance;
let manager: RuntimeManager;
let artifacts: ArtifactStore;
let userId: string;
let datasourceId: string;
let gate: ReturnType<typeof deferred>;
let artifactId: string | undefined;

/** The run must not start until the test has subscribed to the SSE bus. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 120, output: 24, cacheRead: 0, cacheWrite: 0, totalTokens: 144, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "stop",
    api: "openai-completions",
    provider: "siliconflow",
    model: "deepseek-ai/DeepSeek-V3.2",
    timestamp: Date.now(),
  };
}

function sseFrames(body: string) {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0 && !frame.startsWith(":"))
    .map((frame) => {
      const lines = frame.split("\n");
      const id = Number(lines.find((line) => line.startsWith("id: "))?.slice(4));
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null") as unknown;
      return { id, event, data };
    });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-agent-e2e-"));
  handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);

  userId = randomUUID();
  insertUser(db, {
    id: userId,
    username: USERNAME,
    passwordHash: await hashPassword(PASSWORD),
    role: "user",
    createdAt: Date.now(),
  });

  datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "smoke-db",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "smoke",
    username: "smoke",
    passwordCipher: "cipher",
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  replaceGrants(db, datasourceId, [userId]);

  gate = deferred();
  artifactId = undefined;
  artifacts = new ArtifactStore(db, path.join(root, "artifacts"));
  const pools = new PoolRegistry();
  const config = {
    ...testConfig,
    dataDir: root,
    agentAuthPath: path.join(root, "agent", "auth.json"),
    siliconflowApiKey: "sk-test",
  };
  const session = new FakeAgentSession();

  manager = new RuntimeManager({
    db,
    config,
    pools,
    artifacts,
    sweepIntervalMs: 0,
    // Fake model: a real artifact plus the exact Pi event sequence the bridge consumes.
    createSession: async ({ conversation, userId: ownerId, runId }) => {
      await gate.promise;
      const writer = artifacts.openResult({
        userId: ownerId,
        conversationId: conversation.id,
        runId,
      });
      for (const row of ROWS) await writer.write(row);
      const meta = await writer.finish({ columns: COLUMNS, rowCount: ROWS.length, truncated: false });
      artifactId = meta.id;
      const message = assistantMessage(ASSISTANT_TEXT);
      const toolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              artifactId: meta.id,
              columns: COLUMNS,
              rowCount: ROWS.length,
              truncated: false,
              previewRows: ROWS,
            }),
          },
        ],
        details: {
          artifactId: meta.id,
          columns: COLUMNS,
          rowCount: ROWS.length,
          truncated: false,
          auditId: AUDIT_ID,
          sql: SQL,
          guard: "ok",
          durationMs: 7,
        },
      };

      session.prompt.mockImplementation(async () => {
        const emit = (event: unknown) => session.emit(event as AgentSessionEvent);
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "users 表共有 3 行：" },
        });
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "alice、bob、carol。" },
        });
        emit({
          type: "tool_execution_start",
          toolCallId: TOOL_CALL_ID,
          toolName: "db_query",
          args: { sql: SQL },
        });
        emit({
          type: "tool_execution_end",
          toolCallId: TOOL_CALL_ID,
          toolName: "db_query",
          result: toolResult,
          isError: false,
          durationMs: 7,
        });
        emit({ type: "message_end", message });
        emit({ type: "agent_end", messages: [message], willRetry: false });
      });

      return { session: asAgentSession(session) };
    },
  });

  app = await buildApp({
    config,
    db,
    enableRateLimit: false,
    artifacts,
    pools,
    agentRuntime: manager,
  });
});

afterEach(async () => {
  await app.close();
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("agent chat end to end", () => {
  it("streams a tool-call run and restores messages, SQL, and result metadata", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookieValue = login.cookies.find((cookie) => cookie.name === "dc_session")?.value;
    expect(cookieValue).toBeTruthy();
    const cookies = { dc_session: cookieValue! };

    // The chat page asks for the model catalog before it can send a message.
    const models = await app.inject({ method: "GET", url: "/api/models", cookies });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({ configured: true, defaultId: "deepseek-ai/DeepSeek-V3.2" });
    expect(models.json().models).toHaveLength(4);

    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      cookies,
      payload: { datasourceId },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().conversation.id as string;
    expect(created.json().conversation.datasourceId).toBe(datasourceId);

    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      cookies,
      payload: { content: USER_MESSAGE },
    });
    expect(sent.statusCode).toBe(202);
    const { runId, position } = sent.json() as { runId: string; position: number };
    expect(position).toBe(1);

    // Subscribe first, then let the gated fake model run so every frame is live.
    const pendingStream = app.inject({
      method: "GET",
      url: `/api/runs/${runId}/stream`,
      cookies,
    });
    await vi.waitFor(() => expect(manager.bus.listenerCount(conversationId)).toBe(1));
    gate.resolve();

    const stream = await pendingStream;
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");

    const frames = sseFrames(stream.body);
    expect(frames.map((frame) => frame.event)).toEqual([
      "run_queued",
      "run_start",
      "user_message",
      "text_delta",
      "text_delta",
      "tool_start",
      "tool_end",
      "result",
      "sql",
      "assistant_message",
      "usage",
      "run_end",
    ]);
    expect(frames.map((frame) => frame.id)).toEqual(frames.map((_, index) => index + 1));
    expect(frames[0]?.data).toEqual({ position: 1 });
    expect(
      frames
        .filter((frame) => frame.event === "text_delta")
        .map((frame) => (frame.data as { text: string }).text)
        .join(""),
    ).toBe(ASSISTANT_TEXT);
    expect(frames.find((frame) => frame.event === "tool_start")?.data).toEqual({
      toolCallId: TOOL_CALL_ID,
      name: "db_query",
      args: { sql: SQL },
    });

    expect(artifactId).toBeTruthy();
    const resultFrame = frames.find((frame) => frame.event === "result");
    expect(resultFrame?.data).toEqual({
      artifactId,
      columns: COLUMNS,
      rows: ROWS,
      rowCount: 3,
      truncated: false,
    });
    expect(frames.find((frame) => frame.event === "sql")?.data).toEqual({
      sql: SQL,
      auditId: AUDIT_ID,
      status: "ok",
    });
    expect(frames.find((frame) => frame.event === "run_end")?.data).toEqual({ status: "ok" });

    const detail = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
      cookies,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.conversation).toMatchObject({ id: conversationId, title: USER_MESSAGE });
    expect(body.messages).toHaveLength(1);
    const [entry] = body.messages;
    expect(entry).toMatchObject({
      runId,
      status: "ok",
      user: { content: USER_MESSAGE },
      assistant: { content: ASSISTANT_TEXT },
    });
    expect(entry.tools).toEqual([
      {
        toolCallId: TOOL_CALL_ID,
        name: "db_query",
        args: { sql: SQL },
        status: "ok",
        durationMs: 7,
        summary: "3 行",
      },
    ]);
    expect(entry.results).toEqual([
      {
        artifactId,
        columns: COLUMNS,
        rows: ROWS,
        rowCount: 3,
        truncated: false,
      },
    ]);
    expect(entry.sqls).toEqual([{ sql: SQL, auditId: AUDIT_ID, status: "ok" }]);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({
      id: artifactId,
      runId,
      kind: "result",
      columns: COLUMNS,
      rowCount: 3,
      truncated: false,
    });

    const run = await app.inject({ method: "GET", url: `/api/runs/${runId}`, cookies });
    expect(run.json()).toEqual({
      id: runId,
      status: "ok",
      usage: { input: 120, output: 24, cacheRead: 0, cacheWrite: 0 },
      error: null,
    });
  });
});
