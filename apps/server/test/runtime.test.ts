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
  updateConversation,
  type ConversationRow,
} from "../src/db/repositories/conversations.js";
import { listRunEventsAfter } from "../src/db/repositories/run-events.js";
import { createRun, findRun } from "../src/db/repositories/runs.js";
import { conversations as conversationsTable } from "../src/db/schema.js";
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
  it("rebuilds the live session when the conversation model changes", async () => {
    updateConversation(db, conversation.id, { modelId: "model-a" });
    conversation = { ...conversation, modelId: "model-a" };

    const firstSession = new FakeAgentSession();
    Object.assign(firstSession, { model: { id: "model-a" } });
    const secondSession = new FakeAgentSession();
    Object.assign(secondSession, { model: { id: "model-b" } });
    const sessions = [firstSession, secondSession];
    const createSession = vi.fn<ConversationSessionFactory>(async () => {
      const session = sessions.shift()!;
      return { session: asAgentSession(session), piSessionFile: "/tmp/session.jsonl" };
    });

    const { runtime } = makeRuntime(createSession);
    const firstRun = newRun();
    runtime.enqueue({ runId: firstRun, content: "first" });
    await vi.waitFor(() => expect(findRun(db, firstRun)?.status).toBe("ok"));

    updateConversation(db, conversation.id, { modelId: "model-b" });
    const secondRun = newRun();
    runtime.enqueue({ runId: secondRun, content: "second" });
    await vi.waitFor(() => expect(findRun(db, secondRun)?.status).toBe("ok"));

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[1]?.[0].conversation.modelId).toBe("model-b");
    expect(firstSession.dispose).toHaveBeenCalledTimes(1);
    expect(secondSession.prompt).toHaveBeenCalledWith("second");
  });

  it("keeps draining when touchConversation throws", async () => {
    const firstSession = new FakeAgentSession();
    const secondSession = new FakeAgentSession();
    const sessions = [firstSession, secondSession];
    const createSession = vi.fn<ConversationSessionFactory>(async () => ({
      session: asAgentSession(sessions.shift()!),
    }));

    let failNextConversationUpdate = 1;
    const guardedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update") {
          return (table: unknown) => {
            if (table === conversationsTable && failNextConversationUpdate > 0) {
              failNextConversationUpdate -= 1;
              throw new Error("touch failed");
            }
            return (target.update as (value: unknown) => unknown)(table);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as Db;

    const runtime = new ConversationRuntime({
      db: guardedDb,
      conversation,
      userId: "user-1",
      bus: new RunEventBus(),
      createSession,
    });

    const failingRun = newRun();
    const healthyRun = newRun();
    runtime.enqueue({ runId: failingRun, content: "first" });
    runtime.enqueue({ runId: healthyRun, content: "second" });

    await vi.waitFor(() => expect(runtime.busy).toBe(false));
    expect(findRun(db, failingRun)).toMatchObject({ status: "error", error: "touch failed" });
    expect(findRun(db, healthyRun)?.status).toBe("ok");
    expect(eventTypes(failingRun).at(-1)).toBe("run_end");
    expect(eventTypes(healthyRun).at(-1)).toBe("run_end");
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

    const firstRuntime = await manager.getOrCreate(firstConversation, "user-1");
    const runId = createRun(db, {
      conversationId: firstConversation.id,
      userId: "user-1",
    }).id;
    firstRuntime.enqueue({ runId, content: "hello" });
    await vi.waitFor(() => expect(findRun(db, runId)?.status).toBe("ok"));

    await manager.getOrCreate(secondConversation, "user-1");
    await manager.getOrCreate(thirdConversation, "user-1");

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

    const runtime = await manager.getOrCreate(conversation, "user-1");
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
    await manager.getOrCreate(conversation, "user-1");
    await manager.getOrCreate(secondConversation, "user-1");

    await manager.shutdown();
    await manager.shutdown();
  });

  it("waits for an in-flight dispose before creating the next runtime", async () => {
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

    let releaseDispose: () => void = () => undefined;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });

    const first = await manager.getOrCreate(conversation, "user-1");
    const runId = newRun();
    first.enqueue({ runId, content: "hello" });
    await vi.waitFor(() => expect(findRun(db, runId)?.status).toBe("ok"));
    sessions[0]!.dispose.mockImplementation(async () => {
      await disposeGate;
    });

    now += 2_000;
    manager.sweepIdle();

    let created = false;
    const nextPromise = manager.getOrCreate(conversation, "user-1").then((runtime) => {
      created = true;
      return runtime;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created).toBe(false);

    releaseDispose();
    const next = await nextPromise;
    expect(next).not.toBe(first);
    expect(first.busy).toBe(false);
    await manager.shutdown();
  });
});
