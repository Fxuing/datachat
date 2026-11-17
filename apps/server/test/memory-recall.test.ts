import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { datasources } from "../src/db/schema.js";
import {
  setUserMemorySettings,
  upsertUserMemory,
} from "../src/db/repositories/user-memories.js";
import {
  MEMORY_TOTAL_BUDGET,
  buildMemoryBlock,
  createMemoryExtension,
  memoryTokens,
} from "../src/memory/recall.js";

let handle: DbHandle;

beforeEach(() => {
  handle = createDb(":memory:");
  migrateDb(handle.db);
  handle.db.insert(datasources).values({
    id: "ds-1",
    name: "示例商城",
    type: "mysql",
    host: "localhost",
    port: 3306,
    database: "demo",
    username: "reader",
    passwordCipher: "cipher",
    createdBy: "seed",
    createdAt: 1,
    updatedAt: 1,
  }).run();
  handle.db.insert(datasources).values({
    id: "ds-2",
    name: "其他库",
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "other",
    username: "reader",
    passwordCipher: "cipher",
    createdBy: "seed",
    createdAt: 1,
    updatedAt: 1,
  }).run();
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

describe("memory recall", () => {
  it("tokenizes English and Chinese into words and 2/3-grams", () => {
    expect(memoryTokens("请帮我看看 orders 金额")).toEqual(
      expect.arrayContaining(["orders", "金额", "看看"]),
    );
    expect(memoryTokens("的 了 请")).toEqual([]);
  });

  it("injects core memories and recalls facts for the current datasource", () => {
    const owner = user("recall-owner");
    upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "profile",
      title: "称呼",
      content: "称呼用户为老王",
      scope: "global",
      core: true,
      confidence: 90,
    });
    upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "preference",
      title: "金额单位",
      content: "金额默认按万元展示",
      scope: "global",
      confidence: 90,
    });
    upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "fact",
      title: "订单口径",
      content: "只统计已支付订单",
      scope: "datasource",
      datasourceId: "ds-1",
      confidence: 90,
    });
    upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "fact",
      title: "其他库",
      content: "金额按分展示",
      scope: "datasource",
      datasourceId: "ds-2",
      confidence: 90,
    });
    upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "fact",
      title: "低置信",
      content: "金额用亿元",
      scope: "global",
      confidence: 20,
    });

    const block = buildMemoryBlock({
      db: handle.db,
      userId: owner.id,
      datasourceId: "ds-1",
      datasourceName: "示例商城",
      query: "订单金额按什么单位展示",
    });

    expect(block.text).toContain("称呼用户为老王");
    expect(block.text).toContain("金额默认按万元展示");
    expect(block.text).toContain("只统计已支付订单");
    expect(block.text).not.toContain("金额按分展示");
    expect(block.text).not.toContain("金额用亿元");
    expect(block.text).toContain("[数据源 示例商城/事实]");
  });

  it("isolates users and respects the user switch", () => {
    const owner = user("recall-a");
    const other = user("recall-b");
    upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "profile",
      title: "称呼",
      content: "叫阿明",
      scope: "global",
      core: true,
    });

    expect(
      buildMemoryBlock({ db: handle.db, userId: other.id, datasourceId: "ds-1", query: "你好" }).text,
    ).toBe("");
    expect(
      buildMemoryBlock({ db: handle.db, userId: owner.id, datasourceId: "ds-1", query: "你好" }).text,
    ).toContain("叫阿明");

    setUserMemorySettings(handle.db, owner.id, false);
    expect(
      buildMemoryBlock({ db: handle.db, userId: owner.id, datasourceId: "ds-1", query: "你好" }).text,
    ).toBe("");
  });

  it("keeps the whole block within budget", () => {
    const owner = user("recall-budget");
    for (let index = 0; index < 12; index += 1) {
      upsertUserMemory(handle.db, {
        userId: owner.id,
        kind: "instruction",
        title: `规则 ${index}`,
        content: `这是第 ${index} 条规则，`.repeat(80),
        scope: "global",
        core: true,
      });
    }
    const block = buildMemoryBlock({
      db: handle.db,
      userId: owner.id,
      datasourceId: "ds-1",
      query: "规则",
    });
    expect(block.text.length).toBeLessThanOrEqual(MEMORY_TOTAL_BUDGET);
    expect(block.text).toContain("<user_memory>");
  });

  it("appends the block through before_agent_start and records usage", async () => {
    const owner = user("recall-extension");
    const memory = upsertUserMemory(handle.db, {
      userId: owner.id,
      kind: "preference",
      title: "图表",
      content: "默认使用柱状图",
      scope: "global",
      core: true,
    }).memory;
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
    const pi = {
      on: (event: string, handler: (value: unknown) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    createMemoryExtension({
      db: handle.db,
      userId: owner.id,
      datasourceId: "ds-1",
      datasourceName: "示例商城",
    })(pi);
    const handler = handlers.get("before_agent_start");
    expect(handler).toBeTypeOf("function");
    const result = (await handler!({
      type: "before_agent_start",
      messageType: "user",
      prompt: "帮我画个图",
      systemPrompt: "BASE",
      systemPromptOptions: {},
    })) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("默认使用柱状图");
    expect(
      handle.db.get<{ use_count: number }>(
        sql`select use_count from user_memories where id = ${memory.id}`,
      )?.use_count,
    ).toBe(1);
  });
});
