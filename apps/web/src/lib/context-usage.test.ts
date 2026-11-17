import { describe, expect, it } from "vitest";
import { applyContextWindow } from "./context-usage";

describe("applyContextWindow", () => {
  it("recomputes the percent against the model's current window", () => {
    expect(
      applyContextWindow({ tokens: 50_000, contextWindow: 200_000, percent: 25 }, 1_000_000),
    ).toEqual({ tokens: 50_000, contextWindow: 1_000_000, percent: 5 });
  });

  it("keeps the stored window when the model is unknown", () => {
    const usage = { tokens: 50_000, contextWindow: 200_000, percent: 25 };
    expect(applyContextWindow(usage, null)).toBe(usage);
  });

  it("handles a missing token count", () => {
    expect(
      applyContextWindow({ tokens: null, contextWindow: 200_000, percent: null }, 1_000_000),
    ).toEqual({ tokens: null, contextWindow: 1_000_000, percent: null });
  });
});
