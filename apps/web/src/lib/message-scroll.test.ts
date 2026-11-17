import { beforeEach, describe, expect, it } from "vitest";
import { isNearBottom, readScrollPosition, writeScrollPosition } from "./message-scroll";

describe("message scroll position", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("round-trips a reading position per conversation", () => {
    writeScrollPosition("c-1", { scrollTop: 240, atBottom: false });
    expect(readScrollPosition("c-1")).toEqual({ scrollTop: 240, atBottom: false });
    expect(readScrollPosition("c-2")).toBeNull();
  });

  it("ignores malformed stored values", () => {
    window.sessionStorage.setItem("datachat:scroll:c-1", "{oops");
    expect(readScrollPosition("c-1")).toBeNull();
  });

  it("detects the bottom within the threshold", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 590, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false);
  });
});
