export interface StoredScrollPosition {
  scrollTop: number;
  atBottom: boolean;
}

const STORAGE_PREFIX = "datachat:scroll:";

function storageKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${conversationId}`;
}

export function readScrollPosition(conversationId: string): StoredScrollPosition | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(conversationId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredScrollPosition>;
    if (typeof value.scrollTop !== "number" || typeof value.atBottom !== "boolean") return null;
    return { scrollTop: Math.max(0, value.scrollTop), atBottom: value.atBottom };
  } catch {
    return null;
  }
}

export function writeScrollPosition(
  conversationId: string,
  position: StoredScrollPosition,
): void {
  try {
    window.sessionStorage.setItem(storageKey(conversationId), JSON.stringify(position));
  } catch {
    // Storage can be disabled; scrolling should still work.
  }
}

export function isNearBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">, threshold = 80): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
}
