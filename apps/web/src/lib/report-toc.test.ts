import { describe, expect, it } from "vitest";
import { extractReportHeadings, headingId } from "./report-toc";

describe("report table of contents", () => {
  it("keeps CJK characters in heading ids", () => {
    expect(headingId("一、摘要与核心结论")).toBe("section-一摘要与核心结论");
    expect(headingId("3.2 月度走势")).toBe("section-32-月度走势");
  });

  it("extracts h1–h3 and strips inline markup", () => {
    const headings = extractReportHeadings(
      ["# 总览", "## **重点** 结论", "### 3.1 `SQL` [说明](https://example.com)", "#### 太深"].join("\n"),
    );

    expect(headings).toEqual([
      { id: "section-总览", text: "总览", level: 1 },
      { id: "section-重点-结论", text: "重点 结论", level: 2 },
      { id: "section-31-sql-说明", text: "3.1 SQL 说明", level: 3 },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const headings = extractReportHeadings(
      ["# 可见", "```sql", "-- # 不是标题", "SELECT 1;", "```", "## 也可见"].join("\n"),
    );

    expect(headings.map((heading) => heading.text)).toEqual(["可见", "也可见"]);
  });
});
