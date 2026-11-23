import { z } from "zod";
import type { Column } from "./events.js";

export const OPEN_APP_SCOPES = [
  "ask",
  "report",
  "semantic",
  "mcp",
  "feedback",
] as const;

export type OpenAppScope = (typeof OPEN_APP_SCOPES)[number];

export const OPEN_APP_SCOPE_LABELS: Record<OpenAppScope, string> = {
  ask: "结构化问答与取数（Ask API）",
  report: "模板化报告生成（Report API）",
  semantic: "数据源与语义层元数据（Semantic API）",
  mcp: "远程 MCP 工具服务（MCP Server）",
  feedback: "问答反馈回流（Feedback API）",
};

export const openAppScopeSchema = z.enum(OPEN_APP_SCOPES);

export const openEndUserSchema = z
  .object({
    /** External system's user identifier (stored in audit/session tracking). */
    externalUserId: z.string().trim().min(1).max(128).optional(),
    /** Optional DataChat username to act as (must exist and be active). */
    username: z.string().trim().min(1).max(64).optional(),
    /** Optional DataChat department codes for row-level data scope override. */
    departmentCodes: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
    /** Optional external org codes mapped via department_org_map for row-level scope. */
    externalOrgCodes: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
  })
  .strict();

export type OpenEndUserContext = z.infer<typeof openEndUserSchema>;

export interface OpenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OpenDataset {
  artifactId: string;
  columns: Column[];
  previewRows: unknown[][];
  rowCount: number;
  truncated: boolean;
  rowsUrl: string;
}

export interface OpenChart {
  artifactId: string;
  spec: unknown;
}

export interface OpenSqlLineage {
  sql: string;
  auditId: string;
  status: "ok" | "rejected" | "error";
}

export interface OpenLineage {
  sqls?: OpenSqlLineage[];
  scope: { departments: string[]; scopedTables?: string[] } | null;
  semanticMetrics: Array<{ name: string; formula: string; unit: string | null }>;
}

export interface OpenAskResult {
  runId: string;
  conversationId: string;
  externalSessionId: string | null;
  datasourceId: string;
  status: "queued" | "running" | "ok" | "error" | "aborted";
  answer: string;
  rawAnswer?: string;
  datasets: OpenDataset[];
  charts: OpenChart[];
  lineage: OpenLineage;
  usage: OpenUsage | null;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
}

export interface OpenReportResult {
  reportId: string | null;
  runId: string;
  conversationId: string;
  datasourceId: string;
  status: "queued" | "running" | "ok" | "error" | "aborted";
  title: string;
  markdown: string;
  datasets: OpenDataset[];
  charts: OpenChart[];
  lineage: OpenLineage;
  usage: OpenUsage | null;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
}

export interface OpenAppSummary {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "disabled";
  serviceUserId: string;
  serviceUsername: string;
  serviceUserDisplayName: string | null;
  allowedDatasourceIds: string[] | null;
  scopes: OpenAppScope[];
  allowEndUserOverride: boolean;
  exposeSql: boolean;
  defaultModelId: string | null;
  systemPromptExtra: string | null;
  rateLimitRpm: number;
  maxRowsOverride: number | null;
  timeoutMsOverride: number | null;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  activeKeyCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface OpenApiKeySummary {
  id: string;
  appId: string;
  name: string;
  keyPrefix: string;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdBy: string;
  createdAt: number;
}

export interface OpenApiAuditEntry {
  id: string;
  appId: string;
  appName?: string;
  keyId: string | null;
  endpoint: string;
  datasourceId: string | null;
  conversationId: string | null;
  runId: string | null;
  reportId: string | null;
  externalUserId: string | null;
  effectiveUserId: string | null;
  status: "ok" | "error" | "rejected" | "rate_limited";
  httpStatus: number;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
}

export interface OpenWebhookDeliverySummary {
  id: string;
  appId: string;
  event: string;
  targetUrl: string;
  status: "pending" | "ok" | "failed";
  attempts: number;
  httpStatus: number | null;
  responseSnippet: string | null;
  error: string | null;
  createdAt: number;
  lastAttemptAt: number | null;
}

export interface OpenPlatformStats {
  totalCalls: number;
  okCalls: number;
  errorCalls: number;
  rejectedCalls: number;
  rateLimitedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDurationMs: number;
}
