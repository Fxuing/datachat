import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus } from "lucide-react";
import { AppShell } from "../../components/AppShell";
import { McpEditor } from "../../components/admin/McpEditor";
import { Button } from "../../components/ui/button";
import { PageSpinner } from "../../components/ui/spinner";
import {
  ApiError,
  createMcpServer,
  deleteMcpServer,
  fetchMe,
  getMcpServer,
  listDatasources,
  listMcpServers,
  testMcpServer,
  updateMcpServer,
  type McpServerInput,
  type McpTestResult,
} from "../../lib/api";
import { queryKeys } from "../../lib/query";

interface ValidationDetails {
  fieldErrors?: Record<string, string[]>;
  formErrors?: string[];
}

/** Surface zod field errors from the API envelope alongside the generic message. */
function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (typeof error.details === "string") return error.details;
  const details = error.details as ValidationDetails | undefined;
  const lines: string[] = [];
  if (details?.fieldErrors) {
    for (const messages of Object.values(details.fieldErrors)) {
      if (Array.isArray(messages)) lines.push(...messages);
    }
  }
  if (Array.isArray(details?.formErrors)) lines.push(...details.formErrors);
  return lines.length ? `${error.message}：${lines.join("；")}` : error.message;
}

function describeTestOutcome(result: McpTestResult | undefined): string {
  if (!result) return "—";
  return result.ok ? `可用工具 ${result.tools.length} 个` : "失败";
}

interface TestState {
  status: "testing" | "success" | "error";
  result: McpTestResult | null;
  error: string | null;
}

const TESTING: TestState = { status: "testing", result: null, error: null };

export default function McpPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<"new" | string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});

  const editingId = draft !== null && draft !== "new" ? draft : null;

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const serversQuery = useQuery({ queryKey: queryKeys.mcpServers, queryFn: listMcpServers });
  const datasourcesQuery = useQuery({
    queryKey: queryKeys.datasources,
    queryFn: listDatasources,
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.mcpServer(editingId ?? "new"),
    queryFn: () => getMcpServer(editingId as string),
    enabled: editingId !== null,
  });

  const saveMutation = useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: McpServerInput }) =>
      id ? updateMcpServer(id, input) : createMcpServer(input),
    onSuccess: (_result, variables) => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
      if (variables.id) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.mcpServer(variables.id) });
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMcpServer(id),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => testMcpServer(id),
    onMutate: (id) => {
      setTestStates((current) => ({ ...current, [id]: TESTING }));
    },
    onSuccess: (result, id) => {
      setTestStates((current) => ({
        ...current,
        [id]: { status: "success", result, error: null },
      }));
    },
    onError: (error, id) => {
      setTestStates((current) => ({
        ...current,
        [id]: {
          status: "error",
          result: null,
          error: describeError(error, "测试请求失败，请稍后重试。"),
        },
      }));
    },
  });

  const resetMutations = () => {
    saveMutation.reset();
    deleteMutation.reset();
    testMutation.reset();
  };

  const openCreate = () => {
    resetMutations();
    setDraft("new");
  };

  const openEdit = (id: string) => {
    resetMutations();
    setDraft(id);
  };

  const closeEditor = () => {
    setDraft(null);
    resetMutations();
  };

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const servers = serversQuery.data?.servers ?? [];
  const datasources = datasourcesQuery.data?.datasources ?? [];
  const datasourceName = (id: string | null) =>
    id ? (datasources.find((datasource) => datasource.id === id)?.name ?? "未知数据源") : "—";

  const listForbidden =
    serversQuery.isError && serversQuery.error instanceof ApiError && serversQuery.error.status === 403;

  const sidebar = (
    <div className="p-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => navigate("/chat")}
      >
        <ArrowLeft className="h-4 w-4" />
        返回对话
      </Button>
    </div>
  );

  return (
    <AppShell user={user} sidebar={sidebar}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink">MCP 服务器</h1>
              <p className="mt-1 text-sm text-muted">
                为 Agent 接入外部 MCP 工具；修改后从下一个新对话开始生效。
              </p>
            </div>
            <Button size="sm" className="gap-1.5" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              新建 MCP 服务器
            </Button>
          </div>

          <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            {serversQuery.isPending ? (
              <div className="px-4 py-10 text-center text-sm text-muted">加载中…</div>
            ) : listForbidden ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted">
                <p>没有管理员权限，无法查看 MCP 服务器。</p>
                <Button variant="outline" size="sm" onClick={() => navigate("/chat")}>
                  返回对话
                </Button>
              </div>
            ) : serversQuery.isError ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted">
                <p>{describeError(serversQuery.error, "MCP 服务器列表加载失败，请稍后重试。")}</p>
                <Button variant="outline" size="sm" onClick={() => void serversQuery.refetch()}>
                  重试
                </Button>
              </div>
            ) : servers.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted">
                还没有 MCP 服务器，点击右上角新建。
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="bg-subtle text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">名称</th>
                    <th className="px-4 py-2 font-medium">传输</th>
                    <th className="px-4 py-2 font-medium">范围</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">最近测试</th>
                    <th className="px-4 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map((server) => {
                    const testState = testStates[server.id];
                    return (
                      <tr key={server.id} className="border-t border-line">
                        <td className="max-w-[20rem] px-4 py-2.5">
                          <p className="truncate font-medium text-ink">{server.name}</p>
                          <p className="truncate font-mono text-[11px] text-muted">
                            {server.transport === "stdio"
                              ? [server.command, ...server.args].filter(Boolean).join(" ")
                              : server.url}
                          </p>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted">
                          {server.transport === "stdio" ? "stdio" : "HTTP"}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={
                              server.scope === "global"
                                ? "rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted"
                                : "rounded bg-brandsoft px-1.5 py-0.5 text-[11px] text-brandtext"
                            }
                          >
                            {server.scope === "global"
                              ? "全局"
                              : datasourceName(server.datasourceId)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={
                              server.enabled ? "text-xs text-success" : "text-xs text-muted"
                            }
                          >
                            {server.enabled ? "启用" : "停用"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted">
                          <span
                            className={testState?.result && !testState.result.ok ? "text-danger" : undefined}
                          >
                            {testState?.status === "testing"
                              ? "测试中…"
                              : describeTestOutcome(testState?.result ?? undefined)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(server.id)}>
                            编辑
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {draft === "new" ? (
        <McpEditor
          key="new"
          server={null}
          datasources={datasources}
          saving={saveMutation.isPending}
          deleting={false}
          testing={false}
          error={
            saveMutation.error ? describeError(saveMutation.error, "保存失败，请稍后重试。") : null
          }
          deleteError={null}
          testResult={null}
          testError={null}
          onSave={(input) => saveMutation.mutate({ id: null, input })}
          onDelete={() => undefined}
          onTest={() => undefined}
          onClose={closeEditor}
        />
      ) : null}

      {editingId ? (
        detailQuery.isPending ? (
          <div className="fixed inset-0 z-40 flex justify-end bg-black/30">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="编辑 MCP 服务器"
              className="flex h-full w-full max-w-xl items-center justify-center border-l border-line bg-surface shadow-xl"
            >
              <PageSpinner label="加载 MCP 服务器…" />
            </div>
          </div>
        ) : detailQuery.isError || !detailQuery.data ? (
          <div className="fixed inset-0 z-40 flex justify-end bg-black/30">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="编辑 MCP 服务器"
              className="flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 border-l border-line bg-surface px-6 shadow-xl"
            >
              <p className="text-sm text-muted">
                {describeError(detailQuery.error, "MCP 服务器加载失败，请稍后重试。")}
              </p>
              <Button variant="outline" size="sm" onClick={closeEditor}>
                关闭
              </Button>
            </div>
          </div>
        ) : (
          <McpEditor
            key={editingId}
            server={detailQuery.data.server}
            datasources={datasources}
            saving={saveMutation.isPending}
            deleting={deleteMutation.isPending}
            testing={testStates[editingId]?.status === "testing"}
            error={
              saveMutation.error
                ? describeError(saveMutation.error, "保存失败，请稍后重试。")
                : null
            }
            deleteError={
              deleteMutation.error
                ? describeError(deleteMutation.error, "删除失败，请稍后重试。")
                : null
            }
            testResult={
              testStates[editingId]?.status === "success"
                ? (testStates[editingId]?.result ?? null)
                : null
            }
            testError={
              testStates[editingId]?.status === "error"
                ? (testStates[editingId]?.error ?? null)
                : null
            }
            onSave={(input) => saveMutation.mutate({ id: editingId, input })}
            onDelete={() => deleteMutation.mutate(editingId)}
            onTest={() => testMutation.mutate(editingId)}
            onClose={closeEditor}
          />
        )
      ) : null}
    </AppShell>
  );
}
