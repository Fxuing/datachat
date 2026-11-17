import {
  isPermission,
  type Column,
  type DatasourceInput,
  type Permission,
  type ReportDetail,
  type ReportSummary,
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

export interface MeResponse {
  user: SessionUser;
  permissions: Permission[];
  roles: { id: string; name: string }[];
}

/** Admin user row; `role` stays the system-admin flag, `roles` are assigned custom roles. */
export interface AdminUser extends SessionUser {
  roleIds: string[];
  roles: { id: string; name: string }[];
  createdAt: number;
}

export interface CreateAdminUserInput {
  username: string;
  password: string;
  displayName?: string;
  /** System-admin flag, independent of the assigned custom roles. */
  role?: "admin" | "user";
  roleIds?: string[];
}

export interface UpdateAdminUserInput {
  displayName?: string | null;
  password?: string;
  status?: "active" | "disabled";
  role?: "admin" | "user";
  roleIds?: string[];
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
  allowWriteAccount: boolean;
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
  modelId: string;
  providerId: string;
  providerName: string;
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
  sql?: string;
}

export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ChatFeedback {
  rating: 1 | -1;
  comment: string | null;
}

export interface ChatMessage {
  runId: string;
  status: "queued" | "running" | "ok" | "error" | "aborted";
  user: { content: string; skill?: string | null };
  assistant: { content: string } | null;
  thinking?: string | null;
  /** Reasoning split where tool calls interrupted it, oldest first. */
  thinkingSegments?: string[] | null;
  usage?: ChatUsage | null;
  durationMs?: number | null;
  feedback?: ChatFeedback | null;
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
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
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

export function fetchMe(): Promise<MeResponse> {
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
  patch: { title?: string; modelId?: string; thinkingLevel?: string },
): Promise<{ conversation: Conversation }> {
  return apiRequest(`/api/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteConversation(id: string): Promise<void> {
  return apiRequest(`/api/conversations/${id}`, { method: "DELETE" });
}

export function saveRunFeedback(
  runId: string,
  input: { rating: 1 | -1; comment?: string },
): Promise<void> {
  return apiRequest(`/api/runs/${runId}/feedback`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteRunFeedback(runId: string): Promise<void> {
  return apiRequest(`/api/runs/${runId}/feedback`, { method: "DELETE" });
}

export interface ConversationSkill {
  name: string;
  description: string;
  scope: "global" | "datasource";
}

export function listConversationSkills(
  conversationId: string,
): Promise<{ skills: ConversationSkill[] }> {
  return apiRequest(`/api/conversations/${conversationId}/skills`);
}

export function listDatasourceSkills(
  datasourceId: string,
): Promise<{ skills: ConversationSkill[] }> {
  return apiRequest(`/api/datasources/${datasourceId}/skills`);
}

export function sendMessage(
  conversationId: string,
  content: string,
  skill?: string,
): Promise<{ runId: string; position: number }> {
  return apiRequest(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify(skill ? { content, skill } : { content }),
  });
}

export interface QuestionOption {
  label: string;
  description: string;
  hasPreview: boolean;
}

export interface QuestionPrompt {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionAnswerEntry {
  questionIndex: number;
  optionIndexes?: number[];
  text?: string;
  notes?: string;
}

export function answerQuestion(
  conversationId: string,
  toolCallId: string,
  input: { answers?: QuestionAnswerEntry[]; globalNote?: string; cancel?: boolean },
): Promise<void> {
  return apiRequest(
    `/api/conversations/${conversationId}/questions/${encodeURIComponent(toolCallId)}/answer`,
    { method: "POST", body: JSON.stringify(input) },
  );
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

export function retryRun(runId: string): Promise<{ runId: string; position: number }> {
  return apiRequest(`/api/runs/${runId}/retry`, { method: "POST" });
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

export function listAdminUsers(): Promise<{ users: AdminUser[] }> {
  return apiRequest("/api/admin/users");
}

export function createAdminUser(input: CreateAdminUserInput): Promise<{ user: AdminUser }> {
  return apiRequest("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAdminUser(
  id: string,
  input: UpdateAdminUserInput,
): Promise<{ user: AdminUser }> {
  return apiRequest(`/api/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** Role list row; the API returns counts instead of the permission/id arrays. */
export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
  permissionCount: number;
  datasourceCount: number;
  userCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissions: Permission[];
  datasourceIds: string[];
}

export interface RoleInput {
  name: string;
  description?: string | null;
  permissions: Permission[];
  datasourceIds: string[];
}

/** The API exposes `isBuiltin` alongside numeric `builtin`; normalize both. */
interface RawRole {
  id: string;
  name: string;
  description: string | null;
  builtin?: boolean | number;
  isBuiltin?: boolean;
  userCount?: number;
  permissionCount?: number;
  datasourceCount?: number;
  permissions?: string[];
  datasourceIds?: string[];
}

function toRoleSummary(raw: RawRole): RoleSummary {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    builtin: raw.isBuiltin ?? (raw.builtin === true || raw.builtin === 1),
    permissionCount: raw.permissionCount ?? 0,
    datasourceCount: raw.datasourceCount ?? 0,
    userCount: raw.userCount ?? 0,
  };
}

function toRoleDetail(raw: RawRole): RoleDetail {
  return {
    ...toRoleSummary(raw),
    permissions: (raw.permissions ?? []).filter(isPermission),
    datasourceIds: raw.datasourceIds ?? [],
  };
}

export async function listRoles(): Promise<{ roles: RoleSummary[] }> {
  const response = await apiRequest<{ roles: RawRole[] }>("/api/admin/roles");
  return { roles: response.roles.map(toRoleSummary) };
}

export async function getRole(id: string): Promise<{ role: RoleDetail }> {
  const response = await apiRequest<{ role: RawRole }>(`/api/admin/roles/${id}`);
  return { role: toRoleDetail(response.role) };
}

export async function createRole(input: RoleInput): Promise<{ role: RoleDetail }> {
  const response = await apiRequest<{ role: RawRole }>("/api/admin/roles", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return { role: toRoleDetail(response.role) };
}

export async function updateRole(
  id: string,
  input: Partial<RoleInput>,
): Promise<{ role: RoleDetail }> {
  const response = await apiRequest<{ role: RawRole }>(`/api/admin/roles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return { role: toRoleDetail(response.role) };
}

export function deleteRole(id: string): Promise<{ ok: true }> {
  return apiRequest(`/api/admin/roles/${id}`, { method: "DELETE" });
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
  | "mcp_change"
  | "role_change"
  | "ops";

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

export type LlmProtocol = "openai-completions" | "anthropic-messages";

export interface LlmProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export interface LlmProvider {
  id: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  enabled: boolean;
  maskedKey: string;
  models: LlmProviderModel[];
  createdAt: number;
  updatedAt: number;
}

export interface LlmProviderInput {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey?: string;
  models: Array<Pick<LlmProviderModel, "id" | "name">>;
  enabled?: boolean;
}

export function listLlmProviders(): Promise<{
  providers: LlmProvider[];
  defaultModelId: string | null;
}> {
  return apiRequest("/api/admin/llm-providers");
}

export function createLlmProvider(
  input: LlmProviderInput & { apiKey: string },
): Promise<{ provider: LlmProvider }> {
  return apiRequest("/api/admin/llm-providers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateLlmProvider(
  id: string,
  input: Partial<LlmProviderInput>,
): Promise<{ provider: LlmProvider }> {
  return apiRequest(`/api/admin/llm-providers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteLlmProvider(id: string): Promise<void> {
  return apiRequest(`/api/admin/llm-providers/${id}`, { method: "DELETE" });
}

export function testLlmProvider(input: {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
}): Promise<{ models: LlmProviderModel[]; count: number }> {
  return apiRequest("/api/admin/llm-providers/test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function refreshLlmProvider(id: string): Promise<{ provider: LlmProvider }> {
  return apiRequest(`/api/admin/llm-providers/${id}/refresh`, { method: "POST" });
}

export interface AdminSettings {
  defaultModelId: string | null;
  queryMaxRows: number;
  queryPreviewRows: number;
  queryTimeoutMs: number;
  shareMaxDays: number;
  retentionConversationDays: number;
  retentionAuditDays: number;
  memoryEnabled: boolean;
}

export type AdminSettingsPatch = {
  [K in keyof AdminSettings]?: AdminSettings[K] | null;
};


export interface OpsMetrics {
  range: { days: number; from: number; to: number };
  totals: {
    runs: number;
    ok: number;
    error: number;
    aborted: number;
    queuedOrRunning: number;
    successRate: number;
    p50Ms: number;
    p95Ms: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    activeUsers: number;
  };
  daily: Array<{
    date: string;
    runs: number;
    ok: number;
    error: number;
    aborted: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  datasources: Array<{ datasourceId: string; name: string; runs: number; failed: number }>;
  queries: {
    total: number;
    rejected: number;
    error: number;
    timeout: number;
    averageRows: number | null;
  };
}

export interface RetentionPreview {
  conversationDays: number;
  auditDays: number;
  conversationCutoff: number | null;
  auditCutoff: number | null;
  conversations: {
    eligible: number;
    willDelete: number;
    skippedActiveShares: number;
    skippedBusy: number;
    runs: number;
    events: number;
    artifacts: number;
    artifactBytes: number;
    reports: number;
    shares: number;
  };
  auditRows: number;
  oldestEligibleAt: number | null;
  newestEligibleAt: number | null;
}

export interface RetentionRunResult {
  deletedConversations: number;
  deletedRuns: number;
  deletedEvents: number;
  deletedArtifacts: number;
  deletedReports: number;
  deletedShares: number;
  deletedAuditRows: number;
  skippedActiveShares: number;
  skippedBusy: number;
  errors: Array<{ conversationId: string; message: string }>;
  durationMs: number;
}

export interface OpsBackup {
  name: string;
  createdAt: number;
  files: number;
  bytes: number;
}

export function getOpsMetrics(days: number): Promise<OpsMetrics> {
  return apiRequest(`/api/admin/ops/metrics?days=${days}`);
}

export function getRetentionPreview(): Promise<RetentionPreview> {
  return apiRequest("/api/admin/ops/retention");
}

export function runRetention(): Promise<RetentionRunResult> {
  return apiRequest("/api/admin/ops/retention/run", { method: "POST" });
}

export function listOpsBackups(): Promise<OpsBackup[]> {
  return apiRequest("/api/admin/ops/backups");
}

export function getAdminSettings(): Promise<{ settings: AdminSettings }> {
  return apiRequest("/api/admin/settings");
}

export function updateAdminSettings(
  patch: AdminSettingsPatch,
): Promise<{ settings: AdminSettings }> {
  return apiRequest("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
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

export interface ScheduledTaskSummary {
  id: string;
  name: string;
  prompt: string;
  datasourceId: string;
  datasourceName: string;
  modelId: string | null;
  cronExpression: string;
  timezone: string;
  enabled: number;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
  lastRun: {
    status: string;
    error: string | null;
    reportId: string | null;
    finishedAt: number | null;
  } | null;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  trigger: string;
  status: string;
  error: string | null;
  conversationId: string | null;
  reportId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface ScheduledTaskInput {
  name: string;
  prompt: string;
  datasourceId: string;
  cronExpression: string;
  timezone: string;
  modelId?: string | null;
  enabled?: boolean;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string | null;
  readAt: number | null;
  createdAt: number;
}

export function listScheduledTasks(): Promise<{ tasks: ScheduledTaskSummary[] }> {
  return apiRequest("/api/scheduled-tasks");
}

export function createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTaskSummary> {
  return apiRequest("/api/scheduled-tasks", { method: "POST", body: JSON.stringify(input) });
}

export function updateScheduledTask(
  id: string,
  input: Partial<ScheduledTaskInput>,
): Promise<ScheduledTaskSummary> {
  return apiRequest(`/api/scheduled-tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteScheduledTask(id: string): Promise<void> {
  return apiRequest(`/api/scheduled-tasks/${id}`, { method: "DELETE" });
}

export function runScheduledTask(id: string): Promise<ScheduledTaskRun> {
  return apiRequest(`/api/scheduled-tasks/${id}/run`, { method: "POST" });
}

export function listScheduledTaskRuns(id: string): Promise<{ runs: ScheduledTaskRun[] }> {
  return apiRequest(`/api/scheduled-tasks/${id}/runs`);
}

export function listNotifications(): Promise<{
  notifications: NotificationItem[];
  unread: number;
}> {
  return apiRequest("/api/notifications");
}

export function markNotificationRead(id: string): Promise<void> {
  return apiRequest(`/api/notifications/${id}/read`, { method: "POST" });
}

export function markAllNotificationsRead(): Promise<{ marked: number }> {
  return apiRequest("/api/notifications/read-all", { method: "POST" });
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

export type MemoryKind = "profile" | "instruction" | "preference" | "fact";
export type MemoryScope = "global" | "datasource";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  scope: MemoryScope;
  datasourceId: string | null;
  core: boolean;
  enabled: boolean;
  confidence: number;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySettings {
  enabled: boolean;
  globalEnabled: boolean;
}

export interface MemoryFilters {
  q?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  datasourceId?: string;
}

export interface MemoryInput {
  kind: MemoryKind;
  title: string;
  content: string;
  scope: MemoryScope;
  datasourceId?: string;
  core?: boolean;
  confidence?: number;
}

export function listMemories(
  filters: MemoryFilters = {},
): Promise<{ memories: MemoryItem[]; settings: MemorySettings; globalEnabled: boolean }> {
  const search = new URLSearchParams();
  if (filters.q) search.set("q", filters.q);
  if (filters.kind) search.set("kind", filters.kind);
  if (filters.scope) search.set("scope", filters.scope);
  if (filters.datasourceId) search.set("datasourceId", filters.datasourceId);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return apiRequest(`/api/memories${suffix}`);
}

export function createMemory(
  input: MemoryInput,
): Promise<{ memory: MemoryItem; merged: boolean }> {
  return apiRequest("/api/memories", { method: "POST", body: JSON.stringify(input) });
}

export function updateMemory(
  id: string,
  input: Partial<Pick<MemoryItem, "title" | "content" | "core" | "enabled" | "confidence">>,
): Promise<{ memory: MemoryItem }> {
  return apiRequest(`/api/memories/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteMemory(id: string): Promise<void> {
  return apiRequest(`/api/memories/${id}`, { method: "DELETE" });
}

export function clearMemories(): Promise<{ cleared: number }> {
  return apiRequest("/api/memories/clear", { method: "POST" });
}

export function getMemorySettings(): Promise<MemorySettings> {
  return apiRequest("/api/memories/settings");
}

export function updateMemorySettings(enabled: boolean): Promise<{ enabled: boolean }> {
  return apiRequest("/api/memories/settings", { method: "PATCH", body: JSON.stringify({ enabled }) });
}
