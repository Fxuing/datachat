import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  createConversation,
  deleteConversation,
  findConversation,
  findOwnedConversation,
  listConversations,
  touchConversation,
  updateConversation,
} from "../src/db/repositories/conversations.js";
import { appendRunEvent } from "../src/db/repositories/run-events.js";
import { createRun } from "../src/db/repositories/runs.js";
import { artifacts, runEvents, runs } from "../src/db/schema.js";

let db: Db;
const userId = "user-1";

beforeEach(() => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
});

function newConversation(overrides: Partial<Parameters<typeof createConversation>[1]> = {}) {
  return createConversation(db, {
    userId,
    datasourceId: "ds-1",
    title: "First chat",
    modelId: "deepseek-ai/DeepSeek-V3.2",
    ...overrides,
  });
}

describe("conversations repository", () => {
  it("creates a conversation with plan defaults", () => {
    const before = Date.now();
    const row = newConversation();

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row).toMatchObject({
      userId,
      datasourceId: "ds-1",
      title: "First chat",
      modelId: "deepseek-ai/DeepSeek-V3.2",
      status: "active",
      thinkingLevel: "off",
      piSessionFile: null,
      lastMessageAt: null,
    });
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.updatedAt).toBe(row.createdAt);
  });

  it("finds rows by id and enforces ownership", () => {
    const row = newConversation();

    expect(findConversation(db, row.id)?.id).toBe(row.id);
    expect(findOwnedConversation(db, row.id, userId)?.id).toBe(row.id);
    expect(findOwnedConversation(db, row.id, "someone-else")).toBeUndefined();
    expect(findConversation(db, "missing")).toBeUndefined();
  });

  it("lists newest activity first and honours the before cursor", () => {
    const older = newConversation({ title: "older" });
    const middle = newConversation({ title: "middle" });
    const newest = newConversation({ title: "newest" });
    touchConversation(db, older.id, 1_000);
    touchConversation(db, middle.id, 2_000);
    touchConversation(db, newest.id, 3_000);

    const all = listConversations(db, userId);
    expect(all.map((row) => row.title)).toEqual(["newest", "middle", "older"]);

    const page = listConversations(db, userId, { limit: 2 });
    expect(page.map((row) => row.title)).toEqual(["newest", "middle"]);

    const next = listConversations(db, userId, { before: 2_000 });
    expect(next.map((row) => row.title)).toEqual(["older"]);
    // Other users never see the list.
    expect(listConversations(db, "someone-else")).toEqual([]);
  });

  it("updates only provided fields and keeps updatedAt moving", () => {
    const row = newConversation();

    updateConversation(db, row.id, { title: "Renamed" });
    const renamed = findConversation(db, row.id);
    expect(renamed?.title).toBe("Renamed");
    expect(renamed?.modelId).toBe(row.modelId);
    expect(renamed?.updatedAt).toBeGreaterThanOrEqual(row.updatedAt);

    updateConversation(db, row.id, {
      modelId: "zai-org/GLM-5.3",
      piSessionFile: "/tmp/session.jsonl",
    });
    expect(findConversation(db, row.id)).toMatchObject({
      title: "Renamed",
      modelId: "zai-org/GLM-5.3",
      piSessionFile: "/tmp/session.jsonl",
    });

    updateConversation(db, row.id, { title: null });
    expect(findConversation(db, row.id)?.title).toBeNull();
  });

  it("touches lastMessageAt for ordering", () => {
    const row = newConversation();
    touchConversation(db, row.id, 12_345);

    const touched = findConversation(db, row.id);
    expect(touched?.lastMessageAt).toBe(12_345);
    expect(touched?.updatedAt).toBe(12_345);
  });

  it("deletes runs, events and artifacts together with the conversation", () => {
    const row = newConversation();
    const run = createRun(db, { conversationId: row.id, userId, modelId: "m" });
    appendRunEvent(db, {
      runId: run.id,
      conversationId: row.id,
      type: "run_queued",
      payload: { position: 1 },
    });
    db.insert(artifacts)
      .values({
        id: randomUUID(),
        conversationId: row.id,
        userId,
        runId: run.id,
        kind: "result",
        createdAt: Date.now(),
      })
      .run();

    deleteConversation(db, row.id);

    expect(findConversation(db, row.id)).toBeUndefined();
    expect(db.select().from(runs).where(eq(runs.conversationId, row.id)).all()).toEqual([]);
    expect(
      db.select().from(runEvents).where(eq(runEvents.conversationId, row.id)).all(),
    ).toEqual([]);
    expect(
      db.select().from(artifacts).where(eq(artifacts.conversationId, row.id)).all(),
    ).toEqual([]);
  });
});
