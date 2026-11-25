import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { REPORT_MAX_ARTIFACTS, REPORT_MAX_MARKDOWN_LENGTH } from "@datachat/shared";
import { createReport } from "../../services/reports.js";
import {
  errorResult,
  safeJsonStringify,
  textResult,
  type AgentToolContext,
} from "./context.js";

const reportParameters = Type.Object({
  title: Type.Optional(Type.String({ maxLength: 200, description: "报告标题；省略时按时间自动生成" })),
  markdown: Type.String({
    maxLength: REPORT_MAX_MARKDOWN_LENGTH,
    description: "报告正文（Markdown）；每个结果/图表用 [[artifact:<id>]] 占位引用",
  }),
  artifactIds: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: REPORT_MAX_ARTIFACTS,
    description: "要纳入报告的 artifact id 列表（1..20 个，必须属于当前会话）",
  }),
});

export type CreateReportParams = {
  title?: string;
  markdown: string;
  artifactIds: string[];
};

export interface CreateReportDetails {
  reportId: string;
  title: string;
  url: string;
  code?: string;
  message?: string;
}

function failureDetails(code: string, message: string): CreateReportDetails {
  return { reportId: "", title: "", url: "", code, message };
}

export function createReportTool(
  ctx: AgentToolContext,
): ToolDefinition<typeof reportParameters, CreateReportDetails> {
  return {
    name: "create_report",
    label: "生成分析报告",
    description:
      "把当前会话中已有的查询结果与图表整理成一份分析报告。正文用 Markdown，并用 [[artifact:<id>]] 引用每个结果。报告详情页内置右下角悬浮「导出」按钮（支持直接导出 Markdown、HTML 和 Word .docx）及顶栏「打印」（PDF）；当用户要求把报告或分析导出为 Word/HTML/Markdown/PDF 时，调用本工具生成报告（或复用已有报告链接）并引导用户到报告详情页导出。",
    parameters: reportParameters,
    async execute(_toolCallId, params) {
      const result = createReport({
        db: ctx.db,
        artifacts: ctx.artifacts,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        artifactIds: params.artifactIds,
        title: params.title,
        markdown: params.markdown,
      });
      if (!result.ok) {
        return errorResult(result.code, result.message, failureDetails(result.code, result.message));
      }

      const url = `/reports/${result.report.id}`;
      return textResult(
        `报告已生成：《${result.report.title}》

[查看完整报告](${url})

提示：打开报告详情页后，点击右下角悬浮「导出」按钮可一键导出 Markdown、HTML 或 Word（.docx），顶栏支持打印 PDF。

${safeJsonStringify(
          { reportId: result.report.id, title: result.report.title, url },
        )}`,
        { reportId: result.report.id, title: result.report.title, url },
      );
    },
  };
}
