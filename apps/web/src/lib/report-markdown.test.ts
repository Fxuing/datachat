import { describe, expect, it } from "vitest";
import { parseChatMarkdown, parseReportMarkdown } from "./report-markdown";

describe("parseReportMarkdown", () => {
  it("splits prose and artifact placeholders in order", () => {
    expect(
      parseReportMarkdown("## 概览\n\n[[artifact:art-1]]\n\n结论。\n\n[[artifact:art-2]]"),
    ).toEqual([
      { type: "markdown", content: "## 概览\n\n" },
      { type: "artifact", artifactId: "art-1" },
      { type: "markdown", content: "\n\n结论。\n\n" },
      { type: "artifact", artifactId: "art-2" },
    ]);
  });

  it("recognises chart placeholders used by chat replies", () => {
    expect(parseReportMarkdown("趋势如下：\n\n[[chart:chart-1]]\n\n结论。")).toEqual([
      { type: "markdown", content: "趋势如下：\n\n" },
      { type: "chart", artifactId: "chart-1" },
      { type: "markdown", content: "\n\n结论。" },
    ]);
  });

  it("keeps malformed placeholders as markdown", () => {
    expect(parseReportMarkdown("[[artifact:]]")).toEqual([
      { type: "markdown", content: "[[artifact:]]" },
    ]);
    expect(parseReportMarkdown("no placeholders")).toEqual([
      { type: "markdown", content: "no placeholders" },
    ]);
    expect(parseReportMarkdown("")).toEqual([]);
  });
});

describe("parseChatMarkdown", () => {
  it("splits chat-only result references", () => {
    expect(parseChatMarkdown("共 3 行。\n\n[[result:art-1]]\n\n结论。")).toEqual([
      { type: "markdown", content: "共 3 行。\n\n" },
      { type: "result", artifactId: "art-1" },
      { type: "markdown", content: "\n\n结论。" },
    ]);
  });

  it("keeps result markers literal in report markdown", () => {
    expect(parseReportMarkdown("[[result:art-1]]")).toEqual([
      { type: "markdown", content: "[[result:art-1]]" },
    ]);
  });

  it("does not split an incomplete result marker", () => {
    expect(parseChatMarkdown("[[result:art-1")).toEqual([
      { type: "markdown", content: "[[result:art-1" },
    ]);
  });
});
