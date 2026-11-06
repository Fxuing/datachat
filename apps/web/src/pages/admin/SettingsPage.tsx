import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, RotateCcw, Save } from "lucide-react";
import { AppShell } from "../../components/AppShell";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { PageSpinner } from "../../components/ui/spinner";
import {
  fetchMe,
  getAdminSettings,
  listModels,
  updateAdminSettings,
  type AdminSettings,
  type AdminSettingsPatch,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";

const selectClass =
  "h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 " +
  "focus-visible:border-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-200";

type NumberKey = "queryMaxRows" | "queryPreviewRows" | "queryTimeoutMs" | "shareMaxDays";

interface NumberField {
  key: NumberKey;
  label: string;
  min: number;
  max: number;
  hint: string;
}

const NUMBER_FIELDS: NumberField[] = [
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
  {
    key: "shareMaxDays",
    label: "分享最长有效期（天）",
    min: 1,
    max: 365,
    hint: "创建分享链接时允许设置的最长天数",
  },
];

type Draft = Record<NumberKey, string> & { defaultModelId: string };
type DraftErrors = Partial<Record<keyof Draft, string>>;

function toDraft(settings: AdminSettings): Draft {
  return {
    defaultModelId: settings.defaultModelId ?? "",
    queryMaxRows: String(settings.queryMaxRows),
    queryPreviewRows: String(settings.queryPreviewRows),
    queryTimeoutMs: String(settings.queryTimeoutMs),
    shareMaxDays: String(settings.shareMaxDays),
  };
}

function toPatch(draft: Draft): AdminSettingsPatch {
  return {
    defaultModelId: draft.defaultModelId || null,
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

export default function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const settingsQuery = useQuery({
    queryKey: queryKeys.adminSettings,
    queryFn: getAdminSettings,
  });
  const modelsQuery = useQuery({ queryKey: queryKeys.models, queryFn: listModels });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    mutationFn: () =>
      updateAdminSettings({
        defaultModelId: null,
        queryMaxRows: null,
        queryPreviewRows: null,
        queryTimeoutMs: null,
        shareMaxDays: null,
      }),
    onSuccess: (data) => {
      setDraft(toDraft(data.settings));
      setErrors({});
      setSaveError(null);
      setNotice("已恢复默认设置");
      queryClient.setQueryData(queryKeys.adminSettings, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
    onError: (error) => {
      setNotice(null);
      setSaveError(describeApiError(error, "恢复默认失败，请稍后重试"));
    },
  });

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const sidebar = (
    <div className="border-t border-neutral-200 p-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-1.5"
        onClick={() => navigate("/chat")}
      >
        <ArrowLeft className="h-4 w-4" />
        返回对话
      </Button>
    </div>
  );

  const busy = saveMutation.isPending || resetMutation.isPending;
  const models = modelsQuery.data?.models ?? [];
  const modelConfigured = modelsQuery.data?.configured ?? false;

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

  return (
    <AppShell user={user} sidebar={sidebar}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          <h1 className="text-lg font-semibold text-neutral-900">设置</h1>
          <p className="mt-1 text-sm text-neutral-500">
            默认模型会影响模型列表与新会话，分享上限会限制新建分享链接的有效期；未保存的项沿用服务端配置。
          </p>

          {draft === null ? (
            settingsQuery.isError ? (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
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
              className="mt-4 space-y-5 rounded-lg border border-neutral-200 bg-white p-6"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {notice ? (
                <p
                  role="status"
                  className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700"
                >
                  {notice}
                </p>
              ) : null}
              {saveError ? (
                <p
                  role="alert"
                  className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                >
                  {saveError}
                </p>
              ) : null}

              <div>
                <label
                  htmlFor="default-model"
                  className="text-sm font-medium text-neutral-800"
                >
                  默认模型
                </label>
                <select
                  id="default-model"
                  aria-label="默认模型"
                  className={`${selectClass} mt-1.5`}
                  value={draft.defaultModelId}
                  disabled={busy}
                  onChange={(event) => updateDraft({ defaultModelId: event.target.value })}
                >
                  <option value="">未设置（自动使用第一个可用模型）</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}（{model.id}）
                    </option>
                  ))}
                  {draft.defaultModelId && !models.some((m) => m.id === draft.defaultModelId) ? (
                    <option value={draft.defaultModelId}>{draft.defaultModelId}</option>
                  ) : null}
                </select>
                <p className="mt-1.5 text-xs text-neutral-500">
                  {modelConfigured
                    ? "新会话会使用该模型；未设置时使用第一个可用模型。"
                    : "尚未配置模型服务，暂时只能使用自动选择。"}
                </p>
                {modelsQuery.isError ? (
                  <p role="alert" className="mt-1 text-xs text-red-600">
                    {describeApiError(modelsQuery.error, "模型列表加载失败")}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {NUMBER_FIELDS.map((field) => {
                  const error = errors[field.key];
                  const describedBy = error ? `${field.key}-error` : undefined;
                  return (
                    <div key={field.key}>
                      <label
                        htmlFor={field.key}
                        className="text-sm font-medium text-neutral-800"
                      >
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
                        value={draft[field.key]}
                        disabled={busy}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={describedBy}
                        onChange={(event) => updateDraft({ [field.key]: event.target.value })}
                      />
                      {error ? (
                        <p id={describedBy} role="alert" className="mt-1 text-xs text-red-600">
                          {error}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-neutral-500">{field.hint}</p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-4">
                <Button type="submit" size="sm" className="gap-1.5" disabled={busy}>
                  <Save className="h-3.5 w-3.5" />
                  {saveMutation.isPending ? "保存中…" : "保存设置"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => {
                    setNotice(null);
                    setSaveError(null);
                    resetMutation.mutate();
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {resetMutation.isPending ? "恢复中…" : "恢复默认"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </AppShell>
  );
}
