import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { runEventSchema, type RunEvent } from "@datachat/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { bridgeSessionEvents } from "../src/agent/event-bridge.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { listRunEventsAfter } from "../src/db/repositories/run-events.js";
import { createRun } from "../src/db/repositories/runs.js";
import { asAgentSession, FakeAgentSession } from "./helpers/fake-agent-session.js";

let db: Db;
let conversationId: string;
let runId: string;

beforeEach(() => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  conversationId = createConversation(db, { userId: "user-1", datasourceId: "ds-1" }).id;
  runId = createRun(db, {
    conversationId,
    userId: "user-1",
    modelId: "deepseek-ai/DeepSeek-V3.2",
  }).id;
});

function assistantMessage(text: string, usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { ...usage, totalTokens: usage.input + usage.output, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "stop",
    api: "openai-completions",
    provider: "siliconflow",
    model: "deepseek-ai/DeepSeek-V3.2",
    timestamp: Date.now(),
  };
}

function setup() {
  const session = new FakeAgentSession();
  const emitted: Array<RunEvent & { seq: number }> = [];
  const bridge = bridgeSessionEvents({
    db,
    runId,
    conversationId,
    session: asAgentSession(session),
    emit: (event) => emitted.push(event),
  });
  return { session, emitted, bridge };
}

function send(session: FakeAgentSession, event: unknown): void {
  session.emit(event as AgentSessionEvent);
}

function stored() {
  return listRunEventsAfter(db, runId, 0).map((row) => ({
    seq: row.seq,
    event: runEventSchema.parse({ type: row.type, payload: JSON.parse(row.payloadJson) }),
  }));
}

describe("bridgeSessionEvents", () => {
  it("persists text/thinking deltas with increasing seq", () => {
    const { session, emitted } = setup();

    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "你好" },
    });
    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "思考中" },
    });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual(["text_delta", "thinking_delta"]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows[0]?.event.payload).toEqual({ text: "你好" });
    expect(emitted.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("aggregates assistant text and usage, then ends the run", () => {
    const { session, bridge } = setup();

    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "你好" },
    });
    const message = assistantMessage("你好，有什么可以帮你？");
    send(session, { type: "message_end", message });
    send(session, { type: "agent_end", messages: [message], willRetry: false });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual([
      "text_delta",
      "assistant_message",
      "usage",
      "run_end",
    ]);
    expect(rows[1]?.event.payload).toEqual({ content: "你好，有什么可以帮你？" });
    expect(rows[2]?.event.payload).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
    expect(rows[3]?.event.payload).toEqual({ status: "ok" });
    expect(bridge.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
    expect(session.listenerCount).toBe(1);
  });

  it("keeps reasoning recorded around a tool call in separate paragraphs", () => {
    const { session } = setup();

    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "先看表结构，" },
    });
    send(session, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "db_schema",
      args: { table: "users" },
    });
    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "再统计。" },
    });
    const message = assistantMessage("共有 3 行。");
    send(session, { type: "message_end", message });
    send(session, { type: "agent_end", messages: [message], willRetry: false });

    const thinking = stored().find((row) => row.event.type === "thinking");
    expect(thinking?.event.payload).toEqual({
      content: "先看表结构，\n\n再统计。",
      segments: ["先看表结构，", "再统计。"],
    });
  });

  it("persists the full thinking transcript once the run ends", () => {
    const { session } = setup();

    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "先确认表结构，" },
    });
    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "再统计。" },
    });
    const message = assistantMessage("共有 3 行。");
    send(session, { type: "message_end", message });
    send(session, { type: "agent_end", messages: [message], willRetry: false });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual([
      "thinking_delta",
      "thinking_delta",
      "thinking",
      "assistant_message",
      "usage",
      "run_end",
    ]);
    expect(rows[2]?.event.payload).toEqual({
      content: "先确认表结构，再统计。",
      segments: ["先确认表结构，再统计。"],
    });
  });

  it("does not persist an assistant message while the agent will retry", () => {
    const { session } = setup();
    const message = assistantMessage("partial");

    send(session, { type: "agent_end", messages: [message], willRetry: true });

    expect(stored().map((row) => row.event.type)).toEqual(["usage"]);
  });

  it("keeps only the final attempt's text across a retry", () => {
    const { session } = setup();

    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "first attempt " },
    });
    const first = assistantMessage("first attempt", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
    send(session, { type: "message_end", message: first });
    send(session, { type: "agent_end", messages: [first], willRetry: true });
    send(session, {
      type: "auto_retry_start",
      attempt: 2,
      delayMs: 100,
      errorMessage: "overloaded",
    });

    send(session, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "final answer" },
    });
    const second = assistantMessage("final answer", { input: 20, output: 10, cacheRead: 1, cacheWrite: 1 });
    send(session, { type: "message_end", message: second });
    send(session, { type: "agent_end", messages: [second], willRetry: false });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual([
      "text_delta",
      "usage",
      "retry",
      "text_delta",
      "assistant_message",
      "usage",
      "run_end",
    ]);
    const assistantMessages = rows.filter((row) => row.event.type === "assistant_message");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.event.payload).toEqual({ content: "final answer" });
    expect(rows.at(-1)?.event.payload).toEqual({ status: "ok" });
  });

  it("maps db_query into tool_end, result, and sql events", () => {
    const { session } = setup();
    const columns = [{ name: "id", type: "number" }];
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            artifactId: "artifact-1",
            columns,
            rowCount: 3,
            truncated: false,
            previewRows: [[1], [2], [3]],
          }),
        },
      ],
      details: {
        artifactId: "artifact-1",
        columns,
        rowCount: 3,
        truncated: false,
        auditId: "audit-1",
        sql: "select id from users limit 3",
        guard: "ok",
      },
    };

    send(session, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "db_query",
      args: { sql: "select id from users" },
    });
    send(session, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "db_query",
      result,
      isError: false,
      durationMs: 12,
    });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual(["tool_start", "tool_end", "result", "sql"]);
    expect(rows[1]?.event.payload).toMatchObject({
      toolCallId: "call-1",
      name: "db_query",
      isError: false,
      durationMs: 12,
      summary: "3 行",
    });
    expect(rows[2]?.event.payload).toMatchObject({
      artifactId: "artifact-1",
      rows: [[1], [2], [3]],
      rowCount: 3,
      truncated: false,
    });
    expect(rows[3]?.event.payload).toEqual({
      sql: "select id from users limit 3",
      auditId: "audit-1",
      status: "ok",
    });
  });

  it("maps make_chart into a chart event", () => {
    const { session } = setup();
    const spec = { option: { series: [] }, chart: { type: "bar", x: "month", y: "amount" } };
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ chartArtifactId: "chart-1", type: "bar", points: 2, title: "amount" }),
        },
      ],
      details: { chartArtifactId: "chart-1", points: 2, title: "amount", spec },
    };

    send(session, {
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "make_chart",
      args: { artifactId: "artifact-1", type: "bar" },
    });
    send(session, {
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "make_chart",
      result,
      isError: false,
      durationMs: 5,
    });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual(["tool_start", "tool_end", "chart"]);
    expect(rows[2]?.event.payload).toEqual({
      chartArtifactId: "chart-1",
      spec,
      points: 2,
      title: "amount",
    });
  });

  it("maps create_excel into tool_end and excel events", () => {
    const { session } = setup();
    const sheets = [
      { name: "区域汇总", artifactId: "artifact-1", rowCount: 2 },
      { name: "明细", artifactId: "artifact-2", rowCount: 15 },
    ];
    const result = {
      content: [{ type: "text", text: JSON.stringify({ excelArtifactId: "excel-1" }) }],
      details: {
        excelArtifactId: "excel-1",
        filename: "2025年Q1销售",
        sheets,
        totalRows: 17,
        message: "2025年Q1销售.xlsx · 2 个工作表（17 行）",
      },
    };

    send(session, {
      type: "tool_execution_start",
      toolCallId: "call-3",
      toolName: "create_excel",
      args: { filename: "2025年Q1销售", sheets: [{ name: "区域汇总", artifactId: "artifact-1" }] },
    });
    send(session, {
      type: "tool_execution_end",
      toolCallId: "call-3",
      toolName: "create_excel",
      result,
      isError: false,
      durationMs: 8,
    });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual(["tool_start", "tool_end", "excel"]);
    expect(rows[1]?.event.payload).toMatchObject({
      toolCallId: "call-3",
      name: "create_excel",
      summary: "2025年Q1销售.xlsx · 2 个工作表（17 行）",
    });
    expect(rows[2]?.event.payload).toEqual({
      excelArtifactId: "excel-1",
      filename: "2025年Q1销售",
      sheets,
      totalRows: 17,
    });
  });

  it("maps create_report into tool_end with url and report events", () => {
    const { session } = setup();
    const result = {
      content: [{ type: "text", text: "报告已生成" }],
      details: {
        reportId: "rep-1",
        title: "2025年Q1经营分析",
        url: "/reports/rep-1",
        message: "《2025年Q1经营分析》",
      },
    };

    send(session, {
      type: "tool_execution_start",
      toolCallId: "call-4",
      toolName: "create_report",
      args: { title: "2025年Q1经营分析", markdown: "# 正文", artifactIds: ["a-1"] },
    });
    send(session, {
      type: "tool_execution_end",
      toolCallId: "call-4",
      toolName: "create_report",
      result,
      isError: false,
      durationMs: 6,
    });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual(["tool_start", "tool_end", "report"]);
    expect(rows[1]?.event.payload).toMatchObject({
      toolCallId: "call-4",
      name: "create_report",
      url: "/reports/rep-1",
      summary: "《2025年Q1经营分析》",
    });
    expect(rows[2]?.event.payload).toEqual({
      reportId: "rep-1",
      title: "2025年Q1经营分析",
    });
  });

  it("swallows event persistence failures and keeps the session subscribed", () => {
    const session = new FakeAgentSession();
    const failingDb = {
      transaction: () => {
        throw new Error("disk full");
      },
    } as unknown as Db;
    const bridge = bridgeSessionEvents({
      db: failingDb,
      runId,
      conversationId,
      session: asAgentSession(session),
      emit: () => {
        throw new Error("stream closed");
      },
    });

    expect(() =>
      send(session, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "lost" },
      }),
    ).not.toThrow();
    expect(session.listenerCount).toBe(1);
    bridge.stop();
    expect(session.listenerCount).toBe(0);
  });

  it("persists context usage reported by the session", () => {
    const { session } = setup();
    session.contextUsage = { tokens: 32_000, contextWindow: 128_000, percent: 25 };
    send(session, { type: "message_end", message: assistantMessage("hi") });

    const rows = stored();
    expect(rows.map((row) => row.event.type)).toEqual(["context_usage"]);
    expect(rows[0]?.event.payload).toEqual({
      tokens: 32_000,
      contextWindow: 128_000,
      percent: 25,
    });
  });
});
