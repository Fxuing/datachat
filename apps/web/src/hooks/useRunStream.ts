import { useCallback, useEffect, useReducer, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RunEvent } from "@datachat/shared";
import { abortRun } from "../lib/api";
import {
  initialRunStreamState,
  runStreamReducer,
  type RunStreamState,
} from "../lib/run-events";
import { queryKeys } from "../lib/query";

const RUN_EVENT_TYPES = [
  "run_queued",
  "run_start",
  "user_message",
  "assistant_message",
  "text_delta",
  "thinking_delta",
  "tool_start",
  "tool_end",
  "sql",
  "result",
  "chart",
  "report",
  "retry",
  "compaction",
  "usage",
  "run_end",
] as const satisfies readonly RunEvent["type"][];

const MAX_RECONNECT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 8_000;

export interface UseRunStreamOptions {
  runId: string | null;
  conversationId: string | null;
}

export interface UseRunStreamResult {
  state: RunStreamState;
  /** True while the run is queued or executing. */
  active: boolean;
  stop: () => void;
}

/**
 * Subscribes to one run's SSE stream. Reconnects with capped exponential backoff
 * using the last received event id (`?after=`), because EventSource cannot send a
 * Last-Event-ID header on the very first manual reconnect.
 */
export function useRunStream({ runId, conversationId }: UseRunStreamOptions): UseRunStreamResult {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(runStreamReducer, initialRunStreamState);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    dispatch({ type: "reset" });
    lastSeqRef.current = 0;
    if (!runId) return;

    let disposed = false;
    let finished = false;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    let attempts = 0;

    const closeSource = () => {
      source?.close();
      source = null;
    };

    const connect = () => {
      if (disposed || finished) return;
      const after = lastSeqRef.current;
      const suffix = after > 0 ? `?after=${after}` : "";
      const nextSource = new EventSource(`/api/runs/${runId}/stream${suffix}`);
      source = nextSource;
      dispatch({ type: "connection", connection: after > 0 ? "reconnecting" : "connecting" });

      for (const type of RUN_EVENT_TYPES) {
        nextSource.addEventListener(type, (raw) => {
          if (disposed) return;
          const message = raw as MessageEvent<string>;
          let payload: unknown;
          try {
            payload = JSON.parse(message.data);
          } catch {
            return;
          }
          const seq = Number.parseInt(message.lastEventId, 10);
          dispatch({
            type: "event",
            seq: Number.isFinite(seq) ? seq : 0,
            event: { type, payload } as RunEvent,
          });
          if (Number.isFinite(seq) && seq > lastSeqRef.current) {
            lastSeqRef.current = seq;
          }
          if (type === "run_end") {
            finished = true;
            closeSource();
            void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
            if (conversationId) {
              void queryClient.invalidateQueries({
                queryKey: queryKeys.conversation(conversationId),
              });
            }
          }
        });
      }

      nextSource.onopen = () => {
        attempts = 0;
        dispatch({ type: "connection", connection: "open" });
      };

      nextSource.onerror = () => {
        if (disposed || finished) return;
        closeSource();
        dispatch({ type: "connection", connection: "reconnecting" });
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          dispatch({ type: "failure", message: "连接中断，请刷新页面重试" });
          return;
        }
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
        attempts += 1;
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      closeSource();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [runId, conversationId, queryClient]);

  const stop = useCallback(() => {
    if (!runId) return;
    void abortRun(runId).catch(() => {
      // Abort is best effort; the run may already have finished.
    });
  }, [runId]);

  return {
    state,
    active: state.status === "queued" || state.status === "running",
    stop,
  };
}
