import { useState } from "react";

export interface TraceOpenOptions {
  /** Controlled open state; when provided the component never stores its own. */
  open?: boolean;
  /** Fallback while the reader has not clicked yet; a click always wins. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Shared open/close logic for `Trace` and `TraceLine`.
 *
 * Resolution order is `controlled ?? user click ?? defaultOpen`, which is how
 * AI Elements keeps a running step unfolded while still letting the reader collapse
 * it: a click wins until the row unmounts, and the moment the work settles the
 * caller's `defaultOpen` drops back to collapsed.
 *
 * `defaultOpen` is derived from status by the caller rather than here: the trace
 * unfolds while a run is live, a single line only unfolds when it failed (its
 * error text is the reason the reader would open it at all). */
export function useTraceOpen({ open: controlled, defaultOpen = false, onOpenChange }: TraceOpenOptions) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = controlled ?? userOpen ?? defaultOpen;

  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setUserOpen(next);
    onOpenChange?.(next);
  };

  return { open, toggle };
}
