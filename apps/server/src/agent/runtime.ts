import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RunEvent } from "@datachat/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  findConversation,
  touchConversation,
  type ConversationRow,
} from "../db/repositories/conversations.js";
import { appendRunEvent } from "../db/repositories/run-events.js";
import { markRun } from "../db/repositories/runs.js";
import type { ArtifactStore } from "../services/artifacts.js";
import type { PoolRegistry } from "./datasource/pool.js";
import { RunEventBus } from "./event-bus.js";
import {
  bridgeSessionEvents,
  type EventBridge,
  type UsageTotals,
} from "./event-bridge.js";
import { createAgentModelRuntime } from "./model-runtime.js";
import { createConversationSession } from "./session.js";
import { materializeSkills } from "./skills.js";
import type { AgentToolContext } from "./tools/context.js";

const DISPOSE_ABORT_TIMEOUT_MS = 5_000;

export interface QueueJob {
  runId: string;
  content: string;
}

export interface SessionBundle {
  session: AgentSession;
  piSessionFile?: string;
  toolContext?: AgentToolContext;
}

export type ConversationSessionFactory = (input: {
  conversation: ConversationRow;
  userId: string;
  runId: string;
}) => Promise<SessionBundle>;

export interface ConversationRuntimeOptions {
  db: Db;
  conversation: ConversationRow;
  userId: string;
  bus: RunEventBus;
  createSession: ConversationSessionFactory;
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One conversation's run queue. Exactly one run is active at a time; extra messages
 * wait in FIFO order. The Pi session is created lazily and retained across runs.
 */
export class ConversationRuntime {
  readonly conversationId: string;

  private readonly db: Db;
  private readonly userId: string;
  private readonly bus: RunEventBus;
  private readonly createSession: ConversationSessionFactory;
  private readonly now: () => number;

  private conversation: ConversationRow;
  private readonly queue: QueueJob[] = [];
  private activeJob: QueueJob | undefined;
  private draining = false;
  private abortRequested = false;
  private lastUsed: number;

  private sessionBundle: SessionBundle | undefined;
  private sessionPromise: Promise<SessionBundle> | undefined;
  private activeSettled: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  private readonly finalized = new Set<string>();

  constructor(options: ConversationRuntimeOptions) {
    this.db = options.db;
    this.conversation = options.conversation;
    this.conversationId = options.conversation.id;
    this.userId = options.userId;
    this.bus = options.bus;
    this.createSession = options.createSession;
    this.now = options.now ?? Date.now;
    this.lastUsed = this.now();
  }

  get busy(): boolean {
    return this.activeJob !== undefined || this.queue.length > 0;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get lastUsedAt(): number {
    return this.lastUsed;
  }

  touch(): void {
    this.lastUsed = this.now();
  }

  /**
   * Persist the queue position and start the run immediately when the conversation is
   * idle. Position counts every message accepted for this conversation, including the
   * currently active run.
   */
  enqueue(input: QueueJob): number {
    if (this.disposed) throw new Error("会话运行时已释放");
    const position = this.activeJob ? this.queue.length + 2 : 1;
    this.emitEvent(input.runId, { type: "run_queued", payload: { position } });
    this.queue.push({ ...input });
    this.touch();
    void this.drain();
    return position;
  }

  abort(runId: string): boolean {
    if (this.activeJob?.runId === runId) {
      this.abortRequested = true;
      const session = this.sessionBundle?.session;
      if (session) void session.abort().catch(() => undefined);
      return true;
    }
    const index = this.queue.findIndex((job) => job.runId === runId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this.endRun(runId, "aborted");
    return true;
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (!this.disposed) {
        const job = this.queue.shift();
        if (!job) break;
        this.activeJob = job;
        let settle: () => void = () => undefined;
        this.activeSettled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        try {
          await this.execute(job);
        } catch (error) {
          // execute() handles its own failures; this catch is the last line of
          // defence so a DB/tool hiccup cannot leave an unhandled rejection or
          // stall the rest of the queue.
          this.endRun(job.runId, "error", errorMessage(error));
        } finally {
          settle();
          this.activeJob = undefined;
          this.activeSettled = undefined;
          this.abortRequested = false;
          this.touch();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(job: QueueJob): Promise<void> {
    try {
      markRun(this.db, job.runId, { status: "running", startedAt: this.now() });
    } catch {
      // The queue must keep moving even if the status write fails.
    }
    this.emitEvent(job.runId, { type: "run_start", payload: { startedAt: this.now() } });
    this.emitEvent(job.runId, { type: "user_message", payload: { content: job.content } });

    let bridge: EventBridge | undefined;
    try {
      touchConversation(this.db, this.conversationId);
      const bundle = await this.ensureSession(job.runId);
      if (this.disposed) {
        this.endRun(job.runId, "aborted");
        await bundle.session.dispose();
        return;
      }
      if (this.abortRequested) {
        await bundle.session.abort().catch(() => undefined);
        this.endRun(job.runId, "aborted");
        return;
      }

      if (bundle.toolContext) bundle.toolContext.runId = job.runId;

      bridge = bridgeSessionEvents({
        db: this.db,
        runId: job.runId,
        conversationId: this.conversationId,
        session: bundle.session,
        emit: (event) => {
          this.bus.publish({
            runId: job.runId,
            conversationId: this.conversationId,
            seq: event.seq,
            createdAt: this.now(),
            event: event as RunEvent,
          });
          if (event.type === "run_end") {
            this.finalizeRun(job.runId, event.payload.status, event.payload.error, bridge?.usage);
          }
        },
      });

      await bundle.session.prompt(job.content);
      this.endRun(
        job.runId,
        this.abortRequested ? "aborted" : "ok",
        undefined,
        bridge.usage,
      );
    } catch (error) {
      const aborted = this.abortRequested || isAbortError(error);
      this.endRun(
        job.runId,
        aborted ? "aborted" : "error",
        aborted ? undefined : errorMessage(error),
        bridge?.usage,
      );
    } finally {
      bridge?.stop();
    }
  }

  private async ensureSession(runId: string): Promise<SessionBundle> {
    const conversation = findConversation(this.db, this.conversationId) ?? this.conversation;
    this.conversation = conversation;

    if (this.sessionBundle) {
      const liveModelId = this.sessionBundle.session.model?.id ?? null;
      if (conversation.modelId && liveModelId !== conversation.modelId) {
        // PATCH /conversations/:id changed the model: drop the live Pi session but
        // keep the same session file so the transcript carries over.
        await this.disposeSession();
      } else {
        return this.sessionBundle;
      }
    }

    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession({
        conversation,
        userId: this.userId,
        runId,
      }).then((bundle) => {
        this.sessionBundle = bundle;
        return bundle;
      }).catch((error: unknown) => {
        this.sessionPromise = undefined;
        throw error;
      });
    }
    return this.sessionPromise;
  }

  /** Abort and dispose the live Pi session without touching the runtime itself. */
  private async disposeSession(): Promise<void> {
    const bundle = this.sessionBundle;
    this.sessionBundle = undefined;
    this.sessionPromise = undefined;
    if (!bundle) return;
    await bundle.session.abort().catch(() => undefined);
    try {
      await bundle.session.dispose();
    } catch {
      // A failed dispose must not prevent a fresh session from being created.
    }
  }

  private emitEvent(runId: string, event: RunEvent): void {
    try {
      const { seq, createdAt } = appendRunEvent(this.db, {
        runId,
        conversationId: this.conversationId,
        type: event.type,
        payload: event.payload,
      });
      this.bus.publish({
        runId,
        conversationId: this.conversationId,
        seq,
        createdAt,
        event,
      });
    } catch {
      // Event persistence is best-effort; the run must keep going.
    }
  }

  private endRun(
    runId: string,
    status: "ok" | "error" | "aborted",
    error?: string,
    usage?: UsageTotals,
  ): void {
    if (this.finalized.has(runId)) return;
    this.emitEvent(runId, {
      type: "run_end",
      payload: error ? { status, error } : { status },
    });
    this.finalizeRun(runId, status, error, usage);
  }

  private finalizeRun(
    runId: string,
    status: "ok" | "error" | "aborted",
    error: string | undefined,
    usage: UsageTotals | undefined,
  ): void {
    if (this.finalized.has(runId)) return;
    this.finalized.add(runId);
    try {
      markRun(this.db, runId, {
        status,
        endedAt: this.now(),
        error: error ?? null,
        inputTokens: usage?.input ?? null,
        outputTokens: usage?.output ?? null,
        cacheReadTokens: usage?.cacheRead ?? null,
        cacheWriteTokens: usage?.cacheWrite ?? null,
      });
    } catch {
      // A run is still finished even if the status write is lost.
    }
  }

  private async doDispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.queue.splice(0)) this.endRun(job.runId, "aborted");

    const session = this.sessionBundle?.session;
    const activeRunId = this.activeJob?.runId;
    if (activeRunId && session) {
      this.abortRequested = true;
      await session.abort().catch(() => undefined);
    }
    if (activeRunId && this.activeSettled) {
      await Promise.race([this.activeSettled, delay(DISPOSE_ABORT_TIMEOUT_MS)]);
      this.endRun(activeRunId, "aborted");
    }
    if (session) {
      try {
        await session.dispose();
      } catch {
        // The runtime is being torn down; nothing useful remains to clean up.
      }
    }
    this.sessionBundle = undefined;
    this.sessionPromise = undefined;
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === "AbortError" || code === "ABORT_ERR" || code === "ABORT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface RuntimeManagerOptions {
  db: Db;
  config: AppConfig;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
  /** Shared provider catalog resolver; defaults to a private lazy runtime. */
  getModelRuntime?: () => Promise<ModelRuntime>;
  bus?: RunEventBus;
  createSession?: ConversationSessionFactory;
  maxRuntimes?: number;
  idleMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

/**
 * Owns the LRU of per-conversation runtimes and the shared live-event bus. The bus is
 * deliberately exposed on the manager so the SSE route can subscribe to the same
 * fan-out that the runtime publishes to.
 */
export class RuntimeManager {
  readonly bus: RunEventBus;

  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly pools: PoolRegistry;
  private readonly artifacts: ArtifactStore;
  private readonly modelRuntimeFactory: (() => Promise<ModelRuntime>) | undefined;
  private readonly createSession: ConversationSessionFactory;
  private readonly maxRuntimes: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly runtimes = new Map<string, ConversationRuntime>();
  private readonly disposing = new Map<string, Promise<void>>();
  private readonly sweeper: NodeJS.Timeout | undefined;
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: RuntimeManagerOptions) {
    this.db = options.db;
    this.config = options.config;
    this.pools = options.pools;
    this.artifacts = options.artifacts;
    this.modelRuntimeFactory = options.getModelRuntime;
    this.bus = options.bus ?? new RunEventBus();
    this.createSession =
      options.createSession ??
      (async ({ conversation, userId }) => {
        const runtime = await this.getModelRuntime();
        const skillsDir = await materializeSkills(this.db, {
          conversationId: conversation.id,
          datasourceId: conversation.datasourceId,
          dataDir: this.config.dataDir,
        });
        return createConversationSession({
          db: this.db,
          config: this.config,
          runtime,
          conversation,
          userId,
          skillsDir,
          pools: this.pools,
          artifacts: this.artifacts,
        });
      });
    this.maxRuntimes = options.maxRuntimes ?? 20;
    this.idleMs = options.idleMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    if (sweepIntervalMs > 0) {
      this.sweeper = setInterval(() => this.sweepIdle(), sweepIntervalMs);
      this.sweeper.unref?.();
    }
  }

  async getOrCreate(conversation: ConversationRow, userId: string): Promise<ConversationRuntime> {
    const existing = this.runtimes.get(conversation.id);
    if (existing) {
      existing.touch();
      return existing;
    }

    // A runtime may still be tearing down (sweeper, LRU eviction, delete). Wait for
    // that dispose to finish so two runtimes never own the same conversation file.
    const pending = this.disposing.get(conversation.id);
    if (pending) {
      await pending;
      const revived = this.runtimes.get(conversation.id);
      if (revived) {
        revived.touch();
        return revived;
      }
    }

    const runtime = new ConversationRuntime({
      db: this.db,
      conversation,
      userId,
      bus: this.bus,
      createSession: this.createSession,
      now: this.now,
    });
    this.runtimes.set(conversation.id, runtime);
    this.evictOverflow();
    return runtime;
  }

  abort(conversationId: string, runId: string): boolean {
    return this.runtimes.get(conversationId)?.abort(runId) ?? false;
  }

  async remove(conversationId: string): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    if (runtime) {
      this.runtimes.delete(conversationId);
      await runtime.dispose();
      return;
    }
    await this.disposing.get(conversationId);
  }

  isBusy(conversationId: string): boolean {
    return this.runtimes.get(conversationId)?.busy ?? false;
  }

  /** Drop idle runtimes. Runs are never interrupted by the sweeper. */
  sweepIdle(now = this.now()): void {
    for (const [conversationId, runtime] of this.runtimes) {
      if (runtime.busy) continue;
      if (now - runtime.lastUsedAt < this.idleMs) continue;
      this.retire(conversationId, runtime);
    }
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    const ownership = [...runtimes.map((runtime) => runtime.dispose()), ...this.disposing.values()];
    await Promise.all(ownership);
  }

  private retire(conversationId: string, runtime: ConversationRuntime): void {
    this.runtimes.delete(conversationId);
    const pending = runtime.dispose().catch(() => undefined);
    this.disposing.set(conversationId, pending);
    void pending.finally(() => {
      if (this.disposing.get(conversationId) === pending) {
        this.disposing.delete(conversationId);
      }
    });
  }

  private evictOverflow(): void {
    while (this.runtimes.size > this.maxRuntimes) {
      let victim: ConversationRuntime | undefined;
      for (const runtime of this.runtimes.values()) {
        if (runtime.busy) continue;
        if (!victim || runtime.lastUsedAt < victim.lastUsedAt) victim = runtime;
      }
      // All runtimes are busy: go over the cap rather than aborting live work.
      if (!victim) return;
      this.retire(victim.conversationId, victim);
    }
  }

  /** Resolves the catalog for a new session; never cached across provider edits. */
  getModelRuntime(): Promise<ModelRuntime> {
    // A provider edit must take effect on the next run, so always delegate to the
    // injected factory (ModelRuntimeManager already caches by catalog version).
    if (this.modelRuntimeFactory) return this.modelRuntimeFactory();
    if (!this.modelRuntimePromise) {
      this.modelRuntimePromise = createAgentModelRuntime(this.config, this.db).catch(
        (error: unknown) => {
          this.modelRuntimePromise = undefined;
          throw error;
        },
      );
    }
    return this.modelRuntimePromise;
  }
}
