import { vi } from "vitest";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";

/**
 * Minimal AgentSession stand-in: event subscription plus the few methods the runtime
 * and event bridge touch. No model, network, or Pi session file is involved.
 */
export class FakeAgentSession {
  readonly prompt = vi.fn(async (_text: string): Promise<void> => undefined);
  readonly abort = vi.fn(async (): Promise<void> => undefined);
  readonly dispose = vi.fn((): void => undefined);
  readonly setThinkingLevel = vi.fn((level: string): void => {
    this.thinkingLevel = level;
  });
  isStreaming = false;
  thinkingLevel = "off";
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;

  private readonly listeners = new Set<AgentSessionEventListener>();

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getActiveToolNames(): string[] {
    return [];
  }

  getContextUsage(): typeof this.contextUsage {
    return this.contextUsage;
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export function asAgentSession(session: FakeAgentSession): AgentSession {
  return session as unknown as AgentSession;
}
