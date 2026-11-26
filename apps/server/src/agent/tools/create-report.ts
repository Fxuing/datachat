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
      "把当前会话中已有的查询结果与图表整理成一份分析报告。正文用 Markdown，并用 [[artifact:<id>]] 引用每个结果。调用成功后系统会在聊天中自动展示报告卡片（支持一键直接导出 Word .docx、HTML、Markdown，也可点击进入报告详情页编辑、分享或打印 PDF）；用户要求生成或导出 Word/HTML/Markdown/PDF 报告时调用本工具。",
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

提示：聊天中已渲染报告导出卡片，可直接点击下载 Word（.docx）、HTML 或 Markdown；打开报告详情页可进一步编辑、分享或打印 PDF。

${safeJsonStringify({
          reportId: result.report.id,
          title: result.report.title,
          url,
          placeholder: `[[report:${result.report.id}]]`,
        })}`,
        {
          reportId: result.report.id,
          title: result.report.title,
          url,
          message: `《${result.report.title}》`,
        },
      );
    },
  };
}
