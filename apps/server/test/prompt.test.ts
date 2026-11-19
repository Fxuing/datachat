import { describe, expect, it } from "vitest";
import { HARD_RULES, renderSystemPrompt } from "../src/agent/prompt.js";

describe("renderSystemPrompt", () => {
  const now = new Date("2026-11-06T08:00:00.000Z");
  const prompt = renderSystemPrompt({
    datasourceName: "销售库",
    datasourceType: "mysql",
    database: "sales",
    now,
  });

  it("injects datasource name, dialect, database and hour-precision time at the end", () => {
    expect(prompt).toContain("销售库");
    expect(prompt).toContain("MySQL");
    expect(prompt).toContain("sales");
    expect(prompt).toContain("当前时间：2026-11-06T08:00Z");
    expect(prompt.indexOf("当前时间：")).toBeGreaterThan(prompt.indexOf("## 硬性规则"));
  });

  it("keeps the rendered prompt identical within the same hour for prompt caching", () => {
    const later = renderSystemPrompt({
      datasourceName: "销售库",
      datasourceType: "mysql",
      database: "sales",
      now: new Date("2026-11-06T08:47:29.999Z"),
    });
    expect(later).toBe(prompt);
  });

  it("labels postgres as PostgreSQL", () => {
    const postgres = renderSystemPrompt({
      datasourceName: "analytics",
      datasourceType: "postgres",
      database: "warehouse",
    });
    expect(postgres).toContain("PostgreSQL");
    expect(postgres).not.toContain("MySQL");
  });

  it("appends the eight hard rules", () => {
    expect(HARD_RULES).toHaveLength(8);
    for (const [index, rule] of HARD_RULES.entries()) {
      expect(prompt).toContain(`${index + 1}. ${rule}`);
    }
    expect(prompt).toContain("## 硬性规则");
  });

  it("leaves no unresolved placeholders", () => {
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });
});
