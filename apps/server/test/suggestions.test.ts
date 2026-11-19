import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { datasources } from "../src/db/schema.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { createRole, setUserRoles } from "../src/db/repositories/roles.js";
import { appendRunEvent } from "../src/db/repositories/run-events.js";
import { createRun, findRun, markRun } from "../src/db/repositories/runs.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  parseSuggestedQuestions,
  stripPlaceholders,
} from "../src/services/suggestions.js";
import { testConfig } from "./helpers/config.js";

describe("suggestions parsing", () => {
  it("strips internal inline artifact/chart/result placeholders", () => {
    const cleaned = stripPlaceholders(
      "本月销售额上升 12%。\n\n[[chart:chart-1]]\n\n[[result:res-1|月度明细]]\n\n\n请重点关注华东区。\n[[artifact:art-1]]",
    );
    expect(cleaned).toBe("本月销售额上升 12%。\n\n请重点关注华东区。");
  });

  it("parses valid JSON, strips numbering/quotes, dedupes, filters unsafe items, and caps at 3", () => {
    const raw = `\`\`\`json
{"suggestions":[
  "1. “查看华东区订单趋势”",
  "统计一下8月销售额",
  "2、查看华东区订单趋势",
  "按品类拆解退货原因",
  "包含密钥 sk-proj-abcdefghijklmnopqrstuvwxyz123456 的配置",
  "包含内部占位符 [[chart:c-1]]",
  "${"超长问题".repeat(25)}",
  "对比上月同期的客单价变化",
  "第四条超出上限"
]}
\`\`\``;

    expect(parseSuggestedQuestions(raw, "统计一下8月销售额")).toEqual([
      "查看华东区订单趋势",
      "按品类拆解退货原因",
      "对比上月同期的客单价变化",
    ]);
  });

  it("falls back to bare JSON array and returns empty on invalid output", () => {
    expect(parseSuggestedQuestions('["看下分渠道占比", "- 看下复购率"]')).toEqual([
      "看下分渠道占比",
      "看下复购率",
    ]);
    expect(parseSuggestedQuestions("不是 JSON 内容")).toEqual([]);
  });
});

let root: string;
let db: Db;
let userId: string;
let otherUserId: string;
let noChatUserId: string;
let datasourceId: string;
let conversationId: string;
let cookie: string;
let otherCookie: string;
let noChatCookie: string;

const fakeRuntime = {
  bus: new RunEventBus(),
  abort: vi.fn(() => true),
  remove: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
  getOrCreate: vi.fn(() => ({ enqueue: () => 1 })),
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-suggestions-"));
  db = createDb(":memory:").db;
  migrateDb(db);

  const signer = createSessionSigner(testConfig.appSecret);
  userId = randomUUID();
  otherUserId = randomUUID();
  noChatUserId = randomUUID();
  for (const [id, username] of [
    [userId, "alice"],
    [otherUserId, "bob"],
    [noChatUserId, "charlie"],
  ] as const) {
    insertUser(db, {
      id,
      username,
      passwordHash: await hashPassword(`${username}-pass-123`),
      role: "user",
      createdAt: Date.now(),
    });
  }
  const chatRole = createRole(db, { name: "chat-user", permissions: ["chat.use"] });
  const noChatRole = createRole(db, { name: "report-only", permissions: ["report.create"] });
  setUserRoles(db, userId, [chatRole.id]);
  setUserRoles(db, otherUserId, [chatRole.id]);
  setUserRoles(db, noChatUserId, [noChatRole.id]);

  cookie = await signer.sign({ sub: userId, username: "alice", role: "user" });
  otherCookie = await signer.sign({ sub: otherUserId, username: "bob", role: "user" });
  noChatCookie = await signer.sign({ sub: noChatUserId, username: "charlie", role: "user" });

  datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "销售分析库",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "sales",
    username: "reader",
    passwordCipher: "cipher",
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  replaceGrants(db, datasourceId, [userId]);
  conversationId = createConversation(db, { userId, datasourceId }).id;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeApp(suggestionsGenerator: (prompt: string) => Promise<string>) {
  return buildApp({
    config: {
      ...testConfig,
      dataDir: root,
      agentAuthPath: path.join(root, "agent", "auth.json"),
    },
    db,
    enableRateLimit: false,
    agentRuntime: fakeRuntime as unknown as RuntimeManager,
    suggestionsGenerator,
  });
}

function seedRun(options: {
  status?: "ok" | "error" | "aborted" | "running";
  userText?: string;
  assistantText?: string;
  ownerId?: string;
}): string {
  const owner = options.ownerId ?? userId;
  const status = options.status ?? "ok";
  const runId = createRun(db, { conversationId, userId: owner }).id;
  appendRunEvent(db, {
    runId,
    conversationId,
    type: "user_message",
    payload: { content: options.userText ?? "统计 8 月销售额 [[chart:should-strip]]" },
  });
  if (options.assistantText !== undefined) {
    appendRunEvent(db, {
      runId,
      conversationId,
      type: "assistant_message",
      payload: { content: options.assistantText },
    });
  } else if (status === "ok") {
    appendRunEvent(db, {
      runId,
      conversationId,
      type: "assistant_message",
      payload: { content: "8 月销售额为 100 万元。\n\n[[chart:chart-1]]\n\n[[result:res-1|明细]]" },
    });
  }
  markRun(db, runId, { status, endedAt: status === "running" ? null : Date.now() });
  return runId;
}

describe("GET /api/runs/:id/suggestions", () => {
  it("enforces auth, chat.use permission, ownership, and UUID validation", async () => {
    const runId = seedRun({ status: "ok" });
    const generator = vi.fn(async () => '{"suggestions":["看下分品类对比"]}');
    const app = await makeApp(generator);
    try {
      const unauth = await app.inject({ method: "GET", url: `/api/runs/${runId}/suggestions` });
      expect(unauth.statusCode).toBe(401);

      const badId = await app.inject({
        method: "GET",
        url: "/api/runs/not-a-uuid/suggestions",
        cookies: { dc_session: cookie },
      });
      expect(badId.statusCode).toBe(400);

      const forbiddenRunId = createRun(db, {
        conversationId: createConversation(db, { userId: noChatUserId, datasourceId }).id,
        userId: noChatUserId,
      }).id;
      const forbidden = await app.inject({
        method: "GET",
        url: `/api/runs/${forbiddenRunId}/suggestions`,
        cookies: { dc_session: noChatCookie },
      });
      expect(forbidden.statusCode).toBe(403);

      const foreign = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/suggestions`,
        cookies: { dc_session: otherCookie },
      });
      expect(foreign.statusCode).toBe(404);
      expect(generator).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("hides runs excluded by datasource data scope", async () => {
    const runId = seedRun({ status: "ok" });
    db.update(datasources)
      .set({ dataScopeMode: "enabled" })
      .where(eq(datasources.id, datasourceId))
      .run();
    const generator = vi.fn(async () => '{"suggestions":["不应生成"]}');
    const app = await makeApp(generator);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/suggestions`,
        cookies: { dc_session: cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(generator).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns empty suggestions without calling generator for non-ok runs", async () => {
    const errorRunId = seedRun({ status: "error" });
    const abortedRunId = seedRun({ status: "aborted" });
    const runningRunId = seedRun({ status: "running" });
    const generator = vi.fn(async () => '{"suggestions":["不应调用"]}');
    const app = await makeApp(generator);
    try {
      for (const id of [errorRunId, abortedRunId, runningRunId]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/runs/${id}/suggestions`,
          cookies: { dc_session: cookie },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ suggestions: [] });
      }
      expect(generator).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("generates once, deduplicates concurrent calls, caches in DB, and replays in conversation detail", async () => {
    const runId = seedRun({ status: "ok" });
    let resolvePrompt!: (value: string) => void;
    const generator = vi.fn<(prompt: string) => Promise<string>>(
      (_prompt) =>
        new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const app = await makeApp(generator);
    try {
      // Before suggestions exist, conversation detail marks this completed turn eligible (`null`).
      const beforeDetail = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: cookie },
      });
      expect(beforeDetail.statusCode).toBe(200);
      expect(beforeDetail.json().messages[0].suggestions).toBeNull();

      const firstPromise = app.inject({
        method: "GET",
        url: `/api/runs/${runId}/suggestions`,
        cookies: { dc_session: cookie },
      });
      const secondPromise = app.inject({
        method: "GET",
        url: `/api/runs/${runId}/suggestions`,
        cookies: { dc_session: cookie },
      });

      await vi.waitFor(() => expect(generator).toHaveBeenCalledTimes(1));
      const sentPrompt = generator.mock.calls[0]?.[0] ?? "";
      expect(sentPrompt).toContain("数据源「销售分析库」");
      expect(sentPrompt).not.toContain("[[chart:chart-1]]");
      expect(sentPrompt).not.toContain("[[result:res-1");

      resolvePrompt('{"suggestions":["按品类拆解 8 月销售额","对比 7 月增长幅度"]}');
      const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
      expect(firstRes.statusCode).toBe(200);
      expect(secondRes.statusCode).toBe(200);
      expect(firstRes.json()).toEqual({
        suggestions: ["按品类拆解 8 月销售额", "对比 7 月增长幅度"],
      });
      expect(secondRes.json()).toEqual(firstRes.json());
      expect(JSON.parse(findRun(db, runId)?.suggestionsJson ?? "null")).toEqual([
        "按品类拆解 8 月销售额",
        "对比 7 月增长幅度",
      ]);

      // Subsequent request and conversation reload read cached DB value without another call.
      const thirdRes = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/suggestions`,
        cookies: { dc_session: cookie },
      });
      expect(thirdRes.json()).toEqual(firstRes.json());
      expect(generator).toHaveBeenCalledTimes(1);

      const afterDetail = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: cookie },
      });
      expect(afterDetail.json().messages[0].suggestions).toEqual([
        "按品类拆解 8 月销售额",
        "对比 7 月增长幅度",
      ]);
    } finally {
      await app.close();
    }
  });

  it("caches empty array when generator fails so broken calls do not retry infinitely", async () => {
    const runId = seedRun({ status: "ok" });
    const generator = vi.fn(async () => {
      throw new Error("upstream timeout");
    });
    const app = await makeApp(generator);
    try {
      const first = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/suggestions`,
        cookies: { dc_session: cookie },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ suggestions: [] });

      const second = await app.inject({
        method: "GET",
        url: `/api/runs/${runId}/suggestions`,
        cookies: { dc_session: cookie },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ suggestions: [] });
      expect(generator).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
