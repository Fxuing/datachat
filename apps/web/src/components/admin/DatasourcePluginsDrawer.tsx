import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Plug,
  Power,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  ApiError,
  deleteDatasourcePlugin,
  listAdminDatasourcePlugins,
  toggleDatasourcePlugin,
  uploadDatasourcePlugin,
  type AdminDriverPluginItem,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { formatClock } from "../../lib/utils";
import { Button } from "../ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";
import { ConfirmDialog } from "./ConfirmDialog";

export interface DatasourcePluginsDrawerProps {
  onClose: () => void;
}

function sourceBadge(source: AdminDriverPluginItem["source"]): {
  label: string;
  className: string;
} {
  if (source === "builtin") {
    return { label: "内置", className: "bg-subtle text-inksoft" };
  }
  if (source === "env") {
    return { label: "环境变量", className: "bg-brandsoft text-brandtext" };
  }
  return { label: "离线上传", className: "bg-successsoft text-success" };
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DatasourcePluginsDrawer({ onClose }: DatasourcePluginsDrawerProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [pendingReplaceFile, setPendingReplaceFile] = useState<File | null>(null);
  const [replacePrompt, setReplacePrompt] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminDriverPluginItem | null>(null);

  const pluginsQuery = useQuery({
    queryKey: queryKeys.adminDatasourcePlugins,
    queryFn: listAdminDatasourcePlugins,
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.adminDatasourcePlugins });
    void queryClient.invalidateQueries({ queryKey: queryKeys.datasourceDrivers });
    void queryClient.invalidateQueries({ queryKey: queryKeys.datasources });
  };

  const uploadMutation = useMutation({
    mutationFn: ({ file, replace }: { file: File; replace: boolean }) =>
      uploadDatasourcePlugin(file, { replace }),
    onSuccess: (result) => {
      setPendingReplaceFile(null);
      setReplacePrompt(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setStatusMessage({
        tone: "success",
        text: result.replaced
          ? `驱动「${result.plugin.label}」已覆盖升级并热加载。`
          : `驱动「${result.plugin.label}」已上传并热加载，可在新建数据源中选择。`,
      });
      refreshAll();
    },
    onError: (err, variables) => {
      if (err instanceof ApiError && err.code === "PLUGIN_ALREADY_EXISTS") {
        setPendingReplaceFile(variables.file);
        setReplacePrompt(err.message);
        setStatusMessage(null);
        return;
      }
      setPendingReplaceFile(null);
      setReplacePrompt(null);
      setStatusMessage({
        tone: "error",
        text: describeApiError(err, "上传插件失败，请检查文件格式与协议校验。"),
      });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ driverId, enabled }: { driverId: string; enabled: boolean }) =>
      toggleDatasourcePlugin(driverId, enabled),
    onSuccess: (result) => {
      setStatusMessage({
        tone: "success",
        text: result.plugin.enabled
          ? `驱动「${result.plugin.label}」已启用并热加载。`
          : `驱动「${result.plugin.label}」已停用，相关连接池已关闭。`,
      });
      refreshAll();
    },
    onError: (err) => {
      setStatusMessage({
        tone: "error",
        text: describeApiError(err, "切换插件状态失败。"),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (plugin: AdminDriverPluginItem) => deleteDatasourcePlugin(plugin.id),
    onSuccess: (_res, plugin) => {
      setDeleteTarget(null);
      setStatusMessage({
        tone: "success",
        text: `驱动「${plugin.label}」已卸载。`,
      });
      refreshAll();
    },
  });

  const handleFileChange = (file: File | undefined) => {
    if (!file || uploadMutation.isPending) return;
    setStatusMessage(null);
    setPendingReplaceFile(null);
    setReplacePrompt(null);
    uploadMutation.mutate({ file, replace: false });
  };

  const allowUpload = pluginsQuery.data?.allowUpload !== false;
  const drivers = pluginsQuery.data?.drivers ?? [];

  return (
    <>
      <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
        <SheetContent hideClose className="max-w-2xl">
          <SheetHeader className="h-14 flex-row items-center justify-between gap-3 px-4 py-0">
            <div className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-brand" />
              <SheetTitle className="text-sm">数据源驱动插件</SheetTitle>
            </div>
            <SheetClose asChild>
              <Button variant="ghost" size="icon" aria-label="关闭">
                <X className="h-4 w-4" />
              </Button>
            </SheetClose>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {statusMessage ? (
              <p
                role={statusMessage.tone === "error" ? "alert" : "status"}
                className={
                  statusMessage.tone === "error"
                    ? "rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
                    : "rounded-md border border-success/20 bg-successsoft px-3 py-2 text-xs text-success"
                }
              >
                {statusMessage.text}
              </p>
            ) : null}

            {replacePrompt && pendingReplaceFile ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/30 bg-warningsoft px-3 py-2.5 text-xs text-warning"
              >
                <span>{replacePrompt}</span>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadMutation.isPending}
                    onClick={() => {
                      setPendingReplaceFile(null);
                      setReplacePrompt(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={uploadMutation.isPending}
                    onClick={() =>
                      uploadMutation.mutate({ file: pendingReplaceFile, replace: true })
                    }
                  >
                    {uploadMutation.isPending ? "升级中…" : "确认覆盖升级"}
                  </Button>
                </div>
              </div>
            ) : null}

            {allowUpload ? (
              <div className="rounded-lg border border-dashed border-linestrong bg-subtle/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-ink">离线上传驱动插件包</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">
                      支持单文件 <code className="rounded bg-subtle px-1">.mjs</code> 或自包含依赖的{" "}
                      <code className="rounded bg-subtle px-1">.zip</code> /{" "}
                      <code className="rounded bg-subtle px-1">.tgz</code>（≤ 20 MB）。上传通过协议校验后会立即热加载，无需重启服务。
                    </p>
                    <p className="mt-1.5 flex items-center gap-1 text-[11px] text-warning">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>插件代码将在服务端运行，请仅上传可信来源的驱动包。</span>
                    </p>
                  </div>
                  <div className="shrink-0">
                    <input
                      ref={fileInputRef}
                      id="datasource-plugin-upload-input"
                      type="file"
                      accept=".mjs,.zip,.tgz,.tar.gz"
                      className="sr-only"
                      disabled={uploadMutation.isPending}
                      onChange={(event) => handleFileChange(event.target.files?.[0])}
                    />
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1.5"
                      disabled={uploadMutation.isPending}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {uploadMutation.isPending ? "上传校验中…" : "选择插件包"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="rounded-md border border-line bg-subtle/50 px-3 py-2 text-xs text-muted">
                服务端已配置 <code className="font-mono">ALLOW_PLUGIN_UPLOAD=false</code>，界面上传已关闭；请通过环境变量{" "}
                <code className="font-mono">DATASOURCE_PLUGINS</code> 管理驱动插件。
              </p>
            )}

            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-muted">
                  已注册驱动（{drivers.length}）
                </h3>
              </div>

              {pluginsQuery.isPending ? (
                <p className="py-8 text-center text-xs text-muted">加载中…</p>
              ) : pluginsQuery.isError ? (
                <div className="flex flex-col items-center gap-2 py-8 text-xs text-muted">
                  <p>{describeApiError(pluginsQuery.error, "加载驱动列表失败。")}</p>
                  <Button variant="outline" size="sm" onClick={() => void pluginsQuery.refetch()}>
                    重试
                  </Button>
                </div>
              ) : (
                <ul className="space-y-2.5">
                  {drivers.map((driver) => {
                    const badge = sourceBadge(driver.source);
                    const toggling =
                      toggleMutation.isPending && toggleMutation.variables?.driverId === driver.id;
                    return (
                      <li
                        key={driver.id}
                        className="rounded-lg border border-line bg-surface p-3.5"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-ink">{driver.label}</span>
                              <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-muted">
                                {driver.id}
                              </code>
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
                              >
                                {badge.label}
                              </span>
                              {driver.version ? (
                                <span className="text-[11px] text-muted">v{driver.version}</span>
                              ) : null}
                              {driver.loaded ? (
                                <span className="inline-flex items-center gap-1 text-[11px] text-success">
                                  <CheckCircle2 className="h-3 w-3" />
                                  已加载
                                </span>
                              ) : (
                                <span className="rounded bg-warningsoft px-1.5 py-0.5 text-[10px] text-warning">
                                  {driver.enabled ? "加载失败" : "已停用"}
                                </span>
                              )}
                            </div>

                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                              <span>关联数据源：{driver.datasourceCount}</span>
                              {driver.defaultPort ? <span>默认端口：{driver.defaultPort}</span> : null}
                              {driver.fileName ? <span>包文件：{driver.fileName}</span> : null}
                              {driver.sizeBytes != null ? (
                                <span>{formatBytes(driver.sizeBytes)}</span>
                              ) : null}
                              {driver.sha256 ? (
                                <span className="font-mono" title={driver.sha256}>
                                  SHA256: {driver.sha256.slice(0, 12)}
                                </span>
                              ) : null}
                              {driver.updatedAt ? (
                                <span>更新于 {formatClock(driver.updatedAt)}</span>
                              ) : null}
                            </div>

                            {driver.capabilities ? (
                              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted">
                                <span className="rounded border border-line px-1.5 py-0.5">
                                  EXPLAIN：{driver.capabilities.explain ? "支持" : "不支持"}
                                </span>
                                <span className="rounded border border-line px-1.5 py-0.5">
                                  只读检测：{driver.capabilities.readOnlyProbe ? "支持" : "未支持"}
                                </span>
                                <span className="rounded border border-line px-1.5 py-0.5">
                                  行级权限：{driver.capabilities.rowScope ? "支持" : "不支持"}
                                </span>
                                {driver.optionsSchema.length > 0 ? (
                                  <span className="rounded border border-line px-1.5 py-0.5">
                                    扩展参数：{driver.optionsSchema.length} 项
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>

                          {driver.source === "upload" ? (
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1"
                                disabled={toggling}
                                onClick={() =>
                                  toggleMutation.mutate({
                                    driverId: driver.id,
                                    enabled: !driver.enabled,
                                  })
                                }
                              >
                                <Power className="h-3 w-3" />
                                {toggling
                                  ? "处理中…"
                                  : driver.enabled
                                    ? "停用"
                                    : "启用"}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="gap-1 text-danger hover:bg-dangersoft hover:text-danger"
                                onClick={() => {
                                  deleteMutation.reset();
                                  setDeleteTarget(driver);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                卸载
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="flex shrink-0 justify-end border-t border-line p-3">
            <Button variant="outline" size="sm" onClick={onClose}>
              完成
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {deleteTarget ? (
        <ConfirmDialog
          title="卸载驱动插件"
          description={
            <>
              确定卸载「{deleteTarget.label}」（<code>{deleteTarget.id}</code>）？
              {deleteTarget.datasourceCount > 0
                ? `当前有 ${deleteTarget.datasourceCount} 个数据源正在使用该驱动，卸载后它们将标记为「驱动未安装」并暂停查询，直到重新上传该驱动。`
                : "卸载后将立即清理插件文件与注册信息。"}
            </>
          }
          confirmLabel="确认卸载"
          variant="danger"
          pending={deleteMutation.isPending}
          error={
            deleteMutation.isError
              ? describeApiError(deleteMutation.error, "卸载失败，请稍后重试。")
              : null
          }
          onConfirm={() => deleteMutation.mutate(deleteTarget)}
          onCancel={() => {
            setDeleteTarget(null);
            deleteMutation.reset();
          }}
        />
      ) : null}
    </>
  );
}
