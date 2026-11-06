import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runs } from "../db/schema.js";
import { appendRunEvent } from "../db/repositories/run-events.js";
import { markRun } from "../db/repositories/runs.js";

export const SERVER_RESTART_ERROR = "server restarted";

/**
 * No run can survive a process restart: its queue and Pi session are gone. Close
 * every interrupted run exactly once, before the server starts accepting traffic.
 * Idempotent because the second call finds no queued/running rows.
 */
export function reconcileInterruptedRuns(db: Db, now: () => number = Date.now): number {
  const interrupted = db
    .select()
    .from(runs)
    .where(inArray(runs.status, ["queued", "running"]))
    .all();

  for (const run of interrupted) {
    markRun(db, run.id, {
      status: "error",
      error: SERVER_RESTART_ERROR,
      endedAt: now(),
    });
    appendRunEvent(db, {
      runId: run.id,
      conversationId: run.conversationId,
      type: "run_end",
      payload: { status: "error", error: SERVER_RESTART_ERROR },
    });
  }

  return interrupted.length;
}
