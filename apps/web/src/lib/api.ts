import {
  isPermission,
  type Column,
  type DatasourceInput,
  type OptionFieldSchema,
  type Permission,
  type PublicDriverDescriptor,
  type ReportDetail,
  type ReportSummary,
  type RunMemory,
} from "@datachat/shared";

export type { OptionFieldSchema, PublicDriverDescriptor };

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
  if (
    init.body !== undefined &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
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
  /** Names of the departments the session user belongs to; empty when unassigned. */
  departmentNames?: string[];
}

/** Admin user row; `role` stays the system-admin flag, `roles` are assigned custom roles. */
export interface AdminUser extends SessionUser {
  roleIds: string[];
  roles: { id: string; name: string }[];
  departments?: UserDepartment[];
  createdAt: number;
}

export interface UserDepartment {
  id: string;
  name: string;
  code: string;
  isPrimary: boolean;
}

export interface DepartmentRow {
  id: string;
  name: string;
  code: string;
  parentId: string | null;
  sortOrder: number;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface DepartmentNode extends Omit<DepartmentRow, "status"> {
  status: "active" | "archived";
  memberCount: number;
  datasourceIds: string[];
  children: DepartmentNode[];
}

export type ScopeMode = "off" | "configuring" | "enabled";
export type ScopeValueMode =
  | "literal"
  | "department_id"
  | "department_code"
  | "external_id"
  | "external_code"
  | "external_org_code"
  | "user_id"
  | "username"
  | "role";
export type ScopePolicyMode = "scoped" | "public" | "denied";

export type ScopeRuleOperator = "eq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte";

export interface ScopeRule {
  id: string;
  columnName: string;
  operator: ScopeRuleOperator;
  valueMode: ScopeValueMode;
  literalValues: string[];
  nullVisible: boolean;
}

export interface ScopeRuleInput {
  columnName: string;
  operator?: ScopeRuleOperator;
  valueMode?: ScopeValueMode;
  literalValues?: string[];
  nullVisible?: boolean;
}

export interface ScopePolicy {
  id: string;
  datasourceId: string;
  tableName: string;
  mode: ScopePolicyMode;
  enabled: boolean;
  rules: ScopeRule[];
}

export interface ScopePolicyInput {
  tableName: string;
  mode: ScopePolicyMode;
  enabled?: boolean;
  rules?: ScopeRuleInput[];
}

export interface DepartmentMapping {
  id: string;
  datasourceId: string;
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  externalId: string | null;
  externalCode: string | null;
  externalOrgCode: string | null;
  source: "manual" | "import";
}

export interface ScopeCoverage {
  policies?: { total: number; classified: number; unclassified: string[] };
  departments?: {
    mapped: number;
    unmapped: number;
    unmappedIds: string[];
    unmappedDepartments?: { id: string; name: string; code: string }[];
  };
  schemaLoaded?: boolean;
}

export interface DataScopeConfig {
  datasourceId: string;
  mode: ScopeMode;
  policies: ScopePolicy[];
  mappings: DepartmentMapping[];
  coverage: ScopeCoverage;
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
  sourceKind?: "datasource" | "file";
  datasourceId: string | null;
  title: string | null;
  modelId: string | null;
  thinkingLevel: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

export type FileColumnType = "INTEGER" | "REAL" | "TEXT" | "DATE" | "DATETIME";
export type FileColumnFormatHint = "currency" | "percent" | "thousands";

export interface FileTableColumn {
  name: string;
  originalName: string;
  type: FileColumnType;
  nullable: boolean;
  formatHint?: FileColumnFormatHint;
  sampleValues: string[];
}

export interface ConversationFileSummary {
  id: string;
  conversationId: string;
  fileName: string;
  fileType: "xlsx" | "csv";
  sizeBytes: number;
  headerRow: number;
  tableCount: number;
  rowCount: number;
  createdAt: number;
}

export interface ConversationFileTableSummary {
  id: string;
  conversationId: string;
  fileId: string;
  tableName: string;
  displayName: string;
  sheetName: string | null;
  rowCount: number;
  columns: FileTableColumn[];
  sampleRows: Array<Array<string | number | null>>;
  warnings: string[];
  createdAt: number;
}

export type PreviewFileTable = Omit<
  ConversationFileTableSummary,
  "id" | "conversationId" | "fileId" | "createdAt"
>;

export interface PreviewFileItem {
  fileName: string;
  fileType: "xlsx" | "csv";
  sizeBytes: number;
  headerRow: number;
  detectedHeaderRow: number;
  tableCount: number;
  rowCount: number;
  tables: PreviewFileTable[];
}

export interface FilePreviewResponse {
  files: PreviewFileItem[];
  totalTables: number;
  totalRows: number;
}

export interface DatasourceSummary {
  id: string;
  name: string;
  type: string;
  driverLabel?: string;
  driverAvailable?: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: "disable" | "require" | "no-verify";
  options?: Record<string, string | number | boolean>;
  secretOptionKeys?: string[];
  status: string;
  readOnlyVerified: boolean;
  allowWriteAccount: boolean;
  lastCheckedAt: number | null;
}

export function datasourceTypeLabel(source: { type: string; driverLabel?: string }): string {
  if (source.driverLabel) return source.driverLabel;
  if (source.type === "mysql") return "MySQL";
  if (source.type === "postgres") return "PostgreSQL";
  return source.type;
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
  url?: string;
}

export interface ChatReport {
  reportId: string;
  title: string;
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
  /** Memories that were injected into this turn. */
  memories?: RunMemory[] | null;
  usage?: ChatUsage | null;
  durationMs?: number | null;
  feedback?: ChatFeedback | null;
  tools: ChatTool[];
  results: ChatResult[];
  sqls: ChatSql[];
  reports?: ChatReport[];
  /** Department range that filtered this run; null when nothing was rewritten. */
  scope?: { departments: string[] } | null;
  /** Cached follow-up suggestions; null means a finished run has not generated them yet. */
  suggestions?: string[] | null;
  error: string | null;
  createdAt: number;
}

/** Chart/result artifact metadata attached to a conversation history response. */
export interface ChatArtifact {
  id: string;
  runId: string | null;
  kind: "result" | "chart" | "excel";
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
  files?: ConversationFileSummary[];
  tables?: ConversationFileTableSummary[];
  activeRun: { id: string; status: "queued" | "running" } | null;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
}

export interface ArtifactDetail {
  id: string;
  kind: "result" | "chart" | "excel";
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

export function listConversations(
  params: { q?: string; before?: string } = {},
): Promise<{
  items: Conversation[];
  nextCursor: string | null;
}> {
  const search = new URLSearchParams();
  const q = params.q?.trim();
  if (q) search.set("q", q);
  if (params.before) search.set("before", params.before);
  const qs = search.toString();
  return apiRequest(qs ? `/api/conversations?${qs}` : "/api/conversations");
}

export function createConversation(input: {
  datasourceId: string;
  title?: string;
  modelId?: string;
  thinkingLevel?: string;
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

export function listGlobalSkills(): Promise<{ skills: ConversationSkill[] }> {
  return apiRequest("/api/skills/global");
}

function buildFilesFormData(
  files: File[],
  headerRows?: Array<number | undefined>,
  extraFields?: Record<string, string | undefined>,
): FormData {
  const formData = new FormData();
  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      if (value !== undefined && value !== "") {
        formData.append(key, value);
      }
    }
  }
  if (headerRows && headerRows.length > 0) {
    formData.append(
      "headerRows",
      JSON.stringify(files.map((_, index) => headerRows[index] ?? 0)),
    );
  }
  for (const file of files) {
    formData.append("files", file);
  }
  return formData;
}

export function previewUploadedFiles(input: {
  files: File[];
  headerRows?: Array<number | undefined>;
}): Promise<FilePreviewResponse> {
  return apiRequest("/api/files/preview", {
    method: "POST",
    body: buildFilesFormData(input.files, input.headerRows),
  });
}

export function createFileConversation(input: {
  files: File[];
  headerRows?: Array<number | undefined>;
  title?: string;
  modelId?: string;
  thinkingLevel?: string;
}): Promise<{
  conversation: Conversation;
  files: ConversationFileSummary[];
  tables: ConversationFileTableSummary[];
}> {
  return apiRequest("/api/conversations/file", {
    method: "POST",
    body: buildFilesFormData(input.files, input.headerRows, {
      title: input.title,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
    }),
  });
}

export interface FileDatasetTableSummary {
  id: string;
  datasetId: string;
  tableName: string;
  displayName: string;
  sheetName: string | null;
  rowCount: number;
  columns: FileTableColumn[];
  sampleRows: Array<Array<string | number | null>>;
  warnings: string[];
  createdAt: number;
}

export interface FileDatasetSummary {
  id: string;
  name: string;
  description: string | null;
  fileType: "xlsx" | "csv";
  fileCount: number;
  tableCount: number;
  rowCount: number;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  tables: FileDatasetTableSummary[];
}

export function listFileDatasets(): Promise<{ datasets: FileDatasetSummary[] }> {
  return apiRequest("/api/file-datasets");
}

export function saveConversationAsDataset(
  conversationId: string,
  input: { name: string; description?: string },
): Promise<{ dataset: FileDatasetSummary }> {
  return apiRequest(`/api/file-datasets/from-conversation/${conversationId}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateFileDataset(
  id: string,
  input: { name?: string; description?: string | null },
): Promise<{ dataset: FileDatasetSummary }> {
  return apiRequest(`/api/file-datasets/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteFileDataset(id: string): Promise<void> {
  return apiRequest(`/api/file-datasets/${id}`, { method: "DELETE" });
}

export function createConversationFromDataset(input: {
  datasetId: string;
  title?: string;
  modelId?: string;
  thinkingLevel?: string;
}): Promise<{
  conversation: Conversation;
  files: ConversationFileSummary[];
  tables: ConversationFileTableSummary[];
}> {
  return apiRequest("/api/conversations/from-dataset", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function appendConversationFiles(
  conversationId: string,
  input: {
    files: File[];
    headerRows?: Array<number | undefined>;
  },
): Promise<{
  files: ConversationFileSummary[];
  tables: ConversationFileTableSummary[];
  addedFiles: ConversationFileSummary[];
  addedTables: ConversationFileTableSummary[];
}> {
  return apiRequest(`/api/conversations/${conversationId}/files`, {
    method: "POST",
    body: buildFilesFormData(input.files, input.headerRows),
  });
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

export interface SemanticMetric {
  id: string;
  datasourceId: string;
  name: string;
  synonyms: string[];
  description: string | null;
  sqlExpression: string;
  tableName: string | null;
  defaultFilters: string[];
  timeColumn: string | null;
  unit: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SemanticJoinType = "inner" | "left" | "right";

export interface SemanticRelation {
  id: string;
  datasourceId: string;
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  joinType: SemanticJoinType;
  description: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SemanticSchemaTableOption {
  name: string;
  comment: string | null;
  columns: string[];
}

export type SqlExampleSource = "manual" | "feedback_up" | "feedback_fix";
export type FeedbackReviewStatus = "pending" | "promoted" | "dismissed";

export interface SqlExample {
  id: string;
  datasourceId: string;
  question: string;
  sqlText: string;
  notes: string | null;
  tables: string[];
  source: SqlExampleSource;
  sourceRunId: string | null;
  enabled: boolean;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SqlExampleInput {
  question: string;
  sqlText: string;
  notes?: string | null;
  source?: SqlExampleSource;
  sourceRunId?: string | null;
  enabled?: boolean;
}

export interface FeedbackSqlEntry {
  sql: string;
  status: string;
  rowCount: number | null;
  errorMessage: string | null;
}

export interface DatasourceFeedbackItem {
  id: string;
  runId: string;
  conversationId: string;
  conversationTitle: string | null;
  username: string;
  displayName: string | null;
  rating: 1 | -1;
  comment: string | null;
  reviewStatus: FeedbackReviewStatus;
  reviewedAt: number | null;
  prompt: string;
  runStatus: string;
  sqlQueries: FeedbackSqlEntry[];
  promotedExampleId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DatasourceFeedbackSummary {
  pendingNegative: number;
  pendingPositive: number;
  totalExamples: number;
  enabledExamples: number;
}

export interface SemanticLayerResponse {
  datasource: { id: string; name: string; type: string };
  metrics: SemanticMetric[];
  relations: SemanticRelation[];
  examples?: SqlExample[];
  feedbackSummary?: DatasourceFeedbackSummary;
  tables: SemanticSchemaTableOption[];
}

export interface SemanticMetricInput {
  name: string;
  synonyms?: string[];
  description?: string | null;
  sqlExpression: string;
  tableName?: string | null;
  defaultFilters?: string[];
  timeColumn?: string | null;
  unit?: string | null;
  enabled?: boolean;
  sourceRunId?: string | null;
}

export interface SemanticRelationInput {
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  joinType?: SemanticJoinType;
  description?: string | null;
  enabled?: boolean;
}

export function getSemanticLayer(datasourceId: string): Promise<SemanticLayerResponse> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic`);
}

export function createSemanticMetric(
  datasourceId: string,
  input: SemanticMetricInput,
): Promise<{ metric: SemanticMetric }> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/metrics`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSemanticMetric(
  datasourceId: string,
  id: string,
  input: Partial<SemanticMetricInput>,
): Promise<{ metric: SemanticMetric }> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/metrics/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteSemanticMetric(datasourceId: string, id: string): Promise<void> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/metrics/${id}`, {
    method: "DELETE",
  });
}

export function createSemanticRelation(
  datasourceId: string,
  input: SemanticRelationInput,
): Promise<{ relation: SemanticRelation }> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/relations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSemanticRelation(
  datasourceId: string,
  id: string,
  input: Partial<SemanticRelationInput>,
): Promise<{ relation: SemanticRelation }> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/relations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteSemanticRelation(datasourceId: string, id: string): Promise<void> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/relations/${id}`, {
    method: "DELETE",
  });
}

export function previewSemanticRecall(
  datasourceId: string,
  query: string,
): Promise<{ text: string; metricIds: string[]; relationIds: string[]; exampleIds?: string[] }> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/preview`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

export function createSqlExample(
  datasourceId: string,
  input: SqlExampleInput,
): Promise<{ example: SqlExample }> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/examples`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSqlExample(
  datasourceId: string,
  id: string,
  input: Partial<SqlExampleInput>,
): Promise<{ example: SqlExample }> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/examples/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteSqlExample(datasourceId: string, id: string): Promise<void> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/examples/${id}`, {
    method: "DELETE",
  });
}

export function listDatasourceFeedback(
  datasourceId: string,
  params?: { rating?: "all" | "1" | "-1"; status?: "all" | FeedbackReviewStatus },
): Promise<{ items: DatasourceFeedbackItem[]; summary: DatasourceFeedbackSummary }> {
  const qs = new URLSearchParams();
  if (params?.rating) qs.set("rating", params.rating);
  if (params?.status) qs.set("status", params.status);
  const query = qs.toString();
  return apiRequest(
    `/api/admin/datasources/${datasourceId}/semantic/feedback${query ? `?${query}` : ""}`,
  );
}

export function updateDatasourceFeedbackStatus(
  datasourceId: string,
  id: string,
  reviewStatus: FeedbackReviewStatus,
): Promise<{ ok: boolean; reviewStatus: FeedbackReviewStatus }> {
  return apiRequest(`/api/admin/datasources/${datasourceId}/semantic/feedback/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ reviewStatus }),
  });
}

export interface DashboardSummary {
  id: string;
  name: string;
  description: string | null;
  cardCount: number;
  refreshCron?: string | null;
  refreshTimezone?: string;
  nextRefreshAt?: number | null;
  lastAutoRefreshedAt?: number | null;
  lastAutoRefreshError?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardCard {
  id: string;
  dashboardId: string;
  title: string;
  sourceConversationId: string | null;
  sourceArtifactId: string | null;
  datasourceId: string | null;
  datasourceName: string | null;
  refreshable: boolean;
  sqlText?: string | null;
  spec: unknown;
  points: number;
  width: 1 | 2;
  position: number;
  lastRefreshedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardDetail extends DashboardSummary {
  cards: DashboardCard[];
}

export function listDashboards(): Promise<{ dashboards: DashboardSummary[] }> {
  return apiRequest("/api/dashboards");
}

export function createDashboard(input: {
  name: string;
  description?: string | null;
}): Promise<{ dashboard: DashboardSummary }> {
  return apiRequest("/api/dashboards", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getDashboard(id: string): Promise<{ dashboard: DashboardDetail }> {
  return apiRequest(`/api/dashboards/${id}`);
}

export function updateDashboard(
  id: string,
  input: {
    name?: string;
    description?: string | null;
    refreshCron?: string | null;
    refreshTimezone?: string;
  },
): Promise<{ dashboard: DashboardDetail }> {
  return apiRequest(`/api/dashboards/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteDashboard(id: string): Promise<void> {
  return apiRequest(`/api/dashboards/${id}`, { method: "DELETE" });
}

export function pinChartToDashboard(
  dashboardId: string,
  input: { artifactId: string; title?: string; width?: 1 | 2 },
): Promise<{ card: DashboardCard }> {
  return apiRequest(`/api/dashboards/${dashboardId}/cards/from-artifact`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateDashboardCard(
  dashboardId: string,
  cardId: string,
  input: { title?: string; width?: 1 | 2; sqlText?: string },
): Promise<{ card: DashboardCard }> {
  return apiRequest(`/api/dashboards/${dashboardId}/cards/${cardId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function reorderDashboardCards(
  dashboardId: string,
  cardIds: string[],
): Promise<{ cards: DashboardCard[] }> {
  return apiRequest(`/api/dashboards/${dashboardId}/cards/reorder`, {
    method: "PATCH",
    body: JSON.stringify({ cardIds }),
  });
}

export function deleteDashboardCard(dashboardId: string, cardId: string): Promise<void> {
  return apiRequest(`/api/dashboards/${dashboardId}/cards/${cardId}`, { method: "DELETE" });
}

export function refreshDashboardCard(
  dashboardId: string,
  cardId: string,
): Promise<{ card: DashboardCard }> {
  return apiRequest(`/api/dashboards/${dashboardId}/cards/${cardId}/refresh`, {
    method: "POST",
  });
}

export function refreshAllDashboardCards(
  dashboardId: string,
): Promise<{ refreshed: number; failed: number; skipped: number; cards: DashboardCard[] }> {
  return apiRequest(`/api/dashboards/${dashboardId}/refresh`, { method: "POST" });
}

export interface ReportListItem {
  id: string;
  conversationId: string;
  title: string;
  artifactIds: string[];
  artifactCount: number;
  source: "chat" | "scheduled";
  sourceKind: "datasource" | "file";
  datasourceId: string | null;
  datasourceName: string | null;
  conversationTitle: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReportListResponse {
  reports: ReportListItem[];
  total: number;
}

export function listReports(
  params: {
    q?: string;
    source?: "all" | "chat" | "scheduled";
    datasourceId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ReportListResponse> {
  const qs = new URLSearchParams();
  if (params.q?.trim()) qs.set("q", params.q.trim());
  if (params.source && params.source !== "all") qs.set("source", params.source);
  if (params.datasourceId) qs.set("datasourceId", params.datasourceId);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return apiRequest(`/api/reports${query ? `?${query}` : ""}`);
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

export function updateReport(
  id: string,
  input: { title?: string; markdown?: string },
): Promise<{ report: ReportDetail }> {
  return apiRequest(`/api/reports/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
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

export function getRunSuggestions(runId: string): Promise<{ suggestions: string[] }> {
  return apiRequest(`/api/runs/${runId}/suggestions`);
}

export function listDatasources(): Promise<{ datasources: DatasourceSummary[] }> {
  return apiRequest("/api/datasources");
}

export interface AdminDriverPluginItem {
  id: string;
  label: string;
  source: "builtin" | "env" | "upload";
  builtin: boolean;
  enabled: boolean;
  loaded: boolean;
  version: string | null;
  fileName: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  defaultPort: number | null;
  supportsSsl: boolean;
  capabilities: {
    explain: boolean;
    readOnlyProbe: boolean;
    rowScope: boolean;
  } | null;
  optionsSchema: OptionFieldSchema[];
  datasourceCount: number;
  uploadedAt: number | null;
  updatedAt: number | null;
}

export interface AdminDatasourcePluginsResponse {
  allowUpload: boolean;
  drivers: AdminDriverPluginItem[];
}

export function listDatasourceDrivers(): Promise<{ drivers: PublicDriverDescriptor[] }> {
  return apiRequest("/api/datasources/drivers");
}

export function listAdminDatasourcePlugins(): Promise<AdminDatasourcePluginsResponse> {
  return apiRequest("/api/admin/datasource-plugins");
}

export function uploadDatasourcePlugin(
  file: File,
  options?: { replace?: boolean },
): Promise<{ plugin: AdminDriverPluginItem; replaced: boolean }> {
  const formData = new FormData();
  if (options?.replace) {
    formData.append("replace", "true");
  }
  formData.append("file", file);
  return apiRequest("/api/admin/datasource-plugins/upload", {
    method: "POST",
    body: formData,
  });
}

export function toggleDatasourcePlugin(
  driverId: string,
  enabled: boolean,
): Promise<{ plugin: AdminDriverPluginItem }> {
  return apiRequest(`/api/admin/datasource-plugins/${encodeURIComponent(driverId)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function deleteDatasourcePlugin(driverId: string): Promise<{ ok: boolean }> {
  return apiRequest(`/api/admin/datasource-plugins/${encodeURIComponent(driverId)}`, {
    method: "DELETE",
  });
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

export interface DatasourceCatalogMetric {
  id: string;
  name: string;
  synonyms: string[];
  description: string | null;
  tableName: string | null;
  timeColumn: string | null;
  unit: string | null;
}

export interface DatasourceCatalogRelation {
  id: string;
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  joinType: SemanticJoinType;
  description: string | null;
}

export interface DatasourceStarterQuestion {
  title: string;
  body: string;
  source: "example" | "metric";
}

export interface DatasourceCatalogResponse {
  datasourceId: string;
  refreshedAt: number | null;
  stale: boolean;
  tableCount: number;
  scopeNotice: string | null;
  metrics: DatasourceCatalogMetric[];
  relations: DatasourceCatalogRelation[];
  starterQuestions: DatasourceStarterQuestion[];
}

export function getDatasourceCatalog(id: string): Promise<DatasourceCatalogResponse> {
  return apiRequest(`/api/datasources/${id}/catalog`);
}

export interface DatasourceGrantsResponse {
  userIds: string[];
  departmentIds: string[];
  inheritedUsers: Record<string, string[]>;
}

export async function listDatasourceGrants(id: string): Promise<DatasourceGrantsResponse> {
  const raw = await apiRequest<Partial<DatasourceGrantsResponse>>(
    `/api/admin/datasources/${id}/grants`,
  );
  return {
    userIds: raw.userIds ?? [],
    departmentIds: raw.departmentIds ?? [],
    inheritedUsers: raw.inheritedUsers ?? {},
  };
}

export function replaceDatasourceGrants(
  id: string,
  input: { userIds?: string[]; departmentIds?: string[] },
): Promise<{ ok: boolean }> {
  return apiRequest(`/api/admin/datasources/${id}/grants`, {
    method: "PUT",
    body: JSON.stringify(input),
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

/** Role list row; roles govern functional permissions only. */
export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
  permissionCount: number;
  userCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissions: Permission[];
}

export interface RoleInput {
  name: string;
  description?: string | null;
  permissions: Permission[];
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
  permissions?: string[];
}

function toRoleSummary(raw: RawRole): RoleSummary {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    builtin: raw.isBuiltin ?? (raw.builtin === true || raw.builtin === 1),
    permissionCount: raw.permissionCount ?? 0,
    userCount: raw.userCount ?? 0,
  };
}

function toRoleDetail(raw: RawRole): RoleDetail {
  return {
    ...toRoleSummary(raw),
    permissions: (raw.permissions ?? []).filter(isPermission),
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

export interface PublicDashboardCard {
  title: string;
  width: 1 | 2;
  points: number;
  spec: unknown;
  lastRefreshedAt: number | null;
}

export interface PublicDashboardShare {
  type: "dashboard";
  title: string;
  description: string | null;
  cards: PublicDashboardCard[];
  createdAt: number;
  updatedAt: number;
}

export type PublicShare =
  | PublicConversationShare
  | PublicReportShare
  | PublicDashboardShare;

export interface CreateShareInput {
  conversationId?: string;
  reportId?: string;
  dashboardId?: string;
  expiresInDays?: number;
}

export interface CreatedShare {
  id: string;
  token: string;
  url: string;
  expiresAt: number;
}

export interface ShareListItem {
  id: string;
  targetType: "conversation" | "report" | "dashboard";
  targetId: string;
  targetTitle: string;
  createdBy: string;
  creatorUsername?: string;
  expiresAt: number;
  revokedAt: number | null;
  status: "active" | "expired" | "revoked";
  createdAt: number;
}

export function listShares(
  params: {
    conversationId?: string;
    reportId?: string;
    dashboardId?: string;
    status?: "active" | "all";
    scope?: "mine" | "all";
  } = {},
): Promise<{ shares: ShareListItem[] }> {
  const qs = new URLSearchParams();
  if (params.conversationId) qs.set("conversationId", params.conversationId);
  if (params.reportId) qs.set("reportId", params.reportId);
  if (params.dashboardId) qs.set("dashboardId", params.dashboardId);
  if (params.status) qs.set("status", params.status);
  if (params.scope) qs.set("scope", params.scope);
  const query = qs.toString();
  return apiRequest(`/api/shares${query ? `?${query}` : ""}`);
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

export async function getPublicShareReport(
  token: string,
  reportId: string,
): Promise<PublicReportShare> {
  const response = await fetch(
    `/api/public/shares/${encodeURIComponent(token)}/reports/${encodeURIComponent(reportId)}`,
    {
      credentials: "omit",
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as PublicReportShare;
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


export function listDepartments(): Promise<{
  departments: DepartmentNode[];
  flat: DepartmentRow[];
}> {
  return apiRequest("/api/admin/departments");
}

export function createDepartment(input: {
  name: string;
  code?: string;
  parentId?: string | null;
  sortOrder?: number;
}): Promise<{ department: DepartmentRow }> {
  return apiRequest("/api/admin/departments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateDepartment(
  id: string,
  input: { name?: string; code?: string; sortOrder?: number; status?: "active" | "archived" },
): Promise<{ department: DepartmentRow }> {
  return apiRequest(`/api/admin/departments/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function moveDepartment(
  id: string,
  parentId: string | null,
): Promise<{ department: DepartmentRow }> {
  return apiRequest(`/api/admin/departments/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ parentId }),
  });
}

export function deleteDepartment(id: string): Promise<void> {
  return apiRequest(`/api/admin/departments/${id}`, { method: "DELETE" });
}

export function listDepartmentMembers(
  id: string,
): Promise<{ members: { id: string; username: string; displayName: string | null; isPrimary: boolean }[] }> {
  return apiRequest(`/api/admin/departments/${id}/members`);
}

export function getDepartmentGrants(id: string): Promise<{ datasourceIds: string[] }> {
  return apiRequest(`/api/admin/departments/${id}/grants`);
}

export function setDepartmentGrants(id: string, datasourceIds: string[]): Promise<{ ok: boolean }> {
  return apiRequest(`/api/admin/departments/${id}/grants`, {
    method: "PUT",
    body: JSON.stringify({ datasourceIds }),
  });
}

export function getUserDepartments(id: string): Promise<{ departments: UserDepartment[] }> {
  return apiRequest(`/api/admin/users/${id}/departments`);
}

export function setUserDepartments(
  id: string,
  departmentIds: string[],
  primaryId?: string | null,
): Promise<{ departments: UserDepartment[] }> {
  return apiRequest(`/api/admin/users/${id}/departments`, {
    method: "PUT",
    body: JSON.stringify({ departmentIds, ...(primaryId !== undefined ? { primaryId } : {}) }),
  });
}

export function getDataScope(id: string): Promise<DataScopeConfig> {
  return apiRequest(`/api/admin/datasources/${id}/scope`);
}

export function putScopePolicies(
  id: string,
  policies: ScopePolicyInput[],
): Promise<{ policies: ScopePolicy[] }> {
  return apiRequest(`/api/admin/datasources/${id}/scope/policies`, {
    method: "PUT",
    body: JSON.stringify({ policies }),
  });
}

export function getScopeMappings(
  id: string,
): Promise<{ mappings: DepartmentMapping[]; coverage: ScopeCoverage["departments"] }> {
  return apiRequest(`/api/admin/datasources/${id}/scope/mappings`);
}

export function importScopeMappings(
  id: string,
  input: { mappings?: unknown[]; csv?: string },
): Promise<{ inserted: number; updated: number; errors: string[] }> {
  return apiRequest(`/api/admin/datasources/${id}/scope/mappings`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteScopeMapping(id: string, departmentId: string): Promise<void> {
  return apiRequest(`/api/admin/datasources/${id}/scope/mappings/${departmentId}`, {
    method: "DELETE",
  });
}

export function previewScope(
  id: string,
  userId: string,
  sql: string,
): Promise<{ sql: string; params: unknown[]; appliedTables: string[] }> {
  return apiRequest(`/api/admin/datasources/${id}/scope/preview`, {
    method: "POST",
    body: JSON.stringify({ userId, sql }),
  });
}

export interface ScopeDiagnostics {
  datasourceId: string;
  mode: ScopeMode;
  userId: string;
  isAdmin: boolean;
  canAccessDatasource: boolean;
  departments: UserDepartment[];
  effectiveDepartmentIds: string[] | null;
  tables: {
    table: string;
    decision: string;
    rules?: {
      column: string;
      operator: ScopeRuleOperator;
      valueMode: ScopeValueMode;
      literalValues: string[];
      nullVisible: boolean;
    }[];
    departments?: string[];
  }[];
}

export function getScopeDiagnostics(id: string, userId: string): Promise<ScopeDiagnostics> {
  return apiRequest(
    `/api/admin/datasources/${id}/scope/diagnostics?userId=${encodeURIComponent(userId)}`,
  );
}

export function getScopeDenials(id: string): Promise<{
  denials: {
    id: string;
    userId: string;
    username: string | null;
    action: string;
    scopeReason: string | null;
    sqlText: string;
    createdAt: number;
  }[];
}> {
  return apiRequest(`/api/admin/datasources/${id}/scope/denials`);
}

export function enableScope(id: string): Promise<{ mode: ScopeMode; revokedShares: number }> {
  return apiRequest(`/api/admin/datasources/${id}/scope/enable`, { method: "POST" });
}

export function disableScope(id: string): Promise<{ mode: ScopeMode }> {
  return apiRequest(`/api/admin/datasources/${id}/scope/disable`, { method: "POST" });
}

export interface ScopeColumnTable {
  name: string;
  columns: { name: string; type: string; comment: string | null }[];
}

export function getScopeColumns(id: string): Promise<{
  refreshedAt: number;
  tables: ScopeColumnTable[];
  candidates: { table: string; column: string }[];
  autoMatched: ScopePolicyInput[];
}> {
  return apiRequest(`/api/admin/datasources/${id}/scope/columns`);
}

// ---------- Open Platform Admin ----------

import type {
  OpenApiAuditEntry,
  OpenApiKeySummary,
  OpenAppScope,
  OpenAppSummary,
  OpenAskResult,
  OpenEndUserContext,
  OpenPlatformStats,
  OpenReportResult,
  OpenWebhookDeliverySummary,
} from "@datachat/shared";

export type {
  OpenApiAuditEntry,
  OpenApiKeySummary,
  OpenAppScope,
  OpenAppSummary,
  OpenAskResult,
  OpenEndUserContext,
  OpenPlatformStats,
  OpenReportResult,
  OpenWebhookDeliverySummary,
};

export interface OpenAppInput {
  name: string;
  description?: string | null;
  status?: "active" | "disabled";
  serviceUserId: string;
  allowedDatasourceIds: string[] | null;
  scopes: OpenAppScope[];
  allowEndUserOverride?: boolean;
  exposeSql?: boolean;
  defaultModelId?: string | null;
  systemPromptExtra?: string | null;
  rateLimitRpm?: number;
  maxRowsOverride?: number | null;
  timeoutMsOverride?: number | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}

export function listOpenApps(): Promise<{ items: OpenAppSummary[] }> {
  return apiRequest("/api/admin/open-platform/apps");
}

export function createOpenApp(input: OpenAppInput): Promise<{ app: OpenAppSummary }> {
  return apiRequest("/api/admin/open-platform/apps", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateOpenApp(
  id: string,
  input: Partial<OpenAppInput>,
): Promise<{ app: OpenAppSummary }> {
  return apiRequest(`/api/admin/open-platform/apps/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteOpenApp(id: string): Promise<void> {
  return apiRequest(`/api/admin/open-platform/apps/${id}`, { method: "DELETE" });
}

export function listOpenApiKeys(appId: string): Promise<{ items: OpenApiKeySummary[] }> {
  return apiRequest(`/api/admin/open-platform/apps/${appId}/keys`);
}

export function createOpenApiKey(
  appId: string,
  input: { name: string; expiresInDays?: number | null },
): Promise<{ key: OpenApiKeySummary; rawKey: string }> {
  return apiRequest(`/api/admin/open-platform/apps/${appId}/keys`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeOpenApiKey(
  appId: string,
  keyId: string,
): Promise<{ key: OpenApiKeySummary }> {
  return apiRequest(`/api/admin/open-platform/apps/${appId}/keys/${keyId}/revoke`, {
    method: "POST",
  });
}

export function listOpenApiAudit(
  filters: {
    appId?: string;
    status?: "ok" | "error" | "rejected" | "rate_limited";
    limit?: number;
    days?: number;
  } = {},
): Promise<{ items: OpenApiAuditEntry[]; stats: OpenPlatformStats }> {
  const params = new URLSearchParams();
  if (filters.appId) params.set("appId", filters.appId);
  if (filters.status) params.set("status", filters.status);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.days) params.set("days", String(filters.days));
  const query = params.toString();
  return apiRequest(`/api/admin/open-platform/audit${query ? `?${query}` : ""}`);
}

export function listOpenWebhookDeliveries(
  filters: { appId?: string; limit?: number } = {},
): Promise<{ items: OpenWebhookDeliverySummary[] }> {
  const params = new URLSearchParams();
  if (filters.appId) params.set("appId", filters.appId);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  return apiRequest(`/api/admin/open-platform/webhooks${query ? `?${query}` : ""}`);
}

export function replayOpenWebhook(
  deliveryId: string,
): Promise<{ delivery: OpenWebhookDeliverySummary }> {
  return apiRequest(`/api/admin/open-platform/webhooks/${deliveryId}/replay`, {
    method: "POST",
  });
}

export function runOpenPlayground(
  appId: string,
  input: {
    action: "ask" | "report";
    datasourceId: string;
    prompt: string;
    title?: string;
    sections?: string[];
    endUser?: OpenEndUserContext;
  },
): Promise<{ action: "ask"; result: OpenAskResult } | { action: "report"; result: OpenReportResult }> {
  return apiRequest(`/api/admin/open-platform/apps/${appId}/playground`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Calls `/api/open/v1/*` directly from the public `/open-docs` Try-It-Out runner using the
 * caller-supplied API Key. Intentionally omits session cookies and never triggers login redirects.
 */
export async function openApiTryRequest(
  path: string,
  input: { apiKey: string; method?: "GET" | "POST"; body?: unknown },
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const response = await fetch(path, {
    method: input.method ?? "GET",
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${input.apiKey.trim()}`,
      ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // Keep plain text when response is not JSON.
  }
  const headers: Record<string, string> = {};
  for (const key of ["x-ratelimit-limit", "x-ratelimit-remaining", "retry-after", "content-type"]) {
    const val = response.headers.get(key);
    if (val) headers[key] = val;
  }
  return { status: response.status, headers, body: parsed };
}
