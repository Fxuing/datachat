import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  FileJson,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Settings2,
  Trash2,
  Webhook,
} from "lucide-react";
import {
  OPEN_APP_SCOPES,
  OPEN_APP_SCOPE_LABELS,
  type OpenAppScope,
  type OpenAskResult,
  type OpenReportResult,
} from "@datachat/shared";
import { AdminShell } from "../../components/admin/AdminShell";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { PageSpinner } from "../../components/ui/spinner";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import {
  ApiError,
  createOpenApiKey,
  createOpenApp,
  deleteOpenApp,
  fetchMe,
  listAdminUsers,
  listDatasources,
  listOpenApiAudit,
  listOpenApiKeys,
  listOpenApps,
  listOpenWebhookDeliveries,
  replayOpenWebhook,
  revokeOpenApiKey,
  runOpenPlayground,
  updateOpenApp,
  type OpenAppInput,
  type OpenAppSummary,
} from "../../lib/api";
import { queryKeys } from "../../lib/query";

type TabId = "apps" | "playground" | "audit" | "webhooks";

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

interface AppFormState {
  name: string;
  description: string;
  status: "active" | "disabled";
  serviceUserId: string;
  restrictDatasources: boolean;
  allowedDatasourceIds: string[];
  scopes: OpenAppScope[];
  allowEndUserOverride: boolean;
  exposeSql: boolean;
  rateLimitRpm: string;
  maxRowsOverride: string;
  timeoutMsOverride: string;
  systemPromptExtra: string;
  webhookUrl: string;
  webhookSecret: string;
}

function defaultAppForm(defaultUserId: string): AppFormState {
  return {
    name: "",
    description: "",
    status: "active",
    serviceUserId: defaultUserId,
    restrictDatasources: false,
    allowedDatasourceIds: [],
    scopes: ["ask", "report", "semantic", "mcp", "feedback"],
    allowEndUserOverride: false,
    exposeSql: true,
    rateLimitRpm: "60",
    maxRowsOverride: "",
    timeoutMsOverride: "",
    systemPromptExtra: "",
    webhookUrl: "",
    webhookSecret: "",
  };
}

function appToForm(app: OpenAppSummary): AppFormState {
  return {
    name: app.name,
    description: app.description ?? "",
    status: app.status,
    serviceUserId: app.serviceUserId,
    restrictDatasources: app.allowedDatasourceIds !== null,
    allowedDatasourceIds: app.allowedDatasourceIds ?? [],
    scopes: app.scopes,
    allowEndUserOverride: app.allowEndUserOverride,
    exposeSql: app.exposeSql,
    rateLimitRpm: String(app.rateLimitRpm),
    maxRowsOverride: app.maxRowsOverride !== null ? String(app.maxRowsOverride) : "",
    timeoutMsOverride: app.timeoutMsOverride !== null ? String(app.timeoutMsOverride) : "",
    systemPromptExtra: app.systemPromptExtra ?? "",
    webhookUrl: app.webhookUrl ?? "",
    webhookSecret: "",
  };
}

export default function OpenPlatformPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabId>("apps");
  const [editingApp, setEditingApp] = useState<"new" | OpenAppSummary | null>(null);
  const [form, setForm] = useState<AppFormState>(() => defaultAppForm(""));
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingApp, setDeletingApp] = useState<OpenAppSummary | null>(null);

  const [keysApp, setKeysApp] = useState<OpenAppSummary | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiresDays, setNewKeyExpiresDays] = useState("");
  const [issuedRawKey, setIssuedRawKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Audit & webhook filters
  const [auditAppId, setAuditAppId] = useState("");
  const [auditStatus, setAuditStatus] = useState<"" | "ok" | "error" | "rejected" | "rate_limited">("");
  const [auditDays, setAuditDays] = useState(7);
  const [webhookAppId, setWebhookAppId] = useState("");

  // Playground state
  const [pgAppId, setPgAppId] = useState("");
  const [pgAction, setPgAction] = useState<"ask" | "report">("ask");
  const [pgDatasourceId, setPgDatasourceId] = useState("");
  const [pgPrompt, setPgPrompt] = useState("");
  const [pgReportTitle, setPgReportTitle] = useState("");
  const [pgReportSections, setPgReportSections] = useState("");
  const [pgExtUserId, setPgExtUserId] = useState("");
  const [pgUsername, setPgUsername] = useState("");
  const [pgDeptCodes, setPgDeptCodes] = useState("");
  const [pgExtOrgCodes, setPgExtOrgCodes] = useState("");
  const [pgShowRaw, setPgShowRaw] = useState(false);
  const [pgOutput, setPgOutput] = useState<
    { action: "ask"; result: OpenAskResult } | { action: "report"; result: OpenReportResult } | null
  >(null);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const appsQuery = useQuery({ queryKey: queryKeys.openApps, queryFn: listOpenApps });
  const usersQuery = useQuery({ queryKey: queryKeys.adminUsers, queryFn: listAdminUsers });
  const datasourcesQuery = useQuery({ queryKey: queryKeys.datasources, queryFn: listDatasources });

  const keysQuery = useQuery({
    queryKey: queryKeys.openAppKeys(keysApp?.id ?? ""),
    queryFn: () => listOpenApiKeys(keysApp!.id),
    enabled: keysApp !== null,
  });

  const auditFilters = {
    ...(auditAppId ? { appId: auditAppId } : {}),
    ...(auditStatus ? { status: auditStatus } : {}),
    days: auditDays,
    limit: 50,
  };
  const auditQuery = useQuery({
    queryKey: queryKeys.openAudit(auditFilters),
    queryFn: () => listOpenApiAudit(auditFilters),
    enabled: activeTab === "audit",
  });

  const webhooksQuery = useQuery({
    queryKey: queryKeys.openWebhooks(webhookAppId),
    queryFn: () => listOpenWebhookDeliveries({ ...(webhookAppId ? { appId: webhookAppId } : {}), limit: 50 }),
    enabled: activeTab === "webhooks",
  });

  const saveAppMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string | null; payload: OpenAppInput }) =>
      id ? updateOpenApp(id, payload) : createOpenApp(payload),
    onSuccess: () => {
      setEditingApp(null);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.openApps });
    },
    onError: (err) => {
      setFormError(errorText(err, "保存应用失败"));
    },
  });

  const deleteAppMutation = useMutation({
    mutationFn: (id: string) => deleteOpenApp(id),
    onSuccess: () => {
      setDeletingApp(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.openApps });
    },
  });

  const issueKeyMutation = useMutation({
    mutationFn: ({
      appId,
      name,
      expiresInDays,
    }: {
      appId: string;
      name: string;
      expiresInDays: number | null;
    }) => createOpenApiKey(appId, { name, expiresInDays }),
    onSuccess: (data, vars) => {
      setIssuedRawKey(data.rawKey);
      setCopiedKey(false);
      setNewKeyName("");
      setNewKeyExpiresDays("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.openAppKeys(vars.appId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.openApps });
    },
  });

  const revokeKeyMutation = useMutation({
    mutationFn: ({ appId, keyId }: { appId: string; keyId: string }) => revokeOpenApiKey(appId, keyId),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.openAppKeys(vars.appId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.openApps });
    },
  });

  const replayWebhookMutation = useMutation({
    mutationFn: (deliveryId: string) => replayOpenWebhook(deliveryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.openWebhooks(webhookAppId) });
    },
  });

  const playgroundMutation = useMutation({
    mutationFn: () => {
      const targetAppId = pgAppId || activeApps[0]?.id || "";
      const targetDsId = pgDatasourceId || datasources[0]?.id || "";
      const deptCodes = pgDeptCodes
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const extOrgCodes = pgExtOrgCodes
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const sections = pgReportSections
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      const endUser =
        pgExtUserId.trim() || pgUsername.trim() || deptCodes.length > 0 || extOrgCodes.length > 0
          ? {
              ...(pgExtUserId.trim() ? { externalUserId: pgExtUserId.trim() } : {}),
              ...(pgUsername.trim() ? { username: pgUsername.trim() } : {}),
              ...(deptCodes.length > 0 ? { departmentCodes: deptCodes } : {}),
              ...(extOrgCodes.length > 0 ? { externalOrgCodes: extOrgCodes } : {}),
            }
          : undefined;

      return runOpenPlayground(targetAppId, {
        action: pgAction,
        datasourceId: targetDsId,
        prompt: pgPrompt.trim(),
        ...(pgAction === "report" && pgReportTitle.trim() ? { title: pgReportTitle.trim() } : {}),
        ...(pgAction === "report" && sections.length > 0 ? { sections } : {}),
        ...(endUser ? { endUser } : {}),
      });
    },
    onSuccess: (data) => {
      setPgOutput(data);
    },
  });

  if (meQuery.isPending || appsQuery.isPending) {
    return <PageSpinner label="正在加载开放平台配置…" />;
  }
  if (!meQuery.data) return null;

  const apps = appsQuery.data?.items ?? [];
  const activeApps = apps.filter((a) => a.status === "active");
  const users = (usersQuery.data?.users ?? []).filter((u) => u.status === "active");
  const datasources = datasourcesQuery.data?.datasources ?? [];

  const openCreateSheet = () => {
    setForm(defaultAppForm(users[0]?.id ?? meQuery.data.user.id));
    setFormError(null);
    setEditingApp("new");
  };

  const openEditSheet = (app: OpenAppSummary) => {
    setForm(appToForm(app));
    setFormError(null);
    setEditingApp(app);
  };

  const handleSaveApp = () => {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("请填写应用名称");
      return;
    }
    if (!form.serviceUserId) {
      setFormError("请选择绑定的服务账号");
      return;
    }
    if (form.scopes.length === 0) {
      setFormError("请至少勾选一项开放能力");
      return;
    }
    const rpm = Number(form.rateLimitRpm);
    if (!Number.isInteger(rpm) || rpm < 1 || rpm > 10_000) {
      setFormError("每分钟限流必须为 1–10000 之间的整数");
      return;
    }
    const maxRows = form.maxRowsOverride.trim() ? Number(form.maxRowsOverride) : null;
    const timeoutMs = form.timeoutMsOverride.trim() ? Number(form.timeoutMsOverride) : null;

    const payload: OpenAppInput = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      status: form.status,
      serviceUserId: form.serviceUserId,
      allowedDatasourceIds: form.restrictDatasources ? form.allowedDatasourceIds : null,
      scopes: form.scopes,
      allowEndUserOverride: form.allowEndUserOverride,
      exposeSql: form.exposeSql,
      rateLimitRpm: rpm,
      maxRowsOverride: maxRows,
      timeoutMsOverride: timeoutMs,
      systemPromptExtra: form.systemPromptExtra.trim() || null,
      webhookUrl: form.webhookUrl.trim() || null,
      ...(form.webhookSecret.trim() ? { webhookSecret: form.webhookSecret.trim() } : {}),
    };

    saveAppMutation.mutate({
      id: editingApp && editingApp !== "new" ? editingApp.id : null,
      payload,
    });
  };

  const toggleScope = (scope: OpenAppScope) => {
    setForm((cur) => ({
      ...cur,
      scopes: cur.scopes.includes(scope)
        ? cur.scopes.filter((s) => s !== scope)
        : [...cur.scopes, scope],
    }));
  };

  const toggleDatasource = (dsId: string) => {
    setForm((cur) => ({
      ...cur,
      allowedDatasourceIds: cur.allowedDatasourceIds.includes(dsId)
        ? cur.allowedDatasourceIds.filter((id) => id !== dsId)
        : [...cur.allowedDatasourceIds, dsId],
    }));
  };

  const handleCopyRawKey = async () => {
    if (!issuedRawKey) return;
    try {
      await navigator.clipboard.writeText(issuedRawKey);
      setCopiedKey(true);
    } catch {
      // Clipboard may be unavailable in non-HTTPS contexts.
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8080";
  const selectedPgAppId = pgAppId || activeApps[0]?.id || "";
  const selectedPgDsId = pgDatasourceId || datasources[0]?.id || "";

  return (
    <AdminShell user={meQuery.data.user}>
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink">开放平台</h1>
            <p className="mt-1 text-sm text-muted">
              管理外部业务应用、API Key、行级权限透传、远程 MCP Server、Webhook 回调与在线调试台。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/open-docs"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-inksoft transition-colors hover:bg-subtle hover:text-ink"
            >
              <BookOpen className="h-3.5 w-3.5" />
              在线接入文档
              <ExternalLink className="h-3 w-3" />
            </a>
            <a
              href="/api/open/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-inksoft transition-colors hover:bg-subtle hover:text-ink"
            >
              <FileJson className="h-3.5 w-3.5" />
              OpenAPI 3.1
              <ExternalLink className="h-3 w-3" />
            </a>
            {activeTab === "apps" ? (
              <Button size="sm" onClick={openCreateSheet}>
                <Plus className="mr-1.5 h-4 w-4" />
                新建应用
              </Button>
            ) : null}
          </div>
        </div>

        {/* Navigation tabs */}
        <div className="flex flex-wrap gap-1 border-b border-line pb-2" role="tablist" aria-label="开放平台视图">
          {[
            { id: "apps" as const, label: "应用与密钥", icon: KeyRound },
            { id: "playground" as const, label: "在线调试台", icon: Play },
            { id: "audit" as const, label: "调用审计与用量", icon: ScrollText },
            { id: "webhooks" as const, label: "Webhook 投递", icon: Webhook },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-brandsoft text-brandtext"
                    : "text-inksoft hover:bg-subtle hover:text-ink"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab 1: Apps & Keys */}
        {activeTab === "apps" ? (
          <div className="space-y-3">
            {apps.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line bg-surface p-10 text-center">
                <p className="text-sm font-medium text-ink">还没有接入的开放应用</p>
                <p className="mt-1 text-xs text-muted">
                  创建一个应用并签发 API Key，外部业务即可通过 REST / SSE / MCP 调用 DataChat 的精准问答与报告能力。
                </p>
                <Button size="sm" className="mt-4" onClick={openCreateSheet}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  创建第一个应用
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                {apps.map((app) => (
                  <div
                    key={app.id}
                    className="rounded-xl border border-line bg-surface p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-semibold text-ink">{app.name}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              app.status === "active"
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                : "bg-subtle text-muted"
                            }`}
                          >
                            {app.status === "active" ? "已启用" : "已停用"}
                          </span>
                          <span className="rounded bg-subtle px-2 py-0.5 text-xs text-inksoft">
                            服务账号：{app.serviceUsername}
                          </span>
                          <span className="rounded bg-subtle px-2 py-0.5 text-xs text-inksoft">
                            限流：{app.rateLimitRpm} RPM
                          </span>
                          <span className="rounded bg-subtle px-2 py-0.5 text-xs text-inksoft">
                            有效密钥：{app.activeKeyCount}
                          </span>
                        </div>
                        {app.description ? (
                          <p className="text-xs text-muted">{app.description}</p>
                        ) : null}
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {app.scopes.map((scope) => (
                            <span
                              key={scope}
                              className="rounded-md border border-line bg-subtle px-2 py-0.5 text-[11px] font-medium text-inksoft"
                            >
                              {scope}
                            </span>
                          ))}
                          {app.allowEndUserOverride ? (
                            <span className="rounded-md bg-brandsoft px-2 py-0.5 text-[11px] font-medium text-brandtext">
                              允许行级身份透传
                            </span>
                          ) : null}
                          {!app.exposeSql ? (
                            <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                              隐藏 SQL
                            </span>
                          ) : null}
                          {app.webhookUrl ? (
                            <span className="rounded-md bg-subtle px-2 py-0.5 text-[11px] text-inksoft">
                              Webhook 已配置{app.hasWebhookSecret ? "（HMAC 签名）" : ""}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setIssuedRawKey(null);
                            setKeysApp(app);
                          }}
                        >
                          <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                          密钥与接入
                        </Button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`编辑应用 ${app.name}`}
                              onClick={() => openEditSheet(app)}
                            >
                              <Settings2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>编辑应用</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`删除应用 ${app.name}`}
                              onClick={() => setDeletingApp(app)}
                            >
                              <Trash2 className="h-4 w-4 text-danger" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>删除应用</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Tab 2: Playground */}
        {activeTab === "playground" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold text-ink">请求参数</h2>
              {activeApps.length === 0 ? (
                <p className="text-xs text-muted">请先在「应用与密钥」中创建一个已启用的开放应用。</p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs">
                      <span className="font-medium text-inksoft">开放应用</span>
                      <select
                        aria-label="选择开放应用"
                        value={selectedPgAppId}
                        onChange={(e) => setPgAppId(e.target.value)}
                        className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
                      >
                        {activeApps.map((app) => (
                          <option key={app.id} value={app.id}>
                            {app.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1 text-xs">
                      <span className="font-medium text-inksoft">调用能力</span>
                      <select
                        aria-label="选择调用能力"
                        value={pgAction}
                        onChange={(e) => setPgAction(e.target.value as "ask" | "report")}
                        className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
                      >
                        <option value="ask">结构化问答（Ask API）</option>
                        <option value="report">模板报告生成（Report API）</option>
                      </select>
                    </label>
                  </div>

                  <label className="block space-y-1 text-xs">
                    <span className="font-medium text-inksoft">数据源</span>
                    <select
                      aria-label="选择数据源"
                      value={selectedPgDsId}
                      onChange={(e) => setPgDatasourceId(e.target.value)}
                      className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
                    >
                      {datasources.map((ds) => (
                        <option key={ds.id} value={ds.id}>
                          {ds.name} ({ds.type})
                        </option>
                      ))}
                    </select>
                  </label>

                  {pgAction === "report" ? (
                    <div className="space-y-2">
                      <label className="block space-y-1 text-xs">
                        <span className="font-medium text-inksoft">报告标题（可选）</span>
                        <Input
                          value={pgReportTitle}
                          onChange={(e) => setPgReportTitle(e.target.value)}
                          placeholder="例如：华东区月度经营分析报告"
                        />
                      </label>
                      <label className="block space-y-1 text-xs">
                        <span className="font-medium text-inksoft">章节大纲（每行一节，可选）</span>
                        <Textarea
                          rows={3}
                          value={pgReportSections}
                          onChange={(e) => setPgReportSections(e.target.value)}
                          placeholder={"核心指标概览\n分渠道趋势对比\n异常波动与建议"}
                        />
                      </label>
                    </div>
                  ) : null}

                  <label className="block space-y-1 text-xs">
                    <span className="font-medium text-inksoft">
                      {pgAction === "ask" ? "提问内容" : "报告分析诉求"}
                    </span>
                    <Textarea
                      rows={3}
                      value={pgPrompt}
                      onChange={(e) => setPgPrompt(e.target.value)}
                      placeholder="例如：统计近 30 天各渠道销售额与环比增速"
                    />
                  </label>

                  <div className="space-y-2 rounded-lg border border-line bg-subtle/50 p-3">
                    <p className="text-xs font-medium text-inksoft">
                      模拟终端用户与行级数据范围（需应用开启「允许行级身份透传」）
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        value={pgExtUserId}
                        onChange={(e) => setPgExtUserId(e.target.value)}
                        placeholder="externalUserId（可选）"
                      />
                      <Input
                        value={pgUsername}
                        onChange={(e) => setPgUsername(e.target.value)}
                        placeholder="映射本系统用户名 username"
                      />
                      <Input
                        value={pgDeptCodes}
                        onChange={(e) => setPgDeptCodes(e.target.value)}
                        placeholder="部门编码 departmentCodes（逗号分隔）"
                      />
                      <Input
                        value={pgExtOrgCodes}
                        onChange={(e) => setPgExtOrgCodes(e.target.value)}
                        placeholder="外部组织码 externalOrgCodes（逗号分隔）"
                      />
                    </div>
                  </div>

                  {playgroundMutation.isError ? (
                    <p role="alert" className="rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
                      {errorText(playgroundMutation.error, "调试执行失败")}
                    </p>
                  ) : null}

                  <Button
                    disabled={playgroundMutation.isPending || !pgPrompt.trim() || !selectedPgDsId}
                    onClick={() => playgroundMutation.mutate()}
                  >
                    <Play className="mr-1.5 h-4 w-4" />
                    {playgroundMutation.isPending ? "正在执行…" : "运行调试"}
                  </Button>
                </>
              )}
            </div>

            <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">返回结果与数据血缘</h2>
                {pgOutput ? (
                  <Button variant="ghost" size="sm" onClick={() => setPgShowRaw((v) => !v)}>
                    {pgShowRaw ? "结构化视图" : "查看原始 JSON"}
                  </Button>
                ) : null}
              </div>

              {!pgOutput ? (
                <p className="py-12 text-center text-xs text-muted">
                  点击左侧「运行调试」，实时预览开放接口返回的结构化答案、行级数据范围、命中的语义口径与 SQL 血缘。
                </p>
              ) : pgShowRaw ? (
                <pre className="max-h-[480px] overflow-auto rounded-lg bg-subtle p-3 text-xs text-ink">
                  {JSON.stringify(pgOutput.result, null, 2)}
                </pre>
              ) : (
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded bg-subtle px-2 py-0.5 text-inksoft">
                      状态：{pgOutput.result.status}
                    </span>
                    <span className="rounded bg-subtle px-2 py-0.5 text-inksoft">
                      数据集：{pgOutput.result.datasets.length} 个
                    </span>
                    <span className="rounded bg-subtle px-2 py-0.5 text-inksoft">
                      图表：{pgOutput.result.charts.length} 个
                    </span>
                    {pgOutput.result.lineage.scope ? (
                      <span className="rounded bg-brandsoft px-2 py-0.5 text-brandtext">
                        数据范围：{pgOutput.result.lineage.scope.departments.join("、")}
                      </span>
                    ) : null}
                  </div>

                  <div className="rounded-lg border border-line bg-subtle/40 p-3">
                    <p className="mb-1 text-xs font-medium text-inksoft">
                      {pgOutput.action === "report" ? "生成报告正文" : "净化后结构化回答"}
                    </p>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs text-ink">
                      {pgOutput.action === "report"
                        ? pgOutput.result.markdown || "（空）"
                        : pgOutput.result.answer || "（空）"}
                    </pre>
                  </div>

                  {pgOutput.result.lineage.semanticMetrics.length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-inksoft">命中的语义指标</p>
                      <div className="flex flex-wrap gap-1.5">
                        {pgOutput.result.lineage.semanticMetrics.map((m) => (
                          <span
                            key={m.name}
                            className="rounded border border-line bg-subtle px-2 py-0.5 text-xs text-ink"
                          >
                            {m.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {pgOutput.result.lineage.sqls && pgOutput.result.lineage.sqls.length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-inksoft">执行的只读 SQL</p>
                      {pgOutput.result.lineage.sqls.map((item) => (
                        <pre
                          key={item.auditId}
                          className="overflow-x-auto rounded bg-subtle p-2 text-xs text-ink"
                        >
                          {item.sql}
                        </pre>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Tab 3: Audit & Stats */}
        {activeTab === "audit" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="按应用筛选审计"
                value={auditAppId}
                onChange={(e) => setAuditAppId(e.target.value)}
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
              >
                <option value="">全部应用</option>
                {apps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="按状态筛选审计"
                value={auditStatus}
                onChange={(e) =>
                  setAuditStatus(e.target.value as "" | "ok" | "error" | "rejected" | "rate_limited")
                }
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
              >
                <option value="">全部状态</option>
                <option value="ok">成功</option>
                <option value="rejected">权限拒绝</option>
                <option value="rate_limited">触发限流</option>
                <option value="error">执行失败</option>
              </select>
              <select
                aria-label="统计时间范围"
                value={auditDays}
                onChange={(e) => setAuditDays(Number(e.target.value))}
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
              >
                <option value={7}>最近 7 天</option>
                <option value={30}>最近 30 天</option>
              </select>
            </div>

            {auditQuery.data ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl border border-line bg-surface p-3.5">
                    <p className="text-xs text-muted">调用总量</p>
                    <p className="mt-1 text-2xl font-semibold text-ink">
                      {auditQuery.data.stats.totalCalls}
                    </p>
                  </div>
                  <div className="rounded-xl border border-line bg-surface p-3.5">
                    <p className="text-xs text-muted">成功 / 拒绝 / 限流</p>
                    <p className="mt-1 text-lg font-semibold text-ink">
                      {auditQuery.data.stats.okCalls} / {auditQuery.data.stats.rejectedCalls} /{" "}
                      {auditQuery.data.stats.rateLimitedCalls}
                    </p>
                  </div>
                  <div className="rounded-xl border border-line bg-surface p-3.5">
                    <p className="text-xs text-muted">Token 消耗（入 / 出）</p>
                    <p className="mt-1 text-lg font-semibold text-ink">
                      {auditQuery.data.stats.totalInputTokens} / {auditQuery.data.stats.totalOutputTokens}
                    </p>
                  </div>
                  <div className="rounded-xl border border-line bg-surface p-3.5">
                    <p className="text-xs text-muted">平均耗时</p>
                    <p className="mt-1 text-2xl font-semibold text-ink">
                      {auditQuery.data.stats.avgDurationMs} ms
                    </p>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-line bg-surface">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-line bg-subtle text-inksoft">
                      <tr>
                        <th className="px-3 py-2 font-medium">时间</th>
                        <th className="px-3 py-2 font-medium">应用</th>
                        <th className="px-3 py-2 font-medium">端点</th>
                        <th className="px-3 py-2 font-medium">外部用户</th>
                        <th className="px-3 py-2 font-medium">状态</th>
                        <th className="px-3 py-2 font-medium">耗时</th>
                        <th className="px-3 py-2 font-medium">错误码</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {auditQuery.data.items.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-3 py-8 text-center text-muted">
                            暂无开放接口调用记录
                          </td>
                        </tr>
                      ) : (
                        auditQuery.data.items.map((item) => (
                          <tr key={item.id}>
                            <td className="whitespace-nowrap px-3 py-2 text-muted">
                              {formatTime(item.createdAt)}
                            </td>
                            <td className="px-3 py-2 font-medium text-ink">
                              {item.appName ?? item.appId.slice(0, 8)}
                            </td>
                            <td className="px-3 py-2 font-mono text-inksoft">{item.endpoint}</td>
                            <td className="px-3 py-2 text-muted">{item.externalUserId ?? "—"}</td>
                            <td className="px-3 py-2">
                              <span
                                className={`rounded px-1.5 py-0.5 font-medium ${
                                  item.status === "ok"
                                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                    : "bg-dangersoft text-danger"
                                }`}
                              >
                                {item.status} ({item.httpStatus})
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted">{item.durationMs} ms</td>
                            <td className="px-3 py-2 text-muted">{item.errorCode ?? "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <PageSpinner label="正在加载调用审计…" />
            )}
          </div>
        ) : null}

        {/* Tab 4: Webhooks */}
        {activeTab === "webhooks" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <select
                aria-label="按应用筛选 Webhook"
                value={webhookAppId}
                onChange={(e) => setWebhookAppId(e.target.value)}
                className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
              >
                <option value="">全部应用</option>
                {apps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line bg-subtle text-inksoft">
                  <tr>
                    <th className="px-3 py-2 font-medium">时间</th>
                    <th className="px-3 py-2 font-medium">事件</th>
                    <th className="px-3 py-2 font-medium">目标地址</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">重试次数</th>
                    <th className="px-3 py-2 font-medium">响应/错误</th>
                    <th className="px-3 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(webhooksQuery.data?.items ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-muted">
                        暂无 Webhook 投递记录
                      </td>
                    </tr>
                  ) : (
                    (webhooksQuery.data?.items ?? []).map((delivery) => (
                      <tr key={delivery.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-muted">
                          {formatTime(delivery.createdAt)}
                        </td>
                        <td className="px-3 py-2 font-mono text-ink">{delivery.event}</td>
                        <td className="max-w-xs truncate px-3 py-2 text-inksoft">
                          {delivery.targetUrl}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded px-1.5 py-0.5 font-medium ${
                              delivery.status === "ok"
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                : "bg-dangersoft text-danger"
                            }`}
                          >
                            {delivery.status}
                            {delivery.httpStatus ? ` (${delivery.httpStatus})` : ""}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted">{delivery.attempts}</td>
                        <td className="max-w-xs truncate px-3 py-2 text-muted">
                          {delivery.error ?? delivery.responseSnippet ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={replayWebhookMutation.isPending}
                            onClick={() => replayWebhookMutation.mutate(delivery.id)}
                          >
                            <RefreshCw className="mr-1 h-3 w-3" />
                            重放
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>

      {/* Create / Edit App Sheet */}
      <Sheet open={editingApp !== null} onOpenChange={(open) => (!open ? setEditingApp(null) : undefined)}>
        <SheetContent className="flex w-full max-w-lg flex-col gap-0 p-0">
          <SheetHeader className="border-b border-line px-5 py-4">
            <SheetTitle>{editingApp === "new" ? "新建开放应用" : "编辑开放应用"}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
            {formError ? (
              <p role="alert" className="rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
                {formError}
              </p>
            ) : null}

            <label className="block space-y-1 text-xs">
              <span className="font-medium text-inksoft">应用名称</span>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：经营驾驶舱 / 客服智能问答"
              />
            </label>

            <label className="block space-y-1 text-xs">
              <span className="font-medium text-inksoft">描述（可选）</span>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="说明该业务系统的接入用途"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-inksoft">绑定服务账号</span>
                <select
                  aria-label="绑定服务账号"
                  value={form.serviceUserId}
                  onChange={(e) => setForm({ ...form, serviceUserId: e.target.value })}
                  className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username}
                      {u.displayName ? `（${u.displayName}）` : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1 text-xs">
                <span className="font-medium text-inksoft">状态</span>
                <select
                  aria-label="应用状态"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "disabled" })}
                  className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
                >
                  <option value="active">启用</option>
                  <option value="disabled">停用</option>
                </select>
              </label>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-inksoft">开放能力范围（Scopes）</p>
              <div className="space-y-1.5 rounded-lg border border-line p-3">
                {OPEN_APP_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-xs text-ink">
                    <input
                      type="checkbox"
                      checked={form.scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                    />
                    <span>{OPEN_APP_SCOPE_LABELS[scope]}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-xs font-medium text-inksoft">
                <input
                  type="checkbox"
                  checked={form.restrictDatasources}
                  onChange={(e) => setForm({ ...form, restrictDatasources: e.target.checked })}
                />
                <span>限制仅可访问指定数据源（不勾选则继承服务账号的数据源权限）</span>
              </label>
              {form.restrictDatasources ? (
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-line p-2.5">
                  {datasources.map((ds) => (
                    <label key={ds.id} className="flex items-center gap-2 text-xs text-ink">
                      <input
                        type="checkbox"
                        checked={form.allowedDatasourceIds.includes(ds.id)}
                        onChange={() => toggleDatasource(ds.id)}
                      />
                      <span>
                        {ds.name} ({ds.type})
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="space-y-2 rounded-lg border border-line p-3">
              <label className="flex items-center gap-2 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={form.allowEndUserOverride}
                  onChange={(e) => setForm({ ...form, allowEndUserOverride: e.target.checked })}
                />
                <span>允许调用方透传终端用户与部门/外部组织上下文（走 fail-closed 行级数据权限）</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={form.exposeSql}
                  onChange={(e) => setForm({ ...form, exposeSql: e.target.checked })}
                />
                <span>在返回血缘与 SSE 中暴露执行的只读 SQL</span>
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-inksoft">限流（RPM）</span>
                <Input
                  type="number"
                  min={1}
                  max={10000}
                  value={form.rateLimitRpm}
                  onChange={(e) => setForm({ ...form, rateLimitRpm: e.target.value })}
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-inksoft">最大行数上限</span>
                <Input
                  type="number"
                  min={1}
                  placeholder="默认全局"
                  value={form.maxRowsOverride}
                  onChange={(e) => setForm({ ...form, maxRowsOverride: e.target.value })}
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-inksoft">超时（ms）</span>
                <Input
                  type="number"
                  min={1000}
                  placeholder="默认全局"
                  value={form.timeoutMsOverride}
                  onChange={(e) => setForm({ ...form, timeoutMsOverride: e.target.value })}
                />
              </label>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="font-medium text-inksoft">场景补充提示词（可选，不覆盖只读硬性规则）</span>
              <Textarea
                rows={3}
                value={form.systemPromptExtra}
                onChange={(e) => setForm({ ...form, systemPromptExtra: e.target.value })}
                placeholder="例如：本业务线所有金额默认以万元为单位，保留两位小数。"
              />
            </label>

            <div className="space-y-2 rounded-lg border border-line p-3">
              <p className="text-xs font-medium text-inksoft">Webhook 回调配置（异步任务完成后自动通知）</p>
              <Input
                value={form.webhookUrl}
                onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
                placeholder="https://your-service.example.com/datachat/webhook"
              />
              <Input
                type="password"
                value={form.webhookSecret}
                onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
                placeholder={
                  editingApp && editingApp !== "new" && editingApp.hasWebhookSecret
                    ? "已配置 HMAC 密钥（留空保持不变）"
                    : "HMAC-SHA256 签名密钥（至少 8 位，可选）"
                }
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
            <SheetClose asChild>
              <Button variant="outline" size="sm">
                取消
              </Button>
            </SheetClose>
            <Button size="sm" disabled={saveAppMutation.isPending} onClick={handleSaveApp}>
              {saveAppMutation.isPending ? "保存中…" : "保存应用"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* API Keys & Quick Integration Sheet */}
      <Sheet open={keysApp !== null} onOpenChange={(open) => (!open ? setKeysApp(null) : undefined)}>
        <SheetContent className="flex w-full max-w-xl flex-col gap-0 p-0">
          <SheetHeader className="border-b border-line px-5 py-4">
            <SheetTitle>API 密钥与接入指南 — {keysApp?.name}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
            {issuedRawKey ? (
              <div className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
                <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  新 API Key 已签发（仅展示这一次，请立即保存）：
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-surface px-2.5 py-1.5 text-xs text-ink">
                    {issuedRawKey}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => void handleCopyRawKey()}>
                    {copiedKey ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="space-y-2 rounded-lg border border-line p-3">
              <p className="text-xs font-medium text-inksoft">签发新密钥</p>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="min-w-[180px] flex-1"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="密钥备注，例如：生产环境"
                />
                <Input
                  className="w-32"
                  type="number"
                  min={1}
                  max={3650}
                  value={newKeyExpiresDays}
                  onChange={(e) => setNewKeyExpiresDays(e.target.value)}
                  placeholder="有效天数(可空)"
                />
                <Button
                  size="sm"
                  disabled={!newKeyName.trim() || issueKeyMutation.isPending || !keysApp}
                  onClick={() =>
                    issueKeyMutation.mutate({
                      appId: keysApp!.id,
                      name: newKeyName.trim(),
                      expiresInDays: newKeyExpiresDays.trim() ? Number(newKeyExpiresDays) : null,
                    })
                  }
                >
                  签发密钥
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-inksoft">已签发密钥</p>
              {(keysQuery.data?.items ?? []).length === 0 ? (
                <p className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-muted">
                  暂无密钥，请先签发一个 API Key。
                </p>
              ) : (
                <div className="divide-y divide-line rounded-lg border border-line">
                  {(keysQuery.data?.items ?? []).map((key) => {
                    const revoked = key.revokedAt !== null;
                    return (
                      <div key={key.id} className="flex items-center justify-between gap-2 p-3 text-xs">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-ink">{key.name}</span>
                            <code className="rounded bg-subtle px-1.5 py-0.5 text-inksoft">
                              {key.keyPrefix}…
                            </code>
                            {revoked ? (
                              <span className="rounded bg-dangersoft px-1.5 py-0.5 text-danger">
                                已吊销
                              </span>
                            ) : null}
                          </div>
                          <p className="text-muted">
                            最近使用：{formatTime(key.lastUsedAt)} · 过期时间：
                            {key.expiresAt ? formatTime(key.expiresAt) : "永不过期"}
                          </p>
                        </div>
                        {!revoked && keysApp ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={revokeKeyMutation.isPending}
                            onClick={() =>
                              revokeKeyMutation.mutate({ appId: keysApp.id, keyId: key.id })
                            }
                          >
                            吊销
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2 rounded-lg border border-line bg-subtle/40 p-3">
              <p className="text-xs font-medium text-inksoft">快速接入示例</p>
              <pre className="overflow-x-auto rounded bg-surface p-2.5 text-[11px] text-ink">
{`# 1. 结构化问答（Ask API）
curl -X POST "${origin}/api/open/v1/ask" \\
  -H "Authorization: Bearer ${issuedRawKey ?? "dc_open_YOUR_API_KEY"}" \\
  -H "Content-Type: application/json" \\
  -d '{"datasourceId":"<DATASOURCE_ID>","question":"统计本月各渠道销售额","mode":"sync"}'

# 2. 远程 MCP Server（适用于 Dify / Coze / Claude 等 Agent）
# Endpoint: ${origin}/api/open/v1/mcp
# Header:   Authorization: Bearer ${issuedRawKey ?? "dc_open_YOUR_API_KEY"}`}
              </pre>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {deletingApp ? (
        <ConfirmDialog
          title={`删除应用「${deletingApp.name}」？`}
          description="删除后该应用下的所有 API Key 将立即失效，且不可恢复。"
          confirmLabel="确认删除"
          variant="danger"
          pending={deleteAppMutation.isPending}
          error={deleteAppMutation.isError ? errorText(deleteAppMutation.error, "删除失败") : null}
          onConfirm={() => deleteAppMutation.mutate(deletingApp.id)}
          onCancel={() => setDeletingApp(null)}
        />
      ) : null}
    </AdminShell>
  );
}
