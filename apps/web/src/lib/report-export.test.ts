import { describe, expect, it } from "vitest";
import { buildReportExportHtml, buildReportExportMarkdown } from "./report-export";

describe("report-export", () => {
  it("prepends H1 title to markdown only when missing", () => {
    expect(
      buildReportExportMarkdown({ title: "周报", markdown: "## 概览\n\n内容" }),
    ).toBe("# 周报\n\n## 概览\n\n内容\n");

    expect(
      buildReportExportMarkdown({ title: "周报", markdown: "# 自定义标题\n\n内容" }),
    ).toBe("# 自定义标题\n\n内容\n");
  });

  it("exports standalone HTML with escaped title and stripped interactive buttons", () => {
    const article = document.createElement("article");
    article.innerHTML = `
      <header><h1>经营 &lt;Q4&gt; 复盘</h1></header>
      <div class="report-artifact">
        <div role="group"><button type="button">柱状图</button></div>
        <button type="button">全屏</button>
        <p>关键结论：增长 25%</p>
      </div>
    `;

    const html = buildReportExportHtml("经营 <Q4> 复盘", article);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>经营 &lt;Q4&gt; 复盘</title>");
    expect(html).toContain("关键结论：增长 25%");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("柱状图");
  });
});
