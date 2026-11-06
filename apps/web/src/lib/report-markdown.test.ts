import { describe, expect, it } from "vitest";
import { parseReportMarkdown } from "./report-markdown";

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
