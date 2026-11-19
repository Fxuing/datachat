import { useCallback, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export type Theme = "light" | "dark";

interface ViewTransitionLike {
  finished?: Promise<unknown>;
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
};

const STORAGE_KEY = "datachat.theme";
const listeners = new Set<() => void>();
let current: Theme = "light";
let transitionSeq = 0;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function storedTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function apply(theme: Theme): void {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }
  current = theme;
  emit();
}

/** Read the saved preference; the product default is light. */
export function getInitialTheme(): Theme {
  return storedTheme() ?? "light";
}

/** Apply the initial theme synchronously, before React renders, to avoid a flash. */
export function initTheme(): void {
  apply(getInitialTheme());
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    apply(event.newValue === "dark" ? "dark" : "light");
  });
}

export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode / storage disabled: the theme still applies for this page.
  }
  apply(theme);
}

export function toggleTheme(): void {
  const next: Theme = current === "dark" ? "light" : "dark";
  const doc = typeof document !== "undefined" ? (document as DocumentWithViewTransition) : null;
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    setTheme(next);
    return;
  }

  const root = doc.documentElement;
  const seq = ++transitionSeq;
  root.dataset.themeTransition = "fade";
  const cleanup = () => {
    if (transitionSeq === seq) {
      delete root.dataset.themeTransition;
    }
  };

  try {
    const transition = doc.startViewTransition(() => {
      // Flush React updates synchronously so ::view-transition-new(root)
      // snapshots the final theme (including theme-reactive artwork).
      flushSync(() => {
        setTheme(next);
      });
    });
    if (transition?.finished) {
      void transition.finished.then(cleanup, cleanup);
    } else {
      cleanup();
    }
  } catch {
    cleanup();
    setTheme(next);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, () => current, () => current);
  const toggle = useCallback(() => {
    toggleTheme();
  }, []);
  return { theme, toggle };
}
