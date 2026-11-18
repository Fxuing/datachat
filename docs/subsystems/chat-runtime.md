# Chat runtime: queue, session, events and SSE

One conversation owns one Pi session and runs one turn at a time. This page covers
the server-side path from `POST /api/conversations/:id/messages` to persisted run
events and the live SSE stream. Prompt/skill contents and SQL execution are
separate references.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Enqueue | Create a run, reject a full queue, return position | [`conversations.ts`](../../apps/server/src/routes/conversations.ts), [`RuntimeManager`](../../apps/server/src/agent/runtime.ts) |
| Per-conversation queue | Serialize runs, retain the Pi session, abort/dispose | [`ConversationRuntime`](../../apps/server/src/agent/runtime.ts) |
| Session | Resolve model/resources, build tools, bind extensions | [`session.ts`](../../apps/server/src/agent/session.ts), [`resources.ts`](../../apps/server/src/agent/resources.ts) |
| Event bridge | Translate Pi events to shared `RunEvent`, persist, publish | [`event-bridge.ts`](../../apps/server/src/agent/event-bridge.ts), [`event-bus.ts`](../../apps/server/src/agent/event-bus.ts) |
| Replay | Read `run_events` after a sequence number | [`run-events.ts`](../../apps/server/src/db/repositories/run-events.ts) |
| SSE | Replay then subscribe, keepalive, cleanup | [`runs.ts`](../../apps/server/src/routes/runs.ts) |
| Web consumer | Reconnect and merge live/history state | [`useRunStream.ts`](../../apps/web/src/hooks/useRunStream.ts) |

`runs` rows hold status/usage/error; `run_events` is the durable event log.
`RunEventBus` is process-local and not a source of truth.

## Runtime path

1. The route verifies conversation ownership, datasource access, skill validity and
   queue capacity, then creates a `runs` row and calls `runtime.enqueue()`.
2. `ConversationRuntime` emits `run_queued` and returns the position immediately
   (HTTP 202). A conversation with an active run queues; a different conversation
   may run in parallel.
3. On the first turn, `createConversationSession()` resolves the model, materializes
   skills/resources, builds the tool context, and creates the Pi session. The
   session is retained for later turns.
4. Before each prompt, the runtime sets `toolContext.runId` to the current run.
   Tools therefore write artifacts/audit/events for this run, not a captured one.
5. `EventBridge` subscribes to Pi events, maps supported events to `RunEvent`,
   appends each to `run_events`, and publishes it to the bus.
6. The SSE endpoint (`GET /api/runs/:id/stream`) verifies ownership, replays events
   after `Last-Event-ID`/`after`, then subscribes to live events. Keepalives keep
   proxies from closing an idle stream.
7. On terminal state the runtime writes `runs.status`, `endedAt`, usage/error and a
   final `run_end`; it then releases the queue and may trigger memory extraction.

## Contracts

- **One active run per conversation.** Do not call `session.prompt()` directly or
  create a second runtime for the same conversation.
- **`runId` is per-prompt.** `AgentToolContext` is shared across runs; update it
  before each prompt, never in a tool factory.
- **Every terminal path emits `run_end`.** Success, model error, tool error, abort,
  timeout, and dispose all need a terminal event; otherwise the UI keeps streaming.
- **Events are serializable and replayable.** A new event type must be added to
  `packages/shared/src/run-events.ts`, mapped in `event-bridge.ts`, persisted, and
  handled by `useRunStream`/the UI. Do not publish live-only state.
- **Abort is cooperative.** The route calls `runtime.abort`; the session is aborted
  and the queue item removed. A queued (not active) run is ended immediately.
- **Session resources are a snapshot.** Skills/MCP/report tools are built at session
  creation. A later permission change affects new requests but not the existing
  tool set; recreate the session when the contract requires immediate effect.
- **Queue full is a client-visible error.** The route marks the run failed and
  returns a stable code; do not silently drop a message.

## Failure behavior

- Pi session creation failure marks the run `error` and emits `run_end`; the next
  turn retries session creation.
- A model/tool error is recorded on the run and surfaced in the trace; retry is a
  new run linked by `retry_of_run_id`, not an in-place reset.
- SSE disconnects are normal; replay covers the gap. A malformed persisted event is
  skipped rather than crashing the stream.
- Runtime disposal aborts the active session and clears the queue with terminal
  states. Timers/intervals must be cleared in tests.

## Verification

```bash
pnpm exec vitest run apps/server/test/runtime.test.ts \
  apps/server/test/agent-e2e.test.ts \
  apps/server/test/event-bridge.test.ts \
  apps/server/test/runs-sse.test.ts \
  apps/server/test/conversations-api.test.ts
```

When changing the SSE or event contract, also run the web chat tests and inspect a
real run's trace/reload. A replay test must prove events are not duplicated after
reconnect.
