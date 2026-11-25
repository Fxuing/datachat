import { describe, expect, it } from "vitest";
import type { RunEvent } from "@datachat/shared";
import {
  initialRunStreamState,
  runStreamReducer,
  type RunStreamState,
} from "./run-events";

function apply(state: RunStreamState, seq: number, event: RunEvent): RunStreamState {
  return runStreamReducer(state, { type: "event", seq, event });
}

describe("runStreamReducer", () => {
  it("concatenates text deltas without duplicating the aggregated message", () => {
    let state = apply(initialRunStreamState, 1, {
      type: "run_start",
      payload: { startedAt: 1_700_000_000_000 },
    });
    state = apply(state, 2, { type: "text_delta", payload: { text: "你好" } });
    state = apply(state, 3, { type: "text_delta", payload: { text: "，世界" } });

    expect(state.text).toBe("你好，世界");
    expect(state.status).toBe("running");

    state = apply(state, 4, { type: "assistant_message", payload: { content: "你好，世界" } });
    expect(state.text).toBe("你好，世界");
    expect(state.finalText).toBe("你好，世界");
  });

  it("starts a new reasoning segment at every tool call", () => {
    let state = apply(initialRunStreamState, 1, {
      type: "thinking_delta",
      payload: { text: "先确认表结构。" },
    });
    state = apply(state, 2, {
      type: "tool_start",
      payload: { toolCallId: "call-1", name: "db_schema", args: { table: "users" } },
    });
    state = apply(state, 3, {
      type: "thinking_delta",
      payload: { text: "表里没有 channel 字段。" },
    });

    expect(state.thinkingSegments).toEqual(["先确认表结构。", "表里没有 channel 字段。"]);
  });

  it("keeps one entry per memory even when a reconnect replays the event", () => {
    const event = {
      type: "memory_used" as const,
      payload: {
        memories: [
          { id: "mem-1", kind: "preference" as const, content: "默认柱状图", core: true, scope: "全局" },
          { id: "mem-2", kind: "fact" as const, content: "只算已支付", core: false },
        ],
      },
    };

    let state = apply(initialRunStreamState, 1, event);
    expect(state.memories.map((memory) => memory.id)).toEqual(["mem-1", "mem-2"]);

    state = apply(state, 2, event);
    expect(state.memories).toHaveLength(2);
    expect(state.memories[0]?.scope).toBe("全局");
  });

  it("tracks tool start/end updates in place and preserves arguments", () => {
    let state = apply(initialRunStreamState, 1, {
      type: "tool_start",
      payload: { toolCallId: "call-1", name: "db_query", args: { sql: "select 1" } },
    });
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ status: "running", name: "db_query" });

    state = apply(state, 2, {
      type: "tool_end",
      payload: {
        toolCallId: "call-1",
        name: "db_query",
        isError: false,
        durationMs: 120,
        summary: "1 行",
      },
    });
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({
      status: "ok",
      durationMs: 120,
      summary: "1 行",
      args: { sql: "select 1" },
    });

    state = apply(state, 3, {
      type: "tool_end",
      payload: {
        toolCallId: "call-2",
        name: "db_schema",
        isError: true,
        durationMs: 30,
        summary: "连接失败",
      },
    });
    expect(state.tools).toHaveLength(2);
    expect(state.tools[1]).toMatchObject({ status: "error", summary: "连接失败" });
  });

  it("dedupes sql and result events by audit/artifact id", () => {
    let state = apply(initialRunStreamState, 1, {
      type: "sql",
      payload: { sql: "select 1", auditId: "audit-1", status: "ok" },
    });
    state = apply(state, 2, {
      type: "result",
      payload: {
        artifactId: "artifact-1",
        columns: [{ name: "n", type: "number" }],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
      },
    });
    state = apply(state, 3, {
      type: "sql",
      payload: { sql: "select 2", auditId: "audit-1", status: "rejected" },
    });
    state = apply(state, 4, {
      type: "result",
      payload: {
        artifactId: "artifact-1",
        columns: [{ name: "n", type: "number" }],
        rows: [[1], [2]],
        rowCount: 2,
        truncated: false,
      },
    });
    state = apply(state, 5, {
      type: "sql",
      payload: { sql: "select 3", auditId: "audit-2", status: "error" },
    });

    expect(state.sqls).toHaveLength(2);
    expect(state.sqls[0]).toMatchObject({ auditId: "audit-1", sql: "select 2", status: "rejected" });
    expect(state.results).toHaveLength(1);
    expect(state.results[0]).toMatchObject({ artifactId: "artifact-1", rowCount: 2 });
  });

  it("collects chart events by chart artifact id and dedupes replays", () => {
    const chart = {
      type: "chart" as const,
      payload: {
        chartArtifactId: "chart-1",
        spec: { option: { series: [] }, chart: { type: "bar", x: "month", y: "total" } },
        points: 3,
        title: "每月订单金额",
      },
    };

    let state = apply(initialRunStreamState, 1, {
      type: "chart",
      payload: {
        chartArtifactId: "chart-0",
        spec: { option: { series: [] } },
        points: 1,
        title: "旧图",
      },
    });
    state = apply(state, 2, chart);
    state = apply(state, 3, chart);

    expect(state.charts).toHaveLength(2);
    expect(state.charts[0]).toMatchObject({ chartArtifactId: "chart-0", title: "旧图" });
    expect(state.charts[1]).toMatchObject({
      chartArtifactId: "chart-1",
      points: 3,
      title: "每月订单金额",
    });
    expect(state.charts[1]?.spec).toMatchObject({ chart: { type: "bar" } });

    // Same artifact id on a new seq updates in place instead of appending twice.
    state = apply(state, 4, { ...chart, payload: { ...chart.payload, points: 5 } });
    expect(state.charts).toHaveLength(2);
    expect(state.charts[1]).toMatchObject({ chartArtifactId: "chart-1", points: 5 });

    // A stale seq never reaches the chart branch, so a reconnect replay cannot duplicate.
    const before = state;
    state = apply(state, 3, chart);
    expect(state).toBe(before);
  });

  it("collects excel events by artifact id and dedupes replays", () => {
    const excelEvent: RunEvent = {
      type: "excel",
      payload: {
        excelArtifactId: "xls-1",
        filename: "2025年Q1销售",
        sheets: [
          { name: "区域汇总", artifactId: "r-1", rowCount: 4 },
          { name: "订单明细", artifactId: "r-2", rowCount: 120 },
        ],
        totalRows: 124,
      },
    };
    let state = apply(initialRunStreamState, 1, excelEvent);
    expect(state.excels).toEqual([excelEvent.payload]);

    state = apply(state, 2, {
      ...excelEvent,
      payload: { ...excelEvent.payload, filename: "更新名称" },
    });
    expect(state.excels).toHaveLength(1);
    expect(state.excels[0]?.filename).toBe("更新名称");

    const before = state;
    state = apply(state, 2, excelEvent);
    expect(state).toBe(before);
  });

  it("clears the previous attempt's text when a retry starts", () => {
    let state = apply(initialRunStreamState, 1, {
      type: "run_start",
      payload: { startedAt: 9 },
    });
    state = apply(state, 2, { type: "text_delta", payload: { text: "partial answer" } });
    state = apply(state, 3, { type: "thinking_delta", payload: { text: "thinking" } });
    state = apply(state, 4, { type: "assistant_message", payload: { content: "partial" } });

    state = apply(state, 5, {
      type: "retry",
      payload: { attempt: 2, delayMs: 100, message: "overloaded" },
    });

    expect(state.text).toBe("");
    expect(state.thinkingSegments).toEqual([""]);
    expect(state.finalText).toBeNull();
    expect(state.notices).toHaveLength(1);

    state = apply(state, 6, { type: "text_delta", payload: { text: "final answer" } });
    expect(state.text).toBe("final answer");
  });

  it("settles the run on run_end and ignores stale sequence numbers", () => {
    let state = apply(initialRunStreamState, 1, {
      type: "run_queued",
      payload: { position: 3 },
    });
    expect(state).toMatchObject({ status: "queued", queuePosition: 3 });

    state = apply(state, 2, { type: "run_start", payload: { startedAt: 5 } });
    expect(state).toMatchObject({ status: "running", queuePosition: null });

    state = apply(state, 2, { type: "text_delta", payload: { text: "stale" } });
    expect(state.text).toBe("");

    state = apply(state, 3, { type: "text_delta", payload: { text: "最终回答" } });
    state = apply(state, 4, { type: "run_end", payload: { status: "ok" } });
    expect(state).toMatchObject({
      status: "ok",
      text: "最终回答",
      connection: "closed",
      error: null,
    });

    const failed = runStreamReducer(
      apply(initialRunStreamState, 1, { type: "run_start", payload: { startedAt: 9 } }),
      { type: "event", seq: 2, event: { type: "run_end", payload: { status: "error", error: "执行失败" } } },
    );
    expect(failed).toMatchObject({ status: "error", error: "执行失败", connection: "closed" });
  });
});
