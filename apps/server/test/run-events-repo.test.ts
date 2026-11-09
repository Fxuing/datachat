import { beforeEach, describe, expect, it } from "vitest";
import { runEventSchema } from "@datachat/shared";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { runEvents } from "../src/db/schema.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import {
  appendRunEvent,
  listConversationEvents,
  listRunEventsAfter,
} from "../src/db/repositories/run-events.js";
import { createRun, findOwnedRun, findRun, listQueuedRuns, markRun } from "../src/db/repositories/runs.js";

let db: Db;
let conversationId: string;
const userId = "user-1";

beforeEach(() => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  conversationId = createConversation(db, { userId, datasourceId: "ds-1" }).id;
});

function newRun() {
  return createRun(db, {
    conversationId,
    userId,
    modelId: "deepseek-ai/DeepSeek-V3.2",
  });
}

describe("runs repository", () => {
  it("creates queued runs owned by the requesting user", () => {
    const run = newRun();

    expect(run).toMatchObject({
      conversationId,
      userId,
      modelId: "deepseek-ai/DeepSeek-V3.2",
      status: "queued",
      inputTokens: null,
      outputTokens: null,
      error: null,
      startedAt: null,
      endedAt: null,
    });
    expect(findRun(db, run.id)?.id).toBe(run.id);
    expect(findOwnedRun(db, run.id, userId)?.id).toBe(run.id);
    expect(findOwnedRun(db, run.id, "someone-else")).toBeUndefined();
  });

  it("moves through queued → running → ok and records usage", () => {
    const run = newRun();
    markRun(db, run.id, { status: "running", startedAt: 1_000 });

    expect(findRun(db, run.id)).toMatchObject({ status: "running", startedAt: 1_000, endedAt: null });
    expect(listQueuedRuns(db, conversationId)).toEqual([]);

    markRun(db, run.id, {
      status: "ok",
      endedAt: 2_000,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    });

    expect(findRun(db, run.id)).toMatchObject({
      status: "ok",
      startedAt: 1_000,
      endedAt: 2_000,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      error: null,
    });
  });

  it("records terminal errors and can clear them", () => {
    const run = newRun();
    markRun(db, run.id, { status: "error", endedAt: 5, error: "upstream 502" });
    expect(findRun(db, run.id)?.error).toBe("upstream 502");

    markRun(db, run.id, { error: null });
    expect(findRun(db, run.id)?.error).toBeNull();
  });

  it("lists only queued runs oldest first", async () => {
    const first = newRun();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = newRun();
    const running = newRun();
    markRun(db, running.id, { status: "running" });

    expect(listQueuedRuns(db, conversationId).map((run) => run.id)).toEqual([
      first.id,
      second.id,
    ]);
  });
});

describe("run events repository", () => {
  it("starts seq at 1 and increments monotonically per run", () => {
    const run = newRun();

    const first = appendRunEvent(db, {
      runId: run.id,
      conversationId,
      type: "run_queued",
      payload: { position: 1 },
    });
    const second = appendRunEvent(db, {
      runId: run.id,
      conversationId,
      type: "run_start",
      payload: { startedAt: Date.now() },
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(typeof first.createdAt).toBe("number");
  });

  it("keeps sequences independent per run", () => {
    const one = newRun();
    const two = newRun();

    appendRunEvent(db, { runId: one.id, conversationId, type: "run_queued", payload: { position: 1 } });
    appendRunEvent(db, { runId: one.id, conversationId, type: "run_start", payload: { startedAt: 1 } });
    const other = appendRunEvent(db, {
      runId: two.id,
      conversationId,
      type: "run_queued",
      payload: { position: 2 },
    });

    expect(other.seq).toBe(1);
  });

  it("serializes concurrent appends without duplicate seq values", async () => {
    const run = newRun();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve().then(() =>
          appendRunEvent(db, {
            runId: run.id,
            conversationId,
            type: "text_delta",
            payload: { text: `chunk-${index}` },
          }),
        ),
      ),
    );

    const seqs = results.map((result) => result.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(listRunEventsAfter(db, run.id, 0)).toHaveLength(20);
  });

  it("replays events after a Last-Event-ID cursor", () => {
    const run = newRun();
    for (const type of ["run_queued", "run_start", "text_delta", "run_end"] as const) {
      appendRunEvent(db, { runId: run.id, conversationId, type, payload: {} });
    }

    expect(listRunEventsAfter(db, run.id, 0).map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(listRunEventsAfter(db, run.id, 2).map((row) => row.seq)).toEqual([3, 4]);
    expect(listRunEventsAfter(db, run.id, 99)).toEqual([]);
  });

  it("round-trips typed payloads and validates the shared schema", () => {
    const run = newRun();
    appendRunEvent(db, {
      runId: run.id,
      conversationId,
      type: "assistant_message",
      payload: { content: "done" },
    });
    appendRunEvent(db, {
      runId: run.id,
      conversationId,
      type: "result",
      payload: {
        artifactId: "artifact-1",
        columns: [{ name: "id", type: "number" }],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
      },
    });

    const rows = listRunEventsAfter(db, run.id, 0);
    const parsed = rows.map((row) => runEventSchema.parse({ type: row.type, payload: JSON.parse(row.payloadJson) }));
    expect(parsed[0]).toEqual({ type: "assistant_message", payload: { content: "done" } });
    expect(parsed[1]?.type).toBe("result");

    // unknown event types are rejected by the contract
    expect(
      runEventSchema.safeParse({ type: "assistant_message", payload: {} }).success,
    ).toBe(false);
  });

  it("orders conversation history by time, not seq across runs", () => {
    const earlier = newRun();
    const later = newRun();
    db.insert(runEvents)
      .values([
        {
          id: "event-earlier",
          runId: earlier.id,
          conversationId,
          seq: 1,
          type: "text_delta",
          payloadJson: JSON.stringify({ text: "earlier" }),
          createdAt: 1_000,
        },
        {
          id: "event-later",
          runId: later.id,
          conversationId,
          seq: 9,
          type: "text_delta",
          payloadJson: JSON.stringify({ text: "later" }),
          createdAt: 2_000,
        },
      ])
      .run();

    expect(
      listConversationEvents(db, conversationId).map(
        (row) => (JSON.parse(row.payloadJson) as { text: string }).text,
      ),
    ).toEqual(["earlier", "later"]);
  });

  it("returns the latest conversation events oldest-first", () => {
    const run = newRun();
    for (let index = 1; index <= 5; index += 1) {
      appendRunEvent(db, {
        runId: run.id,
        conversationId,
        type: "text_delta",
        payload: { text: String(index) },
      });
    }

    const rows = listConversationEvents(db, conversationId, 3);
    expect(rows.map((row) => row.seq)).toEqual([3, 4, 5]);
    expect(rows.map((row) => (JSON.parse(row.payloadJson) as { text: string }).text)).toEqual([
      "3",
      "4",
      "5",
    ]);
    expect(listConversationEvents(db, "other-conversation")).toEqual([]);
  });

  it("skips thinking deltas so the user message survives the window", () => {
    const run = newRun();
    appendRunEvent(db, {
      runId: run.id,
      conversationId,
      type: "user_message",
      payload: { content: "分析一下" },
    });
    for (let index = 0; index < 2_500; index += 1) {
      appendRunEvent(db, {
        runId: run.id,
        conversationId,
        type: "thinking_delta",
        payload: { text: `step ${index}` },
      });
    }
    appendRunEvent(db, {
      runId: run.id,
      conversationId,
      type: "text_delta",
      payload: { text: "结论" },
    });

    const rows = listConversationEvents(db, conversationId, 2_000);
    expect(rows.map((row) => row.type)).toEqual(["user_message", "text_delta"]);
  });
});
