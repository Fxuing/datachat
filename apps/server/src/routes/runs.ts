import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RunEvent } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { findRun, findOwnedRun, markRun } from "../db/repositories/runs.js";
import { appendRunEvent, listRunEventsAfter } from "../db/repositories/run-events.js";
import { deleteRunFeedback, upsertRunFeedback } from "../db/repositories/run-feedback.js";
import type { LiveRunEvent } from "../agent/event-bus.js";
import type { RuntimeManager } from "../agent/runtime.js";
import { runScopeVisible } from "../services/scope-access.js";
import type { RunSuggestionsService } from "../services/suggestions.js";

export interface RunRouteOptions {
  db: Db;
  runtime: RuntimeManager;
  suggestions: RunSuggestionsService;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const lastEventIdSchema = z.object({ after: z.coerce.number().int().nonnegative().optional() });

function error(code: string, message: string) {
  return { error: { code, message } };
}

function parseLastEventId(request: {
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
}): number {
  const header = request.headers["last-event-id"];
  const rawHeader = Array.isArray(header) ? header[0] : header;
  if (rawHeader !== undefined && rawHeader !== "") {
    const parsed = Number(rawHeader);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  const query = lastEventIdSchema.safeParse(request.query);
  return query.success ? (query.data.after ?? 0) : 0;
}

function persistedEvent(row: { seq: number; type: string; payloadJson: string }): LiveRunEvent | null {
  try {
    return {
      runId: "",
      conversationId: "",
      seq: row.seq,
      createdAt: 0,
      event: {
        type: row.type,
        payload: JSON.parse(row.payloadJson) as unknown,
      } as RunEvent,
    };
  } catch {
    return null;
  }
}

export async function runRoutes(app: FastifyInstance, opts: RunRouteOptions): Promise<void> {
  app.get("/api/runs/:id", { preHandler: app.requirePermission("chat.use") }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(error("VALIDATION", "参数不合法"));
    }
    const run = findOwnedRun(opts.db, params.data.id, request.user!.sub);
    if (!run) {
      return reply.code(404).send(error("NOT_FOUND", "运行不存在"));
    }
    return {
      id: run.id,
      status: run.status,
      usage: {
        input: run.inputTokens ?? 0,
        output: run.outputTokens ?? 0,
        cacheRead: run.cacheReadTokens ?? 0,
        cacheWrite: run.cacheWriteTokens ?? 0,
      },
      error: run.error,
    };
  });

  app.post(
    "/api/runs/:id/abort",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const run = findOwnedRun(opts.db, params.data.id, request.user!.sub);
      if (!run) {
        return reply.code(404).send(error("NOT_FOUND", "运行不存在"));
      }

      const aborted = opts.runtime.abort(run.conversationId, run.id);
      if (!aborted) {
        const current = findRun(opts.db, run.id);
        if (current && (current.status === "queued" || current.status === "running")) {
          const { seq, createdAt } = appendRunEvent(opts.db, {
            runId: current.id,
            conversationId: current.conversationId,
            type: "run_end",
            payload: { status: "aborted" },
          });
          markRun(opts.db, current.id, { status: "aborted", endedAt: Date.now() });
          // No live runtime owns this run, so publish the persisted terminal event
          // ourselves: an already-subscribed SSE client must still finish.
          opts.runtime.bus.publish({
            runId: current.id,
            conversationId: current.conversationId,
            seq,
            createdAt,
            event: { type: "run_end", payload: { status: "aborted" } },
          });
        }
      }
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/runs/:id/stream",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const run = findOwnedRun(opts.db, params.data.id, request.user!.sub);
      if (!run) {
        return reply.code(404).send(error("NOT_FOUND", "运行不存在"));
      }

      const lastId = parseLastEventId(request);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let maxSeq = lastId;
      let live = false;
      let cleaned = false;
      let finished = false;
      const buffered: LiveRunEvent[] = [];
      let unsubscribe: () => void = () => undefined;
      // eslint-disable-next-line prefer-const -- cleanup can run before the interval starts
      let heartbeat: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
      };

      const finish = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        try {
          reply.raw.end();
        } catch {
          // The client may already have closed the socket.
        }
      };

      const writeEvent = (event: LiveRunEvent): void => {
        if (finished || event.seq <= maxSeq) return;
        maxSeq = event.seq;
        try {
          reply.raw.write(
            `id: ${event.seq}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event.event.payload)}\n\n`,
          );
        } catch {
          // A dead socket needs the full teardown (listeners + heartbeat), not just
          // the unsubscribe, otherwise the stream leaks until the sweep.
          finish();
          return;
        }
        if (event.event.type === "run_end") finish();
      };

      unsubscribe = opts.runtime.bus.subscribe(run.conversationId, (event) => {
        if (event.runId !== run.id) return;
        if (!live) {
          buffered.push(event);
          return;
        }
        writeEvent(event);
      });

      heartbeat = setInterval(() => {
        if (finished || cleaned) return;
        try {
          reply.raw.write(": ping\n\n");
        } catch {
          finish();
        }
      }, 15_000);
      heartbeat.unref();

      reply.raw.on("close", () => {
        // A disconnected client must not abort the run; it can resume via Last-Event-ID.
        cleanup();
      });

      for (const row of listRunEventsAfter(opts.db, run.id, lastId)) {
        const event = persistedEvent(row);
        if (!event) continue;
        writeEvent(event);
        if (finished) return reply;
      }

      live = true;
      for (const event of buffered) {
        writeEvent(event);
        if (finished) break;
      }

      if (!finished) {
        // Re-read after the replay: a run can become terminal between the first read
        // and the replay (e.g. aborted by a process that could not publish on the
        // bus). Emit one synthetic terminal frame instead of leaving the client
        // waiting for a heartbeat forever.
        const persisted = findRun(opts.db, run.id);
        if (
          persisted &&
          (persisted.status === "ok" ||
            persisted.status === "error" ||
            persisted.status === "aborted")
        ) {
          const terminal: RunEvent = {
            type: "run_end",
            payload: persisted.error
              ? { status: persisted.status, error: persisted.error }
              : { status: persisted.status },
          };
          writeEvent({
            runId: run.id,
            conversationId: run.conversationId,
            seq: maxSeq + 1,
            createdAt: Date.now(),
            event: terminal,
          });
          if (!finished) finish();
        }
      }
      return reply;
    },
  );

  const feedbackBodySchema = z.object({
    rating: z.union([z.literal(1), z.literal(-1)]),
    comment: z.string().trim().max(2_000).optional(),
  });

  app.put(
    "/api/runs/:id/feedback",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = feedbackBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const run = findOwnedRun(opts.db, params.data.id, request.user!.sub);
      if (!run) {
        return reply.code(404).send(error("NOT_FOUND", "运行不存在"));
      }
      upsertRunFeedback(opts.db, {
        runId: run.id,
        userId: request.user!.sub,
        rating: body.data.rating,
        comment: body.data.comment ?? null,
      });
      return reply.code(204).send();
    },
  );

  app.delete(
    "/api/runs/:id/feedback",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const run = findOwnedRun(opts.db, params.data.id, request.user!.sub);
      if (!run) {
        return reply.code(404).send(error("NOT_FOUND", "运行不存在"));
      }
      deleteRunFeedback(opts.db, run.id, request.user!.sub);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/runs/:id/suggestions",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const run = findOwnedRun(opts.db, params.data.id, request.user!.sub);
      if (!run || !runScopeVisible(opts.db, run, request.access!.isAdmin, request.user!.sub)) {
        return reply.code(404).send(error("NOT_FOUND", "运行不存在"));
      }
      const suggestions = await opts.suggestions.getForRun(run.id);
      return { suggestions };
    },
  );
}
