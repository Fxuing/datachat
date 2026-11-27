import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Bot, Gauge, Link2, RotateCcw, Save, Settings, Share2 } from "lucide-react";
import { AdminShell } from "../../components/admin/AdminShell";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { LlmProvidersSection } from "../../components/admin/LlmProvidersSection";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { PageSpinner } from "../../components/ui/spinner";
import { useToast } from "../../components/ui/toast";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  fetchMe,
  getAdminSettings,
  listModels,
  listShares,
  revokeShare,
  updateAdminSettings,
  type AdminSettings,
  type AdminSettingsPatch,
  type ChatModelInfo,
  type ShareListItem,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { formatDateTime } from "../../lib/utils";

type NumberKey = "queryMaxRows" | "queryPreviewRows" | "queryTimeoutMs" | "shareMaxDays";

interface NumberField {
  key: NumberKey;
  label: string;
  min: number;
  max: number;
  hint: string;
}

const QUERY_FIELDS: NumberField[] = [
  {
    key: "queryMaxRows",
    label: "查询最大行数",
    min: 1,
    max: 100_000,
    hint: "单次查询允许返回的最大行数",
  },
  {
    key: "queryPreviewRows",
    label: "预览行数",
    min: 1,
    max: 1_000,
    hint: "结果预览与导出抽样展示的行数",
  },
  {
    key: "queryTimeoutMs",
    label: "查询超时（毫秒）",
    min: 1_000,
    max: 300_000,
    hint: "超过该时长的查询会被终止",
  },
];

const SHARE_FIELDS: NumberField[] = [
  {
    key: "shareMaxDays",
    label: "分享最长有效期（天）",
    min: 1,
    max: 365,
    hint: "创建分享链接时允许设置的最长天数",
  },
];

const NUMBER_FIELDS = [...QUERY_FIELDS, ...SHARE_FIELDS];

type Section = "general" | "providers" | "query" | "share";

const SECTIONS: Array<{ id: Section; label: string; icon: typeof Settings }> = [
  { id: "general", label: "通用", icon: Settings },
  { id: "providers", label: "模型服务", icon: Bot },
  { id: "query", label: "查询限制", icon: Gauge },
  { id: "share", label: "分享", icon: Share2 },
];

type Draft = Record<NumberKey, string> & { defaultModelId: string; memoryEnabled: boolean };
type DraftErrors = Partial<Record<keyof Draft, string>>;

function toDraft(settings: AdminSettings): Draft {
  return {
    defaultModelId: settings.defaultModelId ?? "",
    memoryEnabled: settings.memoryEnabled,
    queryMaxRows: String(settings.queryMaxRows),
    queryPreviewRows: String(settings.queryPreviewRows),
    queryTimeoutMs: String(settings.queryTimeoutMs),
    shareMaxDays: String(settings.shareMaxDays),
  };
}

function toPatch(draft: Draft): AdminSettingsPatch {
  return {
    defaultModelId: draft.defaultModelId || null,
    memoryEnabled: draft.memoryEnabled,
    queryMaxRows: Number(draft.queryMaxRows),
    queryPreviewRows: Number(draft.queryPreviewRows),
    queryTimeoutMs: Number(draft.queryTimeoutMs),
    shareMaxDays: Number(draft.shareMaxDays),
  };
}

function validateDraft(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  for (const field of NUMBER_FIELDS) {
    const raw = draft[field.key].trim();
    if (!/^\d+$/.test(raw)) {
      errors[field.key] = `请输入整数，范围 ${field.min} 到 ${field.max}`;
      continue;
    }
    const value = Number(raw);
    if (value < field.min || value > field.max) {
      errors[field.key] = `需在 ${field.min} 到 ${field.max} 之间`;
    }
  }
  return errors;
}

function groupModels(models: ChatModelInfo[]): Array<[string, ChatModelInfo[]]> {
  const groups = new Map<string, ChatModelInfo[]>();
  for (const model of models) {
    const list = groups.get(model.providerName) ?? [];
    list.push(model);
    groups.set(model.providerName, list);
  }
  return [...groups.entries()];
}

function resetPatchForSection(section: Exclude<Section, "providers">): AdminSettingsPatch {
  if (section === "general") return { defaultModelId: null, memoryEnabled: null };
  if (section === "query") {
    return { queryMaxRows: null, queryPreviewRows: null, queryTimeoutMs: null };
  }
  return { shareMaxDays: null };
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [params] = useSearchParams();
  const sectionParam = params.get("section");
  const section: Section = SECTIONS.some((item) => item.id === sectionParam)
    ? (sectionParam as Section)
    : "general";

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const settingsQuery = useQuery({
    queryKey: queryKeys.adminSettings,
    queryFn: getAdminSettings,
  });
  const modelsQuery = useQuery({ queryKey: queryKeys.models, queryFn: listModels });
  const activeSharesQuery = useQuery({
    queryKey: queryKeys.shares({ scope: "all", status: "active" }),
    queryFn: () => listShares({ scope: "all", status: "active" }),
    enabled: section === "share",
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [revokingShare, setRevokingShare] = useState<ShareListItem | null>(null);

  const revokeShareMutation = useMutation({
    mutationFn: (id: string) => revokeShare(id),
    onSuccess: () => {
      setRevokingShare(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharesAll });
      toast.success("已撤销分享链接");
    },
    onError: (err) => {
      toast.error(describeApiError(err, "撤销分享链接失败"));
    },
  });

  useEffect(() => {
    if (settingsQuery.data && draft === null) {
      setDraft(toDraft(settingsQuery.data.settings));
    }
  }, [settingsQuery.data, draft]);

  const saveMutation = useMutation({
    mutationFn: updateAdminSettings,
    onSuccess: (data) => {
      setDraft(toDraft(data.settings));
      setErrors({});
      setSaveError(null);
      setNotice("设置已保存");
      queryClient.setQueryData(queryKeys.adminSettings, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (error) => {
      setNotice(null);
      setSaveError(describeApiError(error, "保存失败，请稍后重试"));
    },
  });

  const resetMutation = useMutation({
    mutationFn: (target: Exclude<Section, "providers">) =>
      updateAdminSettings(resetPatchForSection(target)),
    onSuccess: (data) => {
      setConfirmReset(false);
      setDraft(toDraft(data.settings));
      setErrors({});
      setSaveError(null);
      setNotice("已恢复默认设置");
      queryClient.setQueryData(queryKeys.adminSettings, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (error) => {
      setConfirmReset(false);
      setNotice(null);
      setSaveError(describeApiError(error, "恢复默认失败，请稍后重试"));
    },
  });

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;


  const busy = saveMutation.isPending || resetMutation.isPending;
  const models = modelsQuery.data?.models ?? [];
  const modelConfigured = models.length > 0;

  const updateDraft = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setNotice(null);
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch) as (keyof Draft)[]) delete next[key];
      return next;
    });
  };

  const submit = () => {
    if (!draft || busy) return;
    const nextErrors = validateDraft(draft);
    setErrors(nextErrors);
    setNotice(null);
    setSaveError(null);
    if (Object.keys(nextErrors).length > 0) return;
    saveMutation.mutate(toPatch(draft));
  };

  const renderNumberField = (field: NumberField) => {
    const error = errors[field.key];
    const describedBy = error ? `${field.key}-error` : undefined;
    return (
      <div key={field.key}>
        <label htmlFor={field.key} className="text-sm font-medium text-inksoft">
          {field.label}
        </label>
        <Input
          id={field.key}
          aria-label={field.label}
          type="number"
          inputMode="numeric"
          min={field.min}
          max={field.max}
          step={1}
          className="mt-1.5"
          value={draft?.[field.key] ?? ""}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => updateDraft({ [field.key]: event.target.value })}
        />
        {error ? (
          <p id={describedBy} role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted">{field.hint}</p>
        )}
      </div>
    );
  };

  const current = SECTIONS.find((item) => item.id === section)!;

  return (
    <AdminShell user={user}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <h1 className="text-xl font-semibold tracking-tight text-ink">设置</h1>
          <p className="mt-1 text-sm text-muted">
            模型服务、数据源、成员与治理入口集中在这里；查询与分享限制对所有新请求生效。
          </p>

          <div className="mt-5 flex flex-col gap-5 md:flex-row">

            <div className="min-w-0 flex-1">
              <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">{current.label}</h2>
                    <p className="mt-0.5 text-xs text-muted">
                      {section === "general"
                        ? "新会话默认使用的模型。"
                        : section === "providers"
                          ? "管理可用的模型供应商与模型白名单。"
                          : section === "query"
                            ? "限制单次查询返回规模与执行时长。"
                            : "控制分享链接的最长有效期。"}
                    </p>
                  </div>
                  {section !== "providers" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={busy}
                      onClick={() => {
                        setNotice(null);
                        setSaveError(null);
                        setConfirmReset(true);
                      }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {resetMutation.isPending ? "恢复中…" : "恢复默认"}
                    </Button>
                  ) : null}
                </div>

                {section === "providers" ? (
                  <div className="mt-4">
                    <LlmProvidersSection />
                  </div>
                ) : draft === null ? (
                  settingsQuery.isError ? (
                    <div className="mt-4 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
                      <p role="alert">{describeApiError(settingsQuery.error, "加载设置失败")}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() => void settingsQuery.refetch()}
                      >
                        重试
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-4">
                      <PageSpinner />
                    </div>
                  )
                ) : (
                  <form
                    noValidate
                    className="mt-4 space-y-5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submit();
                    }}
                  >
                    {notice ? (
                      <p
                        role="status"
                        className="rounded-md border border-success/20 bg-successsoft px-3 py-2 text-xs text-success"
                      >
                        {notice}
                      </p>
                    ) : null}
                    {saveError ? (
                      <p
                        role="alert"
                        className="rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
                      >
                        {saveError}
                      </p>
                    ) : null}

                    {section === "general" ? (
                      <div>
                        <label htmlFor="default-model" className="text-sm font-medium text-inksoft">
                          默认模型
                        </label>
                        <Select
                          value={draft.defaultModelId || "__none__"}
                          onValueChange={(value) =>
                            updateDraft({ defaultModelId: value === "__none__" ? "" : value })
                          }
                          disabled={busy || !modelConfigured}
                        >
                          <SelectTrigger id="default-model" aria-label="默认模型" className="mt-1.5">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">
                              未设置（自动使用第一个可用模型）
                            </SelectItem>
                            {groupModels(models).map(([providerName, providerModels]) => (
                              <SelectGroup key={providerName}>
                                <SelectLabel>{providerName}</SelectLabel>
                                {providerModels.map((model) => (
                                  <SelectItem key={model.id} value={model.id}>
                                    {model.name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                            {draft.defaultModelId &&
                            !models.some((model) => model.id === draft.defaultModelId) ? (
                              <SelectItem value={draft.defaultModelId}>
                                {draft.defaultModelId}
                              </SelectItem>
                            ) : null}
                          </SelectContent>
                        </Select>
                        <p className="mt-1.5 text-xs text-muted">
                          {modelsQuery.isPending
                            ? "正在加载模型服务…"
                            : modelsQuery.isError
                              ? "模型列表加载失败，请稍后重试。"
                              : modelConfigured
                                ? "新会话会使用该模型；未设置时使用第一个可用模型。"
                                : "尚未配置可用的模型服务，请先到「模型服务」添加。"}
                        </p>
                        {modelsQuery.isError ? (
                          <p role="alert" className="mt-1 text-xs text-danger">
                            {describeApiError(modelsQuery.error, "模型列表加载失败")}
                          </p>
                        ) : null}

                        <div className="mt-6 border-t border-line pt-4">
                          <label className="flex cursor-pointer items-start gap-2.5">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-3.5 w-3.5 accent-brand"
                              checked={draft.memoryEnabled}
                              onChange={(event) => updateDraft({ memoryEnabled: event.target.checked })}
                            />
                            <span>
                              <span className="block text-sm font-medium text-inksoft">启用用户记忆</span>
                              <span className="mt-0.5 block text-xs text-muted">
                                关闭后停止注入和自动提取，已有记忆保留；用户仍可在“我的记忆”中删除。
                              </span>
                            </span>
                          </label>
                        </div>
                      </div>
                    ) : null}

                    {section === "query" ? (
                      <div className="grid gap-4 sm:grid-cols-2">
                        {QUERY_FIELDS.map(renderNumberField)}
                      </div>
                    ) : null}

                    {section === "share" ? (
                      <div className="grid gap-4 sm:grid-cols-2">
                        {SHARE_FIELDS.map(renderNumberField)}
                      </div>
                    ) : null}

                    <div className="flex items-center gap-2 border-t border-line pt-4">
                      <Button type="submit" size="sm" className="gap-1.5" disabled={busy}>
                        <Save className="h-3.5 w-3.5" />
                        {saveMutation.isPending ? "保存中…" : "保存设置"}
                      </Button>
                    </div>
                  </form>
                )}
              </div>

              {section === "share" ? (
                <div className="mt-5 rounded-xl border border-line bg-surface p-6 shadow-card">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <Link2 className="h-4 w-4 text-brand" />
                        全站活跃分享
                      </h2>
                      <p className="mt-0.5 text-xs text-muted">
                        查看当前所有生效中的公开只读链接，必要时可由管理员立即吊销。
                      </p>
                    </div>
                    <span className="text-xs text-muted">
                      {(activeSharesQuery.data?.shares ?? []).length} 条生效中
                    </span>
                  </div>

                  {activeSharesQuery.isPending ? (
                    <p className="mt-4 text-xs text-muted">加载分享列表中…</p>
                  ) : activeSharesQuery.isError ? (
                    <p role="alert" className="mt-4 text-xs text-danger">
                      {describeApiError(activeSharesQuery.error, "加载活跃分享失败")}
                    </p>
                  ) : (activeSharesQuery.data?.shares ?? []).length === 0 ? (
                    <p className="mt-4 rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-muted">
                      当前全站没有生效中的公开分享链接。
                    </p>
                  ) : (
                    <div className="mt-4 overflow-x-auto rounded-lg border border-line">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-line bg-subtle/60 text-[11px] text-muted">
                          <tr>
                            <th className="px-3 py-2 font-medium">分享目标</th>
                            <th className="px-3 py-2 font-medium">创建人</th>
                            <th className="px-3 py-2 font-medium">过期时间</th>
                            <th className="px-3 py-2 text-right font-medium">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {(activeSharesQuery.data?.shares ?? []).map((item) => (
                            <tr key={item.id}>
                              <td className="px-3 py-2.5">
                                <span className="mr-1.5 rounded bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-inksoft">
                                  {item.targetType === "conversation"
                                    ? "会话"
                                    : item.targetType === "report"
                                      ? "报告"
                                      : "看板"}
                                </span>
                                <span className="font-medium text-ink">{item.targetTitle}</span>
                              </td>
                              <td className="px-3 py-2.5 text-muted">
                                @{item.creatorUsername ?? "未知"}
                              </td>
                              <td className="px-3 py-2.5 text-muted">
                                {formatDateTime(item.expiresAt)}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="text-danger hover:bg-dangersoft hover:text-danger"
                                  onClick={() => {
                                    revokeShareMutation.reset();
                                    setRevokingShare(item);
                                  }}
                                >
                                  撤销
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {revokingShare ? (
        <ConfirmDialog
          title="撤销分享链接"
          description={`确定立即撤销「${revokingShare.targetTitle}」的公开分享链接吗？撤销后任何持有该链接的人都将无法继续访问。`}
          confirmLabel={revokeShareMutation.isPending ? "撤销中…" : "确认撤销"}
          variant="danger"
          pending={revokeShareMutation.isPending}
          error={
            revokeShareMutation.isError
              ? describeApiError(revokeShareMutation.error, "撤销分享链接失败")
              : null
          }
          onConfirm={() => revokeShareMutation.mutate(revokingShare.id)}
          onCancel={() => {
            revokeShareMutation.reset();
            setRevokingShare(null);
          }}
        />
      ) : null}
      {confirmReset && section !== "providers" ? (
        <ConfirmDialog
          title={`恢复「${current.label}」默认设置`}
          description={`将仅重置「${current.label}」分栏的设置项为系统默认值，不会影响其他分栏的配置。`}
          confirmLabel={resetMutation.isPending ? "恢复中…" : "确认恢复"}
          pending={resetMutation.isPending}
          onConfirm={() => resetMutation.mutate(section)}
          onCancel={() => {
            if (!resetMutation.isPending) setConfirmReset(false);
          }}
        />
      ) : null}
    </AdminShell>
  );
}
