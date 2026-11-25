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

  it("labels sqlite file analysis and appends dialect guidance", () => {
    const sqlitePrompt = renderSystemPrompt({
      datasourceName: "销售表.xlsx",
      datasourceType: "sqlite",
      database: "uploaded_files",
      now,
    });
    expect(sqlitePrompt).toContain("SQLite（上传文件临时库）");
    expect(sqlitePrompt).toContain("## SQLite 方言要点");
    expect(sqlitePrompt).toContain("strftime");
  });

  it("leaves no unresolved placeholders", () => {
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it("guides report export requests including Word (.docx) to the report detail page", () => {
    expect(prompt).toContain("Word `.docx`");
    expect(prompt).toContain("报告详情页");
    expect(prompt).toContain("create_report");
  });

  it("instructs using create_excel and [[excel:<excelArtifactId>]] for Excel downloads", () => {
    expect(prompt).toContain("create_excel");
    expect(prompt).toContain("[[excel:<excelArtifactId>]]");
  });
});
