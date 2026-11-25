import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ColumnInfo } from "../../services/artifacts.js";
import { safeJsonStringify, textResult, type AgentToolContext } from "./context.js";

const listParameters = Type.Object({});

export interface ListArtifactsDetails {
  count: number;
}

interface ArtifactSummary {
  id: string;
  kind: string;
  rowCount: number;
  truncated: boolean;
  createdAt: number;
  columns: ColumnInfo[];
}

export function createListArtifactsTool(
  ctx: AgentToolContext,
): ToolDefinition<typeof listParameters, ListArtifactsDetails> {
  return {
    name: "list_artifacts",
    label: "列出查询结果",
    description: "列出当前会话最近 20 个查询结果（artifact），可用于追问、对比、生成图表或导出 Excel。",
    parameters: listParameters,
    async execute() {
      const records = ctx.artifacts.list({
        conversationId: ctx.conversationId,
        kind: "result",
        limit: 20,
      });
      const artifacts: ArtifactSummary[] = records.map((record) => ({
        id: record.id,
        kind: "query_result",
        rowCount: record.rowCount,
        truncated: record.truncated,
        createdAt: record.createdAt,
        columns: record.columns,
      }));
      return textResult(safeJsonStringify({ artifacts }), { count: artifacts.length });
    },
  };
}
