import { afterEach, describe, expect, it, vi } from "vitest";
import { setTheme, toggleTheme } from "./theme";

type DocWithOptionalVT = {
  startViewTransition?: (update: () => void) => { finished?: Promise<void> };
};

const docWithVT = document as unknown as DocWithOptionalVT;

afterEach(() => {
  delete docWithVT.startViewTransition;
  delete document.documentElement.dataset.themeTransition;
  vi.restoreAllMocks();
  setTheme("light");
});

describe("toggleTheme", () => {
  it("switches theme directly when View Transitions API is unavailable", () => {
    setTheme("light");
    toggleTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.themeTransition).toBeUndefined();
  });

  it("uses a cross-fade View Transition when supported and cleans up on finish", async () => {
    setTheme("light");
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const startViewTransition = vi.fn((update: () => void) => {
      expect(document.documentElement.dataset.themeTransition).toBe("fade");
      update();
      return { finished };
    });
    docWithVT.startViewTransition = startViewTransition;

    toggleTheme();
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.themeTransition).toBe("fade");

    resolveFinished();
    await finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.themeTransition).toBeUndefined();
  });

  it("skips View Transition when prefers-reduced-motion is enabled", () => {
    setTheme("light");
    const startViewTransition = vi.fn();
    docWithVT.startViewTransition = startViewTransition;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );

    toggleTheme();
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
