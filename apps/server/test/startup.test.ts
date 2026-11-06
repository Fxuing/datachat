import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { listRunEventsAfter } from "../src/db/repositories/run-events.js";
import { createRun, findRun, markRun } from "../src/db/repositories/runs.js";
import { reconcileInterruptedRuns, SERVER_RESTART_ERROR } from "../src/services/startup.js";

let db: Db;
let conversationId: string;

beforeEach(() => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  conversationId = createConversation(db, { userId: "user-1", datasourceId: "ds-1" }).id;
});

function newRun() {
  return createRun(db, { conversationId, userId: "user-1" });
}

describe("reconcileInterruptedRuns", () => {
  it("marks queued and running runs as interrupted and appends run_end", () => {
    const queued = newRun();
    const running = newRun();
    markRun(db, running.id, { status: "running", startedAt: 500 });
    const finished = newRun();
    markRun(db, finished.id, { status: "ok", endedAt: 600 });

    expect(reconcileInterruptedRuns(db, () => 2_000)).toBe(2);

    expect(findRun(db, queued.id)).toMatchObject({
      status: "error",
      error: SERVER_RESTART_ERROR,
      endedAt: 2_000,
    });
    expect(findRun(db, running.id)).toMatchObject({
      status: "error",
      error: SERVER_RESTART_ERROR,
      endedAt: 2_000,
    });
    expect(findRun(db, finished.id)).toMatchObject({ status: "ok", error: null });

    for (const runId of [queued.id, running.id]) {
      expect(listRunEventsAfter(db, runId, 0).map((event) => event.type)).toEqual([
        "run_end",
      ]);
    }
    expect(listRunEventsAfter(db, finished.id, 0)).toEqual([]);
  });

  it("is idempotent", () => {
    const interrupted = newRun();
    markRun(db, interrupted.id, { status: "running", startedAt: 1 });

    expect(reconcileInterruptedRuns(db, () => 2_000)).toBe(1);
    const eventsAfterFirstRun = listRunEventsAfter(db, interrupted.id, 0);

    expect(reconcileInterruptedRuns(db, () => 3_000)).toBe(0);
    expect(listRunEventsAfter(db, interrupted.id, 0)).toEqual(eventsAfterFirstRun);
    expect(findRun(db, interrupted.id)?.endedAt).toBe(2_000);
  });
});
