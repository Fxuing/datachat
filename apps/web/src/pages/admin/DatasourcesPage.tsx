import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { DatasourceInput } from "@datachat/shared";
import { ArrowLeft, CheckCircle2, Plus, RefreshCw } from "lucide-react";
import { AppShell } from "../../components/AppShell";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { DatasourceEditor } from "../../components/admin/DatasourceEditor";
import { DatasourceGrantsDialog } from "../../components/admin/DatasourceGrantsDialog";
import { DatasourceSchemaDrawer } from "../../components/admin/DatasourceSchemaDrawer";
import { Button } from "../../components/ui/button";
import { PageSpinner } from "../../components/ui/spinner";
import {
  ApiError,
  createDatasource,
  deleteDatasource,
  fetchMe,
  listDatasources,
  refreshDatasourceSchema,
  testDatasource,
  updateDatasource,
  type DatasourceSummary,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { formatClock } from "../../lib/utils";

interface Banner {
  tone: "success" | "error";
  text: string;
}

type EditorState = { mode: "new" } | { mode: "edit"; datasource: DatasourceSummary };

type SaveResult = { id: string; warnings: string[]; readOnly: boolean } | { ok: boolean };

function statusLabel(status: string): string {
  if (status === "ok") return "正常";
  if (status === "error") return "异常";
  return "未检测";
}

function statusClass(status: string): string {
  if (status === "ok") return "text-emerald-600";
  if (status === "error") return "text-red-600";
  return "text-neutral-400";
}

function statusDotClass(status: string): string {
  if (status === "ok") return "bg-emerald-500";
  if (status === "error") return "bg-red-500";
  return "bg-neutral-300";
}

function statusHint(status: string): string {
  if (status === "ok") return "最近一次连接测试成功。";
  if (status === "error") return "最近一次连接测试失败，请检查网络、账号或 SSL 配置。";
  return "尚未进行连接测试。";
}

function typeLabel(type: DatasourceSummary["type"]): string {
  return type === "mysql" ? "MySQL" : "PostgreSQL";
}

export default function DatasourcesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [schemaTarget, setSchemaTarget] = useState<DatasourceSummary | null>(null);
  const [grantsTarget, setGrantsTarget] = useState<DatasourceSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DatasourceSummary | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const datasourcesQuery = useQuery({
    queryKey: queryKeys.datasources,
    queryFn: listDatasources,
  });

  const invalidateDatasources = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.datasources });

  const saveMutation = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string | null;
      input: DatasourceInput;
    }): Promise<SaveResult> => {
      if (!id) return createDatasource(input);
      const patch: Partial<DatasourceInput> = { ...input };
      // The server ignores `type` on PATCH and the editor disables it when editing.
      delete patch.type;
      return updateDatasource(id, patch);
    },
    onSuccess: (_result, variables) => {
      setEditor(null);
      setBanner({
        tone: "success",
        text: variables.id ? "数据源已更新。" : "数据源已创建。",
      });
      invalidateDatasources();
    },
  });

  const testMutation = useMutation({
    mutationFn: (datasource: DatasourceSummary) => testDatasource(datasource.id),
    onSuccess: (result, datasource) => {
      setBanner({
        tone: result.ok ? "success" : "error",
        text: result.ok
          ? [
              `${datasource.name} 连接正常`,
              result.serverVersion ? `版本 ${result.serverVersion}` : null,
              result.readOnly ? "只读" : "非只读",
            ]
              .filter(Boolean)
              .join(" · ")
          : `${datasource.name} 连接失败：${result.error ?? "请检查连接配置。"}`,
      });
      invalidateDatasources();
    },
    onError: (error, datasource) => {
      setBanner({
        tone: "error",
        text: describeApiError(error, `${datasource.name} 连接测试失败，请稍后重试。`),
      });
    },
  });

  const refreshSchemaMutation = useMutation({
    mutationFn: (datasource: DatasourceSummary) => refreshDatasourceSchema(datasource.id),
    onSuccess: (result, datasource) => {
      setBanner({
        tone: "success",
        text: `${datasource.name} 的表结构已刷新，共 ${result.tableCount} 张表。`,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasourceSchemaAll(datasource.id) });
      invalidateDatasources();
    },
    onError: (error) => {
      setBanner({
        tone: "error",
        text: describeApiError(error, "刷新表结构失败，请稍后重试。"),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (datasource: DatasourceSummary) => deleteDatasource(datasource.id),
    onSuccess: () => {
      setDeleteTarget(null);
      setBanner({ tone: "success", text: "数据源已删除。" });
      invalidateDatasources();
    },
  });

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const datasources = datasourcesQuery.data?.datasources ?? [];
  const deleteError =
    deleteMutation.error instanceof ApiError && deleteMutation.error.status === 409
      ? "该数据源已有会话，暂不能删除"
      : deleteMutation.isError
        ? describeApiError(deleteMutation.error, "删除失败，请稍后重试。")
        : null;

  const openEditor = (next: EditorState) => {
    saveMutation.reset();
    setEditor(next);
  };

  const closeEditor = () => {
    setEditor(null);
    saveMutation.reset();
  };

  const openDelete = (datasource: DatasourceSummary) => {
    deleteMutation.reset();
    setDeleteTarget(datasource);
  };

  const closeDelete = () => {
    setDeleteTarget(null);
    deleteMutation.reset();
  };

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
        <div className="mx-auto w-full max-w-6xl px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-neutral-900">数据源</h1>
              <p className="mt-1 text-sm text-neutral-500">
                管理只读数据库连接；密码仅提交给服务端，不会回显。
              </p>
            </div>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => openEditor({ mode: "new" })}
            >
              <Plus className="h-3.5 w-3.5" />
              新建数据源
            </Button>
          </div>

          {banner ? (
            <p
              role={banner.tone === "error" ? "alert" : "status"}
              className={
                banner.tone === "error"
                  ? "mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600"
                  : "mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700"
              }
            >
              {banner.text}
            </p>
          ) : null}

          <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            {datasourcesQuery.isPending ? (
              <div className="px-4 py-10 text-center text-sm text-neutral-400">加载中…</div>
            ) : datasourcesQuery.isError ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-neutral-500">
                <p>{describeApiError(datasourcesQuery.error, "数据源列表加载失败，请稍后重试。")}</p>
                <Button variant="outline" size="sm" onClick={() => void datasourcesQuery.refetch()}>
                  重试
                </Button>
              </div>
            ) : datasources.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-neutral-400">
                还没有数据源，点击右上角新建。
              </div>
            ) : (
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead className="bg-neutral-50 text-xs text-neutral-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">名称</th>
                    <th className="px-4 py-2 font-medium">类型</th>
                    <th className="px-4 py-2 font-medium">地址</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">只读</th>
                    <th className="px-4 py-2 font-medium">最近检测</th>
                    <th className="px-4 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {datasources.map((datasource) => {
                    const testing =
                      testMutation.isPending && testMutation.variables?.id === datasource.id;
                    const refreshing =
                      refreshSchemaMutation.isPending &&
                      refreshSchemaMutation.variables?.id === datasource.id;
                    return (
                      <tr key={datasource.id} className="border-t border-neutral-100">
                        <td className="max-w-[14rem] px-4 py-2.5">
                          <p className="truncate font-medium text-neutral-900">{datasource.name}</p>
                          <p className="truncate text-xs text-neutral-400">
                            {datasource.username}
                          </p>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={
                              datasource.type === "mysql"
                                ? "rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700"
                                : "rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700"
                            }
                          >
                            {typeLabel(datasource.type)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-neutral-600">
                          {datasource.host}:{datasource.port}/{datasource.database}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs ${statusClass(datasource.status)}`}
                            title={statusHint(datasource.status)}
                          >
                            <span
                              aria-hidden="true"
                              className={`h-1.5 w-1.5 rounded-full ${statusDotClass(datasource.status)}`}
                            />
                            {statusLabel(datasource.status)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          {datasource.readOnlyVerified ? (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-emerald-600"
                              title="最近一次检测确认该账号只有只读权限。"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              只读已验证
                            </span>
                          ) : (
                            <span className="text-xs text-neutral-400" title="尚未验证只读权限。">
                              未验证
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-neutral-500">
                          {formatClock(datasource.lastCheckedAt) || "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={testing}
                              onClick={() => testMutation.mutate(datasource)}
                            >
                              {testing ? "测试中…" : "测试连接"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1"
                              disabled={refreshing}
                              onClick={() => refreshSchemaMutation.mutate(datasource)}
                            >
                              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                              {refreshing ? "刷新中…" : "刷新 schema"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSchemaTarget(datasource)}
                            >
                              查看结构
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setGrantsTarget(datasource)}
                            >
                              授权
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditor({ mode: "edit", datasource })}
                            >
                              编辑
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              onClick={() => openDelete(datasource)}
                            >
                              删除
                            </Button>
                          </div>
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

      {editor ? (
        <DatasourceEditor
          key={editor.mode === "new" ? "new" : editor.datasource.id}
          datasource={editor.mode === "edit" ? editor.datasource : null}
          saving={saveMutation.isPending}
          error={
            saveMutation.error
              ? describeApiError(saveMutation.error, "保存失败，请稍后重试。")
              : null
          }
          onSave={(input) =>
            saveMutation.mutate({
              id: editor.mode === "edit" ? editor.datasource.id : null,
              input,
            })
          }
          onClose={closeEditor}
        />
      ) : null}

      {schemaTarget ? (
        <DatasourceSchemaDrawer
          datasource={schemaTarget}
          onClose={() => setSchemaTarget(null)}
        />
      ) : null}

      {grantsTarget ? (
        <DatasourceGrantsDialog
          datasource={grantsTarget}
          onClose={() => setGrantsTarget(null)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="删除数据源"
          description={
            <>
              确定删除「{deleteTarget.name}」？删除后关联的 schema 缓存也会一并清除。
            </>
          }
          confirmLabel="确认删除"
          variant="danger"
          pending={deleteMutation.isPending}
          error={deleteError}
          onConfirm={() => deleteMutation.mutate(deleteTarget)}
          onCancel={closeDelete}
        />
      ) : null}
    </AppShell>
  );
}
