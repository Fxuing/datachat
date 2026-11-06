import type { Column } from "@datachat/shared";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
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
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Non-JSON error bodies keep the generic message.
  }
  return new ApiError(code, message, response.status);
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

export function abortRun(runId: string): Promise<void> {
  return apiRequest(`/api/runs/${runId}/abort`, { method: "POST" });
}

export function listDatasources(): Promise<{ datasources: DatasourceSummary[] }> {
  return apiRequest("/api/datasources");
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
