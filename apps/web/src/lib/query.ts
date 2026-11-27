import { QueryClient } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
    mutations: {
      retry: false,
    },
  },
});

export const queryKeys = {
  me: ["me"] as const,
  conversations: ["conversations"] as const,
  conversationList: (q: string) => ["conversations", "search", q] as const,
  conversation: (id: string) => ["conversation", id] as const,
  conversationSkills: (id: string) => ["conversation-skills", id] as const,
  datasourceSkills: (id: string) => ["datasource-skills", id] as const,
  globalSkills: ["global-skills"] as const,
  report: (id: string) => ["report", id] as const,
  reportsAll: ["reports"] as const,
  reports: (filters: Record<string, unknown>) => ["reports", filters] as const,
  sharesAll: ["shares"] as const,
  shares: (params: Record<string, unknown>) => ["shares", params] as const,
  artifact: (id: string) => ["artifact", id] as const,
  artifactRows: (id: string) => ["artifactRows", id] as const,
  datasources: ["datasources"] as const,
  datasourceDrivers: ["datasource-drivers"] as const,
  adminDatasourcePlugins: ["admin-datasource-plugins"] as const,
  datasourceSchema: (id: string, search: string) => ["datasourceSchema", id, search] as const,
  datasourceSchemaAll: (id: string) => ["datasourceSchema", id] as const,
  datasourceCatalog: (id: string) => ["datasourceCatalog", id] as const,
  datasourceGrants: (id: string) => ["datasourceGrants", id] as const,
  adminUsers: ["adminUsers"] as const,
  departments: ["departments"] as const,
  departmentMembers: (id: string) => ["department-members", id] as const,
  departmentGrants: (id: string) => ["department-grants", id] as const,
  dataScope: (id: string) => ["data-scope", id] as const,
  semanticLayer: (id: string) => ["semantic-layer", id] as const,
  semanticFeedback: (id: string, rating: string, status: string) =>
    ["semantic-feedback", id, rating, status] as const,
  semanticFeedbackAll: (id: string) => ["semantic-feedback", id] as const,
  scopeColumns: (id: string) => ["scope-columns", id] as const,
  scopeDiagnostics: (id: string, userId: string) => ["scope-diagnostics", id, userId] as const,
  scopeDenials: (id: string) => ["scope-denials", id] as const,
  roles: ["roles"] as const,
  role: (id: string) => ["role", id] as const,
  audit: (filters: Record<string, unknown>) => ["audit", filters] as const,
  models: ["models"] as const,
  adminSettings: ["admin-settings"] as const,
  llmProviders: ["llm-providers"] as const,
  opsMetrics: (days: number) => ["ops-metrics", days] as const,
  opsRetention: ["ops-retention"] as const,
  opsBackups: ["ops-backups"] as const,
  memories: (filters: Record<string, unknown>) => ["memories", filters] as const,
  memorySettings: ["memory-settings"] as const,
  scheduledTasks: ["scheduled-tasks"] as const,
  scheduledRuns: (id: string) => ["scheduled-runs", id] as const,
  notifications: ["notifications"] as const,
  runSuggestions: (runId: string) => ["run-suggestions", runId] as const,
  fileDatasets: ["file-datasets"] as const,
  dashboards: ["dashboards"] as const,
  dashboard: (id: string) => ["dashboard", id] as const,
  skills: ["skills"] as const,
  skill: (id: string) => ["skill", id] as const,
  mcpServers: ["mcpServers"] as const,
  mcpServer: (id: string) => ["mcpServer", id] as const,
  openApps: ["openApps"] as const,
  openAppKeys: (appId: string) => ["openAppKeys", appId] as const,
  openAudit: (filters: Record<string, unknown>) => ["openAudit", filters] as const,
  openWebhooks: (appId: string) => ["openWebhooks", appId] as const,
};

/**
 * Single place where a 401 becomes an app-level reaction: drop every cached query
 * (they belong to the expired session) and send the user to the login page.
 */
export function installUnauthorizedHandler(navigate: (path: string) => void): () => void {
  setUnauthorizedHandler(() => {
    queryClient.clear();
    if (typeof window !== "undefined" && window.location.pathname === "/login") return;
    navigate("/login");
  });
  return () => setUnauthorizedHandler(undefined);
}
