export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/**
 * The persisted usage event stores the window of the model that produced it.
 * After a provider's context window changes, the same token count should be
 * measured against the model's current window.
 */
export function applyContextWindow(
  usage: ContextUsage | null | undefined,
  contextWindow?: number | null,
): ContextUsage | null {
  if (!usage) return null;
  if (!contextWindow || contextWindow <= 0) return usage;
  return {
    ...usage,
    contextWindow,
    percent:
      usage.tokens === null ? usage.percent : (usage.tokens / contextWindow) * 100,
  };
}
