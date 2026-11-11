import { describe, expect, it } from "vitest";
import { loadEvalCases, parseEvalCases } from "../src/eval/cases.js";

describe("golden cases", () => {
  const cases = loadEvalCases();

  it("contains 15 unique cases", () => {
    expect(cases).toHaveLength(15);
    expect(new Set(cases.map((item) => item.id)).size).toBe(15);
  });

  it("has both dialect queries and a question", () => {
    for (const item of cases) {
      expect(item.question.trim().length).toBeGreaterThan(0);
      expect(item.mysql.trim().length).toBeGreaterThan(0);
      expect(item.postgres.trim().length).toBeGreaterThan(0);
    }
  });

  it("orders every case marked ordered", () => {
    for (const item of cases.filter((entry) => entry.ordered)) {
      expect(item.mysql).toMatch(/\border\s+by\b/i);
      expect(item.postgres).toMatch(/\border\s+by\b/i);
    }
  });

  it("rejects duplicate ids", () => {
    const [first] = cases;
    expect(() => parseEvalCases([first, first])).toThrow(/重复/);
  });

  it("rejects an ordered case without ORDER BY", () => {
    expect(() =>
      parseEvalCases([
        {
          id: "bad-order",
          question: "排序",
          mysql: "SELECT 1",
          postgres: "SELECT 2",
          ordered: true,
        },
      ]),
    ).toThrow(/ORDER BY/);
  });

  it("defaults tags and ordered", () => {
    const parsed = parseEvalCases([
      {
        id: "minimal",
        question: "问题",
        mysql: "SELECT 1",
        postgres: "SELECT 1",
      },
    ])[0]!;
    expect(parsed.ordered).toBe(false);
    expect(parsed.tags).toEqual([]);
  });
});
