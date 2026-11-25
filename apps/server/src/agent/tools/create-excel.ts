import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  EXCEL_MAX_FILENAME_LENGTH,
  EXCEL_MAX_SHEETS,
  type ExcelSheetSpec,
  type ExcelWorkbookSpec,
} from "@datachat/shared";
import { resolveUserAccess } from "../../auth/access.js";
import { findUserById } from "../../db/repositories/users.js";
import {
  dedupeWorksheetNames,
  EXPORT_MAX_ROWS,
  sanitizeExcelFilename,
} from "../../services/export.js";
import { artifactRunVisible } from "../../services/scope-access.js";
import {
  errorResult,
  safeJsonStringify,
  textResult,
  type AgentToolContext,
} from "./context.js";

const excelSheetInputSchema = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 60,
    description: "工作表名称（最多 31 个字符，重名或非法字符会自动清理）",
  }),
  artifactId: Type.String({
    description: "当前会话中 db_query 产出的 result 类型 artifactId",
  }),
});

const createExcelParameters = Type.Object({
  filename: Type.String({
    minLength: 1,
    maxLength: EXCEL_MAX_FILENAME_LENGTH + 20,
    description: "导出的 Excel 文件名（不含 .xlsx 后缀，如「2025年Q1销售分析」）",
  }),
  sheets: Type.Array(excelSheetInputSchema, {
    minItems: 1,
    maxItems: EXCEL_MAX_SHEETS,
    description: `工作表列表（1..${EXCEL_MAX_SHEETS} 个）`,
  }),
});

export type CreateExcelParams = Static<typeof createExcelParameters>;

export interface CreateExcelDetails {
  excelArtifactId: string;
  filename: string;
  sheets: ExcelSheetSpec[];
  totalRows: number;
  code?: string;
  message?: string;
}

function failureDetails(
  filename: string,
  code: string,
  message: string,
): CreateExcelDetails {
  return {
    excelArtifactId: "",
    filename,
    sheets: [],
    totalRows: 0,
    code,
    message,
  };
}

export function createExcelTool(
  ctx: AgentToolContext,
): ToolDefinition<typeof createExcelParameters, CreateExcelDetails> {
  return {
    name: "create_excel",
    label: "生成 Excel",
    description:
      "基于当前会话已有的查询结果（result artifact）组装单个或多个工作表，生成可一键下载的多 Sheet Excel（.xlsx）工作簿，并指定业务文件名。若当前没有合适形态的数据，先用 db_query 查询出目标列与汇总结果后再调用本工具。",
    parameters: createExcelParameters,
    async execute(_toolCallId, params) {
      const fail = (code: string, message: string) =>
        errorResult(code, message, failureDetails(params.filename ?? "", code, message));

      const user = findUserById(ctx.db, ctx.userId);
      if (!user) {
        return fail("FORBIDDEN", "当前账号不存在，无法生成 Excel 文件");
      }
      const access = resolveUserAccess(ctx.db, user);
      if (!access.permissions.has("export.data")) {
        return fail("FORBIDDEN", "当前账号没有导出数据权限，无法生成 Excel 文件");
      }

      if (params.sheets.length === 0 || params.sheets.length > EXCEL_MAX_SHEETS) {
        return fail("VALIDATION", `工作表数量需在 1 到 ${EXCEL_MAX_SHEETS} 个之间`);
      }

      const resolvedArtifacts: Array<{ name: string; artifactId: string; rowCount: number }> = [];
      let totalRows = 0;

      for (const sheet of params.sheets) {
        const artifact = ctx.artifacts.get(sheet.artifactId);
        if (
          !artifact ||
          artifact.userId !== ctx.userId ||
          artifact.conversationId !== ctx.conversationId ||
          !artifactRunVisible(ctx.db, artifact.runId, access.isAdmin)
        ) {
          return fail(
            "ARTIFACT_NOT_FOUND",
            `未找到查询结果 ${sheet.artifactId}，或它不属于当前会话/超出当前数据权限范围`,
          );
        }
        if (artifact.kind !== "result") {
          return fail(
            "INVALID_ARTIFACT_KIND",
            `artifact ${sheet.artifactId} 不是查询结果（result），不能写入 Excel 工作表`,
          );
        }
        totalRows += artifact.rowCount;
        resolvedArtifacts.push({
          name: sheet.name,
          artifactId: artifact.id,
          rowCount: artifact.rowCount,
        });
      }

      if (totalRows > EXPORT_MAX_ROWS) {
        return fail(
          "EXPORT_TOO_LARGE",
          `工作簿总行数（${totalRows} 行）超过单次导出上限 ${EXPORT_MAX_ROWS} 行，请先通过 SQL 聚合或缩小筛选范围后再导出`,
        );
      }

      const filename = sanitizeExcelFilename(params.filename, "导出结果");
      const sheetNames = dedupeWorksheetNames(resolvedArtifacts.map((item) => item.name));
      const sheets: ExcelSheetSpec[] = resolvedArtifacts.map((item, index) => ({
        name: sheetNames[index]!,
        artifactId: item.artifactId,
        rowCount: item.rowCount,
      }));

      const spec: ExcelWorkbookSpec = {
        filename,
        sheets,
        totalRows,
      };

      const created = ctx.artifacts.createExcel({
        conversationId: ctx.conversationId,
        userId: ctx.userId,
        runId: ctx.runId || null,
        spec,
        rowCount: totalRows,
      });

      const details: CreateExcelDetails = {
        excelArtifactId: created.id,
        filename,
        sheets,
        totalRows,
        message: `${filename}.xlsx · ${sheets.length} 个工作表（${totalRows} 行）`,
      };

      return textResult(
        safeJsonStringify({
          excelArtifactId: created.id,
          filename: `${filename}.xlsx`,
          sheets,
          totalRows,
          placeholder: `[[excel:${created.id}]]`,
          hint: `请在正文单独一行写 [[excel:${created.id}]] 渲染可点击下载的 Excel 文件卡片`,
        }),
        details,
      );
    },
  };
}
