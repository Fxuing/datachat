import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ChartError, buildChartOption, type ChartInput } from "../../services/charts.js";
import { MAX_CHART_INPUT_ROWS } from "../../services/artifacts.js";
import {
  errorMessage,
  errorResult,
  safeJsonStringify,
  textResult,
  type AgentToolContext,
} from "./context.js";

const chartParameters = Type.Object({
  artifactId: Type.String({ description: "已有查询结果的 artifact id" }),
  type: Type.Union([
    Type.Literal("bar"),
    Type.Literal("line"),
    Type.Literal("area"),
    Type.Literal("pie"),
    Type.Literal("scatter"),
  ]),
  x: Type.String({ description: "横轴列名（区分大小写）" }),
  y: Type.String({ description: "纵轴列名（区分大小写）" }),
  series: Type.Optional(Type.String({ description: "可选的系列列名，用于分组" })),
  aggregate: Type.Optional(
    Type.Union([
      Type.Literal("sum"),
      Type.Literal("avg"),
      Type.Literal("count"),
      Type.Literal("min"),
      Type.Literal("max"),
    ]),
  ),
  title: Type.Optional(Type.String({ description: "图表标题" })),
});

export type MakeChartParams = Static<typeof chartParameters>;

export interface MakeChartDetails {
  chartArtifactId: string;
  sourceArtifactId: string;
  type: ChartInput["type"];
  points: number;
  /** Rows the chart could not plot (unparsable/non-numeric x or y). */
  skipped: number;
  /** True when the source result had more rows than the chart input cap. */
  truncatedInput: boolean;
  title: string;
  /** ECharts spec persisted in `spec_json` and forwarded by the chart event. */
  spec: Record<string, unknown>;
  code?: string;
  message?: string;
}

function failureDetails(
  sourceArtifactId: string,
  type: ChartInput["type"],
  code: string,
  message: string,
): MakeChartDetails {
  return {
    chartArtifactId: "",
    sourceArtifactId,
    type,
    points: 0,
    skipped: 0,
    truncatedInput: false,
    title: "",
    spec: {},
    code,
    message,
  };
}

export function createMakeChartTool(
  ctx: AgentToolContext,
): ToolDefinition<typeof chartParameters, MakeChartDetails> {
  return {
    name: "make_chart",
    label: "生成图表",
    description:
      "基于当前会话已有查询结果（artifact）生成图表，保存为新的 chart artifact。x/y 必须是结果中的列名；同一 x 有多行时请指定 aggregate。",
    parameters: chartParameters,
    async execute(_toolCallId, params) {
      const chart: ChartInput = {
        type: params.type,
        x: params.x,
        y: params.y,
        series: params.series,
        aggregate: params.aggregate,
        title: params.title?.trim() || undefined,
      };
      const fail = (code: string, message: string) =>
        errorResult(code, message, failureDetails(params.artifactId, params.type, code, message));

      const source = ctx.artifacts.get(params.artifactId);
      if (
        !source ||
        source.userId !== ctx.userId ||
        source.conversationId !== ctx.conversationId
      ) {
        return fail("ARTIFACT_NOT_FOUND", "未找到该结果，或它不属于当前会话");
      }
      if (source.kind !== "result") {
        return fail("NOT_A_RESULT", "图表只能基于查询结果生成");
      }

      let data: Awaited<ReturnType<AgentToolContext["artifacts"]["readRowsStream"]>>;
      try {
        data = await ctx.artifacts.readRowsStream(params.artifactId, MAX_CHART_INPUT_ROWS);
      } catch (error) {
        return fail("ARTIFACT_READ_FAILED", `读取结果失败：${errorMessage(error)}`);
      }
      if (!data) return fail("ARTIFACT_NOT_FOUND", "未找到该结果");

      let option: Record<string, unknown>;
      let points: number;
      let skipped: number;
      try {
        ({ option, points, skipped } = buildChartOption({
          rows: data.rows,
          columns: data.meta.columns,
          chart,
        }));
      } catch (error) {
        if (error instanceof ChartError) return fail(error.code, error.message);
        return fail("CHART_ERROR", errorMessage(error));
      }

      const title = chart.title ?? chart.y;
      const spec: Record<string, unknown> = { option, chart: { ...chart, title } };
      const meta = ctx.artifacts.createChart({
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        runId: ctx.runId,
        columns: data.meta.columns,
        spec,
        rowCount: points,
      });

      const details: MakeChartDetails = {
        chartArtifactId: meta.id,
        sourceArtifactId: params.artifactId,
        type: chart.type,
        points,
        skipped,
        truncatedInput: data.truncatedInput,
        title,
        spec,
      };
      const notices: string[] = [];
      if (skipped > 0) notices.push(`${skipped} 行因无法解析/非数值已跳过`);
      if (data.meta.truncated) notices.push("结果已截断，图表可能不完整");
      if (data.truncatedInput) {
        notices.push(
          `输入超过 ${MAX_CHART_INPUT_ROWS} 行已截断，建议先用 SQL 聚合后再生成图表`,
        );
      }
      return textResult(
        safeJsonStringify({
          chartArtifactId: meta.id,
          type: chart.type,
          points,
          title,
          hint: `请在对应分析段落下方单独一行写 [[chart:${meta.id}]] 就地展示该图表（多维分析应按小节图文穿插，勿将所有图表堆在文末）`,
          ...(skipped > 0 ? { skipped } : {}),
          ...(notices.length > 0 ? { notice: notices.join("；") } : {}),
        }),
        details,
      );
    },
  };
}
