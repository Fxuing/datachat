import type {
  Column,
  DatasourceInput,
  ReportDetail,
  ReportSummary,
} from "@datachat/shared";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let unauthorizedHandler: (() => void) | undefined;

/**
 * Registered once by the app router. Tests can swap it out to observe 401 handling
 * without a router. The handler clears the query cache and redirects to /login.
 */
export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

async function parseError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = "请求失败，请稍后重试";
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
    if (body.error?.details !== undefined) details = body.error.details;
  } catch {
    // Non-JSON error bodies keep the generic message.
  }
  return new ApiError(code, message, response.status, details);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });

  if (response.status === 401) {
    unauthorizedHandler?.();
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user";
  status: "active" | "disabled";
}

export interface Conversation {
  id: string;
  datasourceId: string;
  title: string | null;
  modelId: string | null;
  thinkingLevel: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

export interface DatasourceSummary {
  id: string;
  name: string;
  type: "mysql" | "postgres";
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: "disable" | "require" | "no-verify";
  status: string;
  readOnlyVerified: boolean;
  lastCheckedAt: number | null;
}

export interface DatasourceProbeResult {
  ok: boolean;
  serverVersion?: string;
  readOnly: boolean;
  warnings: string[];
  error?: string;
}

export interface DatasourceSchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string | null;
}

export interface DatasourceSchemaIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface DatasourceSchemaForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface DatasourceSchemaTable {
  schema: string;
  name: string;
  comment: string | null;
  rowEstimate: number | null;
  columns: DatasourceSchemaColumn[];
  primaryKey: string[];
  indexes: DatasourceSchemaIndex[];
  foreignKeys: DatasourceSchemaForeignKey[];
}

/**
 * Response from `GET /api/datasources/:id/schema`. The route currently accepts
 * only `search` and always returns the first 50 matching tables; `total` is the
 * full match count, so the drawer paginates the returned rows on the client.
 */
export interface DatasourceSchemaResponse {
  tables: DatasourceSchemaTable[];
  refreshedAt: number;
  stale: boolean;
  error: string | null;
  total: number;
}

export interface ChatModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export interface ModelsResponse {
  configured: boolean;
  models: ChatModelInfo[];
  defaultId: string | null;
}

export interface ChatTool {
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  durationMs?: number;
  summary?: string;
}

export interface ChatSql {
  sql: string;
  auditId: string;
  status: "ok" | "rejected" | "error";
}

export interface ChatResult {
  artifactId: string;
  columns: Column[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export interface ChatMessage {
  runId: string;
  status: "queued" | "running" | "ok" | "error" | "aborted";
  user: { content: string };
  assistant: { content: string } | null;
  tools: ChatTool[];
  results: ChatResult[];
  sqls: ChatSql[];
  error: string | null;
  createdAt: number;
}

/** Chart/result artifact metadata attached to a conversation history response. */
export interface ChatArtifact {
  id: string;
  runId: string | null;
  kind: "result" | "chart";
  columns: Column[];
  rowCount: number;
  truncated: boolean;
  /** Persisted ECharts spec for `kind="chart"`; null when unavailable. */
  spec: unknown;
  createdAt: number;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ChatMessage[];
  artifacts: ChatArtifact[];
  activeRun: { id: string; status: "queued" | "running" } | null;
}

export interface ArtifactDetail {
  id: string;
  kind: "result" | "chart";
  conversationId: string | null;
  rowCount: number;
  truncated: boolean;
  columns: Column[];
  createdAt: number;
  spec: unknown;
}

export interface ArtifactRowsPage {
  columns: Column[];
  rows: unknown[][];
  total: number;
}

export type SkillScope = "global" | "datasource";

/** Skill row used by the admin list; deliberately excludes the markdown content. */
export interface AdminSkill {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  datasourceId: string | null;
  enabled: boolean;
  updatedAt: number;
}

export interface AdminSkillDetail extends AdminSkill {
  content: string;
  createdAt: number;
}

export interface SkillInput {
  name: string;
  description: string;
  content: string;
  scope: SkillScope;
  datasourceId?: string | null;
  enabled?: boolean;
}

export function login(input: { username: string; password: string }): Promise<{ user: SessionUser }> {
  return apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchMe(): Promise<{ user: SessionUser }> {
  return apiRequest("/api/auth/me");
}

export function logout(): Promise<{ ok: boolean }> {
  return apiRequest("/api/auth/logout", { method: "POST" });
}

export function listConversations(): Promise<{
  items: Conversation[];
  nextCursor: string | null;
}> {
  return apiRequest("/api/conversations");
}

export function createConversation(input: {
  datasourceId: string;
  title?: string;
}): Promise<{ conversation: Conversation }> {
  return apiRequest("/api/conversations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return apiRequest(`/api/conversations/${id}`);
}

export function updateConversation(
  id: string,
  patch: { title?: string; modelId?: string },
): Promise<{ conversation: Conversation }> {
  return apiRequest(`/api/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteConversation(id: string): Promise<void> {
  return apiRequest(`/api/conversations/${id}`, { method: "DELETE" });
}

export function sendMessage(
  conversationId: string,
  content: string,
): Promise<{ runId: string; position: number }> {
  return apiRequest(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export function createReport(input: {
  conversationId: string;
  title?: string;
  markdown?: string;
  artifactIds: string[];
}): Promise<{ report: ReportSummary }> {
  return apiRequest("/api/reports", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getReport(id: string): Promise<{ report: ReportDetail }> {
  return apiRequest(`/api/reports/${id}`);
}

export function deleteReport(id: string): Promise<void> {
  return apiRequest(`/api/reports/${id}`, { method: "DELETE" });
}

export function abortRun(runId: string): Promise<void> {
  return apiRequest(`/api/runs/${runId}/abort`, { method: "POST" });
}

export function listDatasources(): Promise<{ datasources: DatasourceSummary[] }> {
  return apiRequest("/api/datasources");
}

export function createDatasource(
  input: DatasourceInput,
): Promise<{ id: string; warnings: string[]; readOnly: boolean }> {
  return apiRequest("/api/datasources", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateDatasource(
  id: string,
  input: Partial<DatasourceInput>,
): Promise<{ ok: boolean }> {
  return apiRequest(`/api/datasources/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteDatasource(id: string): Promise<{ ok: boolean }> {
  return apiRequest(`/api/datasources/${id}`, { method: "DELETE" });
}

export function testDatasource(id: string): Promise<DatasourceProbeResult> {
  return apiRequest(`/api/datasources/${id}/test`, { method: "POST" });
}

export function refreshDatasourceSchema(
  id: string,
): Promise<{ tableCount: number; refreshedAt: number }> {
  return apiRequest(`/api/datasources/${id}/refresh-schema`, { method: "POST" });
}

export function getDatasourceSchema(
  id: string,
  options: { search?: string } = {},
): Promise<DatasourceSchemaResponse> {
  const params = new URLSearchParams();
  const search = options.search?.trim();
  if (search) params.set("search", search);
  const query = params.toString();
  return apiRequest(`/api/datasources/${id}/schema${query ? `?${query}` : ""}`);
}

export function listDatasourceGrants(id: string): Promise<{ userIds: string[] }> {
  return apiRequest(`/api/admin/datasources/${id}/grants`);
}

export function replaceDatasourceGrants(
  id: string,
  userIds: string[],
): Promise<{ ok: boolean }> {
  return apiRequest(`/api/admin/datasources/${id}/grants`, {
    method: "PUT",
    body: JSON.stringify({ userIds }),
  });
}

export function listAdminUsers(): Promise<{ users: SessionUser[] }> {
  return apiRequest("/api/admin/users");
}

export type AuditActionValue =
  | "query"
  | "explain"
  | "export"
  | "login"
  | "login_failed"
  | "user_create"
  | "user_update"
  | "datasource_create"
  | "datasource_update"
  | "datasource_delete"
  | "grant_update"
  | "skill_change"
  | "mcp_change";

export type AuditStatusValue = "ok" | "rejected" | "error" | "timeout";

export interface AuditEntry {
  id: string;
  runId: string | null;
  conversationId: string | null;
  userId: string | null;
  datasourceId: string | null;
  action: AuditActionValue;
  sqlText: string;
  status: AuditStatusValue;
  rowCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  detailJson: Record<string, unknown> | null;
  createdAt: number;
}

export interface AuditListFilters {
  userId?: string;
  datasourceId?: string;
  action?: AuditActionValue;
  status?: AuditStatusValue;
  /** Epoch ms (or ISO string) lower bound on `created_at`. */
  from?: number | string;
  /** Epoch ms (or ISO string) upper bound on `created_at`. */
  to?: number | string;
  limit?: number;
  offset?: number;
}

export interface AuditListResponse {
  items: AuditEntry[];
  total: number;
}

export function listAudit(filters: AuditListFilters = {}): Promise<AuditListResponse> {
  const params = new URLSearchParams();
  for (const key of ["userId", "datasourceId", "action", "status"] as const) {
    const value = filters[key];
    if (value !== undefined) params.set(key, value);
  }
  if (filters.from !== undefined) params.set("from", String(filters.from));
  if (filters.to !== undefined) params.set("to", String(filters.to));
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  const query = params.toString();
  return apiRequest(`/api/admin/audit${query ? `?${query}` : ""}`);
}

export function listModels(): Promise<ModelsResponse> {
  return apiRequest("/api/models");
}

export function getArtifact(id: string): Promise<ArtifactDetail> {
  return apiRequest(`/api/artifacts/${id}`);
}

export function getArtifactRows(
  id: string,
  options: { offset?: number; limit?: number } = {},
): Promise<ArtifactRowsPage> {
  const params = new URLSearchParams();
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return apiRequest(`/api/artifacts/${id}/rows${query ? `?${query}` : ""}`);
}

export function listSkills(): Promise<{ skills: AdminSkill[] }> {
  return apiRequest("/api/admin/skills");
}

export function getSkill(id: string): Promise<{ skill: AdminSkillDetail }> {
  return apiRequest(`/api/admin/skills/${id}`);
}

export function createSkill(input: SkillInput): Promise<{ skill: AdminSkillDetail }> {
  return apiRequest("/api/admin/skills", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSkill(
  id: string,
  input: Partial<SkillInput>,
): Promise<{ skill: AdminSkillDetail }> {
  return apiRequest(`/api/admin/skills/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteSkill(id: string): Promise<{ ok: boolean }> {
  return apiRequest(`/api/admin/skills/${id}`, { method: "DELETE" });
}

export function seedSkills(): Promise<{ imported: number; skipped: number }> {
  return apiRequest("/api/admin/skills/seed", { method: "POST" });
}

export type McpTransport = "stdio" | "http";
export type McpScope = "global" | "datasource";

/** Env/header key with its value withheld; only the presence is exposed. */
export interface MaskedSecretEntry {
  key: string;
  hasValue: boolean;
}

/** Admin view of one stored MCP server. Values are never sent to the browser. */
export interface AdminMcpServer {
  id: string;
  name: string;
  transport: McpTransport;
  scope: McpScope;
  datasourceId: string | null;
  command: string | null;
  args: string[];
  url: string | null;
  env: MaskedSecretEntry[];
  headers: MaskedSecretEntry[];
  enabled: boolean;
  createdAt: string;
}

/** Payload for create/update. `null` env/header values keep the stored value. */
export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string | null> | null;
  headers?: Record<string, string | null> | null;
  datasourceId?: string | null;
  enabled?: boolean;
}

export interface McpTestTool {
  name: string;
  description: string;
}

export interface McpTestResult {
  ok: boolean;
  tools: McpTestTool[];
  serverInfo?: { name: string; version: string };
  error?: string;
}

export function listMcpServers(): Promise<{ servers: AdminMcpServer[] }> {
  return apiRequest("/api/admin/mcp-servers");
}

export function getMcpServer(id: string): Promise<{ server: AdminMcpServer }> {
  return apiRequest(`/api/admin/mcp-servers/${id}`);
}

export function createMcpServer(input: McpServerInput): Promise<{ server: AdminMcpServer }> {
  return apiRequest("/api/admin/mcp-servers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMcpServer(
  id: string,
  input: Partial<McpServerInput>,
): Promise<{ server: AdminMcpServer }> {
  return apiRequest(`/api/admin/mcp-servers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteMcpServer(id: string): Promise<{ ok: boolean }> {
  return apiRequest(`/api/admin/mcp-servers/${id}`, { method: "DELETE" });
}

export function testMcpServer(id: string): Promise<McpTestResult> {
  return apiRequest(`/api/admin/mcp-servers/${id}/test`, { method: "POST" });
}

export interface PublicShareMessage {
  role: "user" | "assistant";
  text: string;
  sql?: string;
  columns?: Column[];
  rows?: unknown[][];
  chart?: unknown;
}

export interface PublicConversationShare {
  type: "conversation";
  title: string;
  messages: PublicShareMessage[];
  createdAt: number;
}

export interface PublicReportArtifact {
  id: string;
  kind: "result" | "chart";
  columns?: Column[];
  rows?: unknown[][];
  spec?: unknown;
}

export interface PublicReportShare {
  type: "report";
  title: string;
  markdown: string;
  artifacts: PublicReportArtifact[];
  createdAt: number;
}

export type PublicShare = PublicConversationShare | PublicReportShare;

export interface CreateShareInput {
  conversationId?: string;
  reportId?: string;
  expiresInDays?: number;
}

export interface CreatedShare {
  id: string;
  token: string;
  url: string;
  expiresAt: number;
}

export function createShare(input: CreateShareInput): Promise<{ share: CreatedShare }> {
  return apiRequest("/api/shares", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeShare(id: string): Promise<void> {
  return apiRequest(`/api/shares/${id}`, { method: "DELETE" });
}

/**
 * Public share lookup. Uses a bare fetch on purpose: this endpoint is not part of
 * the authenticated app, so a 401 must never clear the cache or redirect to /login.
 */
export async function getPublicShare(token: string): Promise<PublicShare> {
  const response = await fetch(`/api/public/shares/${encodeURIComponent(token)}`, {
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as PublicShare;
}
