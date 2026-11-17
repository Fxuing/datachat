import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { datasources } from "../src/db/schema.js";
import { insertUser } from "../src/db/repositories/users.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { createRun, markRun } from "../src/db/repositories/runs.js";
import { appendRunEvent } from "../src/db/repositories/run-events.js";
import {
  listUserMemories,
  setUserMemorySettings,
  upsertUserMemory,
} from "../src/db/repositories/user-memories.js";
import { extractMemoriesForRun } from "../src/memory/extraction.js";

let handle: DbHandle;

beforeEach(() => {
  handle = createDb(":memory:");
  migrateDb(handle.db);
  handle.db.insert(datasources).values({
    id: "ds-1", name: "示例商城", type: "mysql", host: "localhost", port: 3306,
    database: "demo", username: "reader", passwordCipher: "cipher", createdBy: "seed",
    createdAt: 1, updatedAt: 1,
  }).run();
});

afterEach(() => handle.sqlite.close());

function fixture() {
  const user = insertUser(handle.db, {
    id: "extract-user", username: "extract-user", passwordHash: "x", role: "user", createdAt: 1,
  });
  const conversation = createConversation(handle.db, { userId: user.id, datasourceId: "ds-1" });
  const run = createRun(handle.db, {
    conversationId: conversation.id, userId: user.id, modelId: "deepseek::chat",
  });
  markRun(handle.db, run.id, { status: "ok", startedAt: 1, endedAt: 2 });
  appendRunEvent(handle.db, {
    runId: run.id, conversationId: conversation.id, type: "user_message",
    payload: { content: "以后金额都按万元展示" },
  });
  appendRunEvent(handle.db, {
    runId: run.id, conversationId: conversation.id, type: "assistant_message",
    payload: { content: "好的，已按万元口径回答。" },
  });
  return { user, conversation, run };
}

describe("memory extraction", () => {
  it("extracts and saves valid memories with the run as source", async () => {
    const { user, conversation, run } = fixture();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      memories: [
        { kind: "preference", title: "金额单位", content: "金额按万元展示", scope: "global", confidence: 90 },
        { kind: "fact", title: "订单口径", content: "只统计已支付订单", scope: "datasource", confidence: 80 },
        { kind: "preference", title: "无效", content: "token=abcdefgh", scope: "global", confidence: 90 },
        { kind: "fact", title: "超出", content: "第四条", scope: "global", confidence: 90 },
      ],
    }));

    const result = await extractMemoriesForRun({
      db: handle.db, runId: run.id, generate, now: () => 100,
    });
    expect(result).toMatchObject({ status: "extracted", saved: 2 });
    const memories = listUserMemories(handle.db, user.id);
    expect(memories).toHaveLength(2);
    expect(memories.map((row) => row.title)).toEqual(expect.arrayContaining(["金额单位", "订单口径"]));
    expect(memories.find((row) => row.title === "订单口径")?.datasourceId).toBe("ds-1");
    expect(memories[0]?.sourceRunId).toBe(run.id);
    expect(memories[0]?.sourceConversationId).toBe(conversation.id);
    expect(handle.db.get<{ memory_extracted_at: number }>(
      sql`select memory_extracted_at from runs where id = ${run.id}`,
    )?.memory_extracted_at).toBe(100);
  });

  it("skips a run that already wrote a memory through the tool", async () => {
    const { user, run } = fixture();
    upsertUserMemory(handle.db, {
      userId: user.id, kind: "preference", title: "手动", content: "已记住", scope: "global",
      sourceRunId: run.id,
    });
    const generate = vi.fn();
    const result = await extractMemoriesForRun({ db: handle.db, runId: run.id, generate });
    expect(result.reason).toBe("already_saved");
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not extract when the user disabled memory", async () => {
    const { user, run } = fixture();
    setUserMemorySettings(handle.db, user.id, false);
    const generate = vi.fn();
    const result = await extractMemoriesForRun({ db: handle.db, runId: run.id, generate });
    expect(result.reason).toBe("disabled");
    expect(generate).not.toHaveBeenCalled();
  });

  it("marks failed runs and malformed JSON without throwing", async () => {
    const { run } = fixture();
    const generate = vi.fn().mockResolvedValue("not json");
    const result = await extractMemoriesForRun({ db: handle.db, runId: run.id, generate });
    expect(result.status).toBe("extracted");
    expect(result.saved).toBe(0);
  });
});
