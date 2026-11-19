import { describe, expect, it } from "vitest";
import {
  groupChatSegments,
  parseChatMarkdown,
  parseReportMarkdown,
  reportArtifactIdsFromTools,
} from "./report-markdown";

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

  it("parses optional result labels and trims blank labels", () => {
    expect(parseChatMarkdown("[[result:art-1| 类目销售明细 ]]")).toEqual([
      { type: "result", artifactId: "art-1", label: "类目销售明细" },
    ]);
    expect(parseChatMarkdown("[[result:art-1|   ]]")).toEqual([
      { type: "result", artifactId: "art-1" },
    ]);
  });

  it("keeps labelled result markers literal in report markdown", () => {
    expect(parseReportMarkdown("[[result:art-1|类目销售明细]]")).toEqual([
      { type: "markdown", content: "[[result:art-1|类目销售明细]]" },
    ]);
  });

  it("keeps pipe labels literal on chart and artifact placeholders", () => {
    expect(parseChatMarkdown("[[chart:chart-1|标题]]")).toEqual([
      { type: "markdown", content: "[[chart:chart-1|标题]]" },
    ]);
    expect(parseChatMarkdown("[[artifact:art-1|标题]]")).toEqual([
      { type: "markdown", content: "[[artifact:art-1|标题]]" },
    ]);
  });
});

describe("groupChatSegments", () => {
  it("merges consecutive result segments separated only by whitespace", () => {
    const segments = parseChatMarkdown("说明：\n[[result:art-1]]\n  \n[[result:art-2|明细]]\n结论");
    expect(groupChatSegments(segments)).toEqual([
      { type: "markdown", content: "说明：\n" },
      {
        type: "result_group",
        items: [
          { type: "result", artifactId: "art-1" },
          { type: "result", artifactId: "art-2", label: "明细" },
        ],
      },
      { type: "markdown", content: "\n结论" },
    ]);
  });

  it("keeps non-adjacent result segments in separate groups", () => {
    const segments = parseChatMarkdown("表一：\n[[result:art-1]]\n\n表二：\n[[result:art-2]]");
    expect(groupChatSegments(segments)).toEqual([
      { type: "markdown", content: "表一：\n" },
      { type: "result_group", items: [{ type: "result", artifactId: "art-1" }] },
      { type: "markdown", content: "\n\n表二：\n" },
      { type: "result_group", items: [{ type: "result", artifactId: "art-2" }] },
    ]);
  });
});

describe("reportArtifactIdsFromTools", () => {
  it("extracts trimmed artifact ids from succeeded create_report tool calls", () => {
    const ids = reportArtifactIdsFromTools([
      {
        name: "create_report",
        status: "ok",
        args: { artifactIds: [" chart-1 ", "res-1", "", 123, null] },
      },
      {
        name: "create_report",
        status: "error",
        args: { artifactIds: ["chart-failed"] },
      },
      {
        name: "create_report",
        status: "running",
        args: { artifactIds: ["chart-running"] },
      },
      {
        name: "make_chart",
        status: "ok",
        args: { artifactIds: ["chart-other-tool"] },
      },
      {
        name: "create_report",
        status: "ok",
        args: "not-an-object",
      },
    ]);

    expect([...ids]).toEqual(["chart-1", "res-1"]);
  });
});
