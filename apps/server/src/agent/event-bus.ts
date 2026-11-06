import type { RunEvent } from "@datachat/shared";

/** A persisted run event plus the routing metadata the live SSE stream needs. */
export interface LiveRunEvent {
  runId: string;
  conversationId: string;
  seq: number;
  createdAt: number;
  event: RunEvent;
}

type Listener = (event: LiveRunEvent) => void;

/**
 * In-process fan-out for streaming clients. `run_events` remains the source of truth:
 * subscribers replay persisted rows first, then use this bus to follow the run.
 */
export class RunEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(conversationId: string, listener: Listener): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(conversationId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(conversationId);
    };
  }

  listenerCount(conversationId: string): number {
    return this.listeners.get(conversationId)?.size ?? 0;
  }

  publish(event: LiveRunEvent): void {
    const set = this.listeners.get(event.conversationId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // A broken client must not stop the run or other subscribers.
      }
    }
  }
}
