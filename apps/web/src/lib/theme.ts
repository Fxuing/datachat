import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "datachat.theme";
const listeners = new Set<() => void>();
let current: Theme = "light";

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
}

export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode / storage disabled: the theme still applies for this page.
  }
  apply(theme);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, () => current, () => current);
  const toggle = useCallback(() => {
    setTheme(current === "dark" ? "light" : "dark");
  }, []);
  return { theme, toggle };
}
