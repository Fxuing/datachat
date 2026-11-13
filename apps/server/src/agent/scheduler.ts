import type { FastifyBaseLogger } from "fastify";
import type { ScheduledTaskService } from "../services/scheduled-tasks.js";

export const SCHEDULED_SWEEP_INTERVAL_MS = 60_000;

export function startScheduledTaskSweeper(
  tasks: ScheduledTaskService,
  log: Pick<FastifyBaseLogger, "error">,
): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tasks
      .sweep()
      .catch((error: unknown) => {
        log.error({ err: error }, "scheduled task sweep failed");
      })
      .finally(() => {
        running = false;
      });
  }, SCHEDULED_SWEEP_INTERVAL_MS);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
