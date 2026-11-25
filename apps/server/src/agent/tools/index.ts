import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolContext } from "./context.js";
import { createDbExplainTool } from "./db-explain.js";
import { createDbQueryTool } from "./db-query.js";
import { createDbSchemaTool } from "./db-schema.js";
import { createExcelTool } from "./create-excel.js";
import { createListArtifactsTool } from "./list-artifacts.js";
import { createMakeChartTool } from "./make-chart.js";
import { createReportTool } from "./create-report.js";
import { createSandboxReadTool } from "./sandbox-read.js";

/**
 * Tools available to the DataChat agent. Every tool closes over the current
 * conversation's ids, so no tool takes a datasource id from the model.
 */
export interface AgentToolOptions {
  /** Fail closed: only an explicit grant enables report creation. */
  canCreateReports?: boolean;
  /** Fail closed: only an explicit `export.data` grant enables Excel workbook creation. */
  canExportData?: boolean;
}

export function buildAgentTools(
  ctx: AgentToolContext,
  options: AgentToolOptions = {},
): ToolDefinition[] {
  const tools = [
    createSandboxReadTool(ctx),
    createDbSchemaTool(ctx) as ToolDefinition,
    createDbQueryTool(ctx) as ToolDefinition,
    createDbExplainTool(ctx) as ToolDefinition,
    createMakeChartTool(ctx) as ToolDefinition,
    createListArtifactsTool(ctx) as ToolDefinition,
  ];
  if (options.canCreateReports === true) {
    tools.push(createReportTool(ctx) as ToolDefinition);
  }
  if (options.canExportData === true) {
    tools.push(createExcelTool(ctx) as ToolDefinition);
  }
  return tools;
}

export type { AgentToolContext } from "./context.js";
