import { describe, expect, it } from "vitest";
import { compareResultSets } from "../src/eval/compare.js";

const result = (rows: unknown[][], columns = ["a"]) => ({ columns, rows });

describe("compareResultSets", () => {
  it("ignores row order and column names by default", () => {
    expect(
      compareResultSets(result([[2], [1]], ["a"]), result([[1], [2]], ["x"])),
    ).toEqual({ equal: true });
  });

  it("compares row order when ordered is true", () => {
    const compared = compareResultSets(result([[2], [1]]), result([[1], [2]]), {
      ordered: true,
    });
    expect(compared.equal).toBe(false);
    if (!compared.equal) expect(compared.reason).toBe("value_mismatch");
  });

  it("treats decimal strings and numbers as equal", () => {
    expect(
      compareResultSets(result([["120.00"], ["45.500000"]]), result([[120], [45.5]])),
    ).toEqual({ equal: true });
  });

  it("preserves null and normalizes booleans", () => {
    expect(
      compareResultSets(result([[null, true], [null, false]]), result([[null, 1], [null, 0]])),
    ).toEqual({ equal: true });
  });

  it("rejects a different column count even when values match", () => {
    const compared = compareResultSets(result([[1, 2]], ["a", "b"]), result([[1]]));
    expect(compared.equal).toBe(false);
    if (!compared.equal) expect(compared.reason).toBe("column_count");
  });

  it("rejects a different row count", () => {
    const compared = compareResultSets(result([[1]]), result([[1], [1]]));
    expect(compared.equal).toBe(false);
    if (!compared.equal) expect(compared.reason).toBe("row_count");
  });

  it("compares duplicate rows as a multiset", () => {
    expect(compareResultSets(result([[1], [1]]), result([[1], [1]]))).toEqual({ equal: true });
    const compared = compareResultSets(result([[1], [1]]), result([[1], [2]]));
    expect(compared.equal).toBe(false);
    if (!compared.equal) expect(compared.reason).toBe("value_mismatch");
  });

  it("returns a sample of the expected and actual rows on mismatch", () => {
    const compared = compareResultSets(
      result([["alice"], ["bob"]]),
      result([["alice"], ["carol"]]),
    );
    expect(compared.equal).toBe(false);
    if (!compared.equal) {
      expect(compared.expectedSample).toEqual([["alice"], ["bob"]]);
      expect(compared.actualSample).toEqual([["alice"], ["carol"]]);
    }
  });

  it("normalizes Date values to ISO strings", () => {
    const date = new Date("2025-01-05T10:00:00.000Z");
    expect(compareResultSets(result([[date]]), result([["2025-01-05T10:00:00.000Z"]]))).toEqual({
      equal: true,
    });
  });
});
