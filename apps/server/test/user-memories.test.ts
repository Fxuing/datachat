import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  clearUserMemories,
  countMemoriesBySourceRun,
  deleteUserMemory,
  findUserMemory,
  isMemoryEnabled,
  listInjectionCandidates,
  listUserMemories,
  markRunMemoryExtracted,
  setUserMemorySettings,
  touchUserMemories,
  updateUserMemory,
  upsertUserMemory,
} from "../src/db/repositories/user-memories.js";
import { datasources, runs } from "../src/db/schema.js";
import { upsertSetting } from "../src/db/repositories/settings.js";

let handle: DbHandle;

beforeEach(() => {
  handle = createDb(":memory:");
  migrateDb(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function user(id: string) {
  return insertUser(handle.db, {
    id,
    username: id,
    passwordHash: "test-hash",
    role: "user",
    createdAt: 1,
  });
}

describe("user memories repository", () => {
  it("dedupes by kind, scope and normalized title", () => {
    const owner = user("memory-owner");
    const first = upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "preference",
      title: "金额单位",
      content: "默认万元",
      scope: "global",
      now: 100,
    });
    const second = upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "preference",
      title: " 金额单位！",
      content: "默认万元，保留两位小数",
      scope: "global",
      confidence: 95,
      now: 200,
    });

    expect(first.merged).toBe(false);
    expect(second.merged).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.content).toContain("两位小数");
    expect(second.memory.confidence).toBe(95);
    expect(listUserMemories(handle.db, owner.id)).toHaveLength(1);
  });

  it("isolates memories by user and scope", () => {
    const a = user("memory-a");
    const b = user("memory-b");
    handle.db.insert(datasources).values({
      id: "ds-1",
      name: "memory-ds",
      type: "mysql",
      host: "localhost",
      port: 3306,
      database: "demo",
      username: "reader",
      passwordCipher: "cipher",
      createdBy: a.id,
      createdAt: 1,
      updatedAt: 1,
    }).run();
    const global = upsertUserMemory(handle.db, {
      userId: a.id,
      kind: "profile",
      title: "称呼",
      content: "叫老王",
      scope: "global",
      core: true,
    });
    const scoped = upsertUserMemory(handle.db, {
      userId: a.id,
      kind: "fact",
      title: "订单定义",
      content: "只统计已支付订单",
      scope: "datasource",
      datasourceId: "ds-1",
    });

    expect(findUserMemory(handle.db, b.id, global.memory.id)).toBeNull();
    expect(listUserMemories(handle.db, b.id)).toEqual([]);
    expect(listInjectionCandidates(handle.db, a.id, "ds-1").map((row) => row.id)).toEqual(
      expect.arrayContaining([global.memory.id, scoped.memory.id]),
    );
    expect(listInjectionCandidates(handle.db, a.id, "ds-2").map((row) => row.id)).toEqual([
      global.memory.id,
    ]);
  });

  it("updates, touches, deletes and clears only the owner's rows", () => {
    const owner = user("memory-crud");
    const other = user("memory-other");
    const memory = upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "preference",
      title: "图表",
      content: "默认柱状图",
      scope: "global",
    }).memory;

    expect(updateUserMemory(handle.db, other.id, memory.id, { title: "x" })).toBeNull();
    expect(updateUserMemory(handle.db, owner.id, memory.id, { title: "图表类型", core: false })).toMatchObject({
      title: "图表类型",
    });
    touchUserMemories(handle.db, owner.id, [memory.id], 300);
    expect(findUserMemory(handle.db, owner.id, memory.id)?.useCount).toBe(1);
    expect(deleteUserMemory(handle.db, other.id, memory.id)).toBe(false);
    expect(deleteUserMemory(handle.db, owner.id, memory.id)).toBe(true);
    expect(clearUserMemories(handle.db, owner.id)).toBe(0);
  });

  it("honours user and global switches", () => {
    const owner = user("memory-switch");
    expect(isMemoryEnabled(handle.db, owner.id)).toBe(true);
    setUserMemorySettings(handle.db, owner.id, false);
    expect(isMemoryEnabled(handle.db, owner.id)).toBe(false);
    setUserMemorySettings(handle.db, owner.id, true);
    upsertSetting(handle.db, "memoryEnabled", "false");
    expect(isMemoryEnabled(handle.db, owner.id)).toBe(false);
  });

  it("archives the least valuable non-core memories above the cap", () => {
    const owner = user("memory-cap");
    for (let index = 0; index < 203; index += 1) {
      upsertUserMemory(handle.db, {
        userId: owner.id,
        kind: "fact",
        title: `memory-${index}`,
        content: `content-${index}`,
        scope: "global",
        confidence: index,
        core: index === 0,
        now: index,
      });
    }
    const enabled = listUserMemories(handle.db, owner.id).filter((row) => row.enabled === 1);
    expect(enabled).toHaveLength(200);
    expect(enabled.some((row) => row.core === 1)).toBe(true);
  });

  it("tracks extraction per run", () => {
    const owner = user("memory-run");
    handle.db.insert(runs).values({
      id: "run-memory",
      conversationId: "conv-memory",
      userId: owner.id,
      status: "ok",
      createdAt: 1,
    }).run();
    upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "preference",
      title: "金额",
      content: "万元",
      scope: "global",
      sourceRunId: "run-memory",
    });
    expect(countMemoriesBySourceRun(handle.db, "run-memory")).toBe(1);
    markRunMemoryExtracted(handle.db, "run-memory", 500);
    const row = handle.db.get<{ memory_extracted_at: number }>(
      sql`select memory_extracted_at from runs where id = 'run-memory'`,
    );
    expect(row?.memory_extracted_at).toBe(500);
  });
});
