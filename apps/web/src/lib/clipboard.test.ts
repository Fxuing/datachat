import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyToClipboard", () => {
  it("writes through the clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyToClipboard("SELECT 1;")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("SELECT 1;");
  });

  it("falls back to execCommand when the clipboard API is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
    });

    await expect(copyToClipboard("SELECT 1;")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });
});
