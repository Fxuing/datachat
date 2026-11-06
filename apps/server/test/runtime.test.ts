import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationRuntime,
  RuntimeManager,
  type ConversationSessionFactory,
} from "../src/agent/runtime.js";
import { RunEventBus, type LiveRunEvent } from "../src/agent/event-bus.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  createConversation,
  type ConversationRow,
} from "../src/db/repositories/conversations.js";
import { listRunEventsAfter } from "../src/db/repositories/run-events.js";
import { createRun, findRun } from "../src/db/repositories/runs.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import type { ArtifactStore } from "../src/services/artifacts.js";
import { testConfig } from "./helpers/config.js";
import { asAgentSession, FakeAgentSession } from "./helpers/fake-agent-session.js";

let db: Db;
let conversation: ConversationRow;

beforeEach(() => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  conversation = createConversation(db, { userId: "user-1", datasourceId: "ds-1" });
});

function newRun(): string {
  return createRun(db, {
    conversationId: conversation.id,
    userId: "user-1",
    modelId: "deepseek-ai/DeepSeek-V3.2",
  }).id;
}

function eventTypes(runId: string): string[] {
  return listRunEventsAfter(db, runId, 0).map((row) => row.type);
}

function makeRuntime(createSession: ConversationSessionFactory, bus = new RunEventBus()) {
  const runtime = new ConversationRuntime({
    db,
    conversation,
    userId: "user-1",
    bus,
    createSession,
  });
  return { runtime, bus };
}

describe("ConversationRuntime", () => {
  it("runs messages FIFO with one active run and reports queue positions", async () => {
    const session = new FakeAgentSession();
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    session.prompt.mockImplementation(async (text: string) => {
      if (text === "first") await firstGate;
    });
    const createSession = vi.fn<ConversationSessionFactory>(async () => ({
      session: asAgentSession(session),
    }));
    const { runtime, bus } = makeRuntime(createSession);
    const live: LiveRunEvent[] = [];
    bus.subscribe(conversation.id, (event) => live.push(event));

    const first = newRun();
    const second = newRun();
    expect(runtime.enqueue({ runId: first, content: "first" })).toBe(1);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    expect(runtime.enqueue({ runId: second, content: "second" })).toBe(2);
    expect(runtime.busy).toBe(true);
    expect(runtime.queueLength).toBe(1);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(eventTypes(second)).toEqual(["run_queued"]);

    releaseFirst();
    await vi.waitFor(() => expect(findRun(db, second)?.status).toBe("ok"));
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(eventTypes(first)).toEqual(["run_queued", "run_start", "user_message", "run_end"]);
    expect(eventTypes(second)).toEqual(["run_queued", "run_start", "user_message", "run_end"]);
    expect(live.filter((event) => event.runId === second).map((event) => event.seq)).toEqual([
      1, 2, 3, 4,
    ]);

    await runtime.dispose();
  });

  it("aborts a queued run without disturbing the active one", async () => {
    const session = new FakeAgentSession();
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    session.prompt.mockImplementation(async (text: string) => {
      if (text === "first") await firstGate;
    });
    const { runtime } = makeRuntime(async () => ({ session: asAgentSession(session) }));

    const first = newRun();
    const second = newRun();
    runtime.enqueue({ runId: first, content: "first" });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    runtime.enqueue({ runId: second, content: "second" });

    expect(runtime.abort(second)).toBe(true);
    expect(findRun(db, second)?.status).toBe("aborted");
    expect(eventTypes(second)).toEqual(["run_queued", "run_end"]);
    expect(runtime.queueLength).toBe(0);

    releaseFirst();
    await vi.waitFor(() => expect(findRun(db, first)?.status).toBe("ok"));
    expect(runtime.abort("missing")).toBe(false);

    await runtime.dispose();
  });

  it("aborts the active run through the session", async () => {
    const session = new FakeAgentSession();
    let rejectPrompt: (error: Error) => void = () => undefined;
    session.prompt.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    session.abort.mockImplementation(async () => {
      rejectPrompt(new Error("aborted"));
    });
    const { runtime } = makeRuntime(async () => ({ session: asAgentSession(session) }));

    const runId = newRun();
    runtime.enqueue({ runId, content: "slow" });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    expect(runtime.abort(runId)).toBe(true);
    await vi.waitFor(() => expect(findRun(db, runId)?.status).toBe("aborted"));
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(eventTypes(runId).at(-1)).toBe("run_end");

    await runtime.dispose();
  });

  it("disposes the session once and rejects new work after disposal", async () => {
    const session = new FakeAgentSession();
    const { runtime } = makeRuntime(async () => ({ session: asAgentSession(session) }));
    const runId = newRun();
    runtime.enqueue({ runId, content: "hello" });
    await vi.waitFor(() => expect(findRun(db, runId)?.status).toBe("ok"));

    await runtime.dispose();
    await runtime.dispose();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(() => runtime.enqueue({ runId: newRun(), content: "after" })).toThrow(
      "会话运行时已释放",
    );
  });
});

describe("RuntimeManager", () => {
  it("keeps at most maxRuntimes conversations and disposes the least recently used", async () => {
    const sessions: FakeAgentSession[] = [];
    const createSession = vi.fn<ConversationSessionFactory>(async () => {
      const session = new FakeAgentSession();
      sessions.push(session);
      return { session: asAgentSession(session) };
    });
    const manager = new RuntimeManager({
      db,
      config: testConfig,
      pools: {} as PoolRegistry,
      artifacts: {} as ArtifactStore,
      createSession,
      maxRuntimes: 2,
      sweepIntervalMs: 0,
    });

    const firstConversation = conversation;
    const secondConversation = createConversation(db, {
      userId: "user-1",
      datasourceId: "ds-1",
    });
    const thirdConversation = createConversation(db, {
      userId: "user-1",
      datasourceId: "ds-1",
    });

    const firstRuntime = manager.getOrCreate(firstConversation, "user-1");
    const runId = createRun(db, {
      conversationId: firstConversation.id,
      userId: "user-1",
    }).id;
    firstRuntime.enqueue({ runId, content: "hello" });
    await vi.waitFor(() => expect(findRun(db, runId)?.status).toBe("ok"));

    manager.getOrCreate(secondConversation, "user-1");
    manager.getOrCreate(thirdConversation, "user-1");

    await vi.waitFor(() => expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1));
    expect(sessions).toHaveLength(1);
    await manager.shutdown();
  });

  it("sweeps idle conversations but never busy ones", async () => {
    let now = 1_000;
    const sessions: FakeAgentSession[] = [];
    const createSession = vi.fn<ConversationSessionFactory>(async () => {
      const session = new FakeAgentSession();
      sessions.push(session);
      return { session: asAgentSession(session) };
    });
    const manager = new RuntimeManager({
      db,
      config: testConfig,
      pools: {} as PoolRegistry,
      artifacts: {} as ArtifactStore,
      createSession,
      idleMs: 1_000,
      sweepIntervalMs: 0,
      now: () => now,
    });

    const runtime = manager.getOrCreate(conversation, "user-1");
    const runId = newRun();
    runtime.enqueue({ runId, content: "hello" });
    await vi.waitFor(() => expect(findRun(db, runId)?.status).toBe("ok"));

    now += 900;
    manager.sweepIdle();
    expect(sessions[0]?.dispose).not.toHaveBeenCalled();

    now += 200;
    manager.sweepIdle();
    await vi.waitFor(() => expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1));
    await manager.shutdown();
  });

  it("shuts down every runtime", async () => {
    const sessions: FakeAgentSession[] = [];
    const manager = new RuntimeManager({
      db,
      config: testConfig,
      pools: {} as PoolRegistry,
      artifacts: {} as ArtifactStore,
      createSession: async () => {
        const session = new FakeAgentSession();
        sessions.push(session);
        return { session: asAgentSession(session) };
      },
      maxRuntimes: 10,
      sweepIntervalMs: 0,
    });

    const secondConversation = createConversation(db, {
      userId: "user-1",
      datasourceId: "ds-1",
    });
    manager.getOrCreate(conversation, "user-1");
    manager.getOrCreate(secondConversation, "user-1");

    await manager.shutdown();
    await manager.shutdown();
  });
});
