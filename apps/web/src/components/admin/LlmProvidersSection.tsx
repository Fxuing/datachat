import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PageSpinner } from "../ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  createLlmProvider,
  deleteLlmProvider,
  listLlmProviders,
  refreshLlmProvider,
  testLlmProvider,
  updateLlmProvider,
  type LlmProvider,
  type LlmProviderModel,
  type LlmProtocol,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { ConfirmDialog } from "./ConfirmDialog";

const selectClass =
  "h-10 w-full rounded-md border border-linestrong bg-surface px-3 text-sm text-ink " +
  "focus-visible:border-linestrong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/15";

const PROTOCOL_LABEL: Record<LlmProtocol, string> = {
  "openai-completions": "OpenAI 兼容",
  "anthropic-messages": "Anthropic",
};

type EditorState = { mode: "new" } | { mode: "edit"; provider: LlmProvider };

interface EditorDraft {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  selected: LlmProviderModel[];
}

/** Model service management: add OpenAI/Anthropic-compatible providers and pick models. */
export function LlmProvidersSection() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: queryKeys.llmProviders,
    queryFn: listLlmProviders,
  });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<LlmProvider | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.llmProviders });
    void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    void queryClient.invalidateQueries({ queryKey: queryKeys.adminSettings });
  };

  const toggleMutation = useMutation({
    mutationFn: (provider: LlmProvider) =>
      updateLlmProvider(provider.id, { enabled: !provider.enabled }),
    onSuccess: invalidate,
    onError: (error) => setActionError(describeApiError(error, "更新状态失败")),
  });

  const refreshMutation = useMutation({
    mutationFn: (provider: LlmProvider) => refreshLlmProvider(provider.id),
    onSuccess: invalidate,
    onError: (error) => setActionError(describeApiError(error, "获取模型失败")),
  });

  const deleteMutation = useMutation({
    mutationFn: (provider: LlmProvider) => deleteLlmProvider(provider.id),
    onSuccess: () => {
      setDeleting(null);
      invalidate();
    },
    onError: (error) => setActionError(describeApiError(error, "删除失败")),
  });

  if (providersQuery.isPending) return <PageSpinner />;
  if (providersQuery.isError) {
    return (
      <div className="rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
        <p role="alert">{describeApiError(providersQuery.error, "加载模型服务失败")}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => void providersQuery.refetch()}
        >
          重试
        </Button>
      </div>
    );
  }

  const providers = providersQuery.data.providers;
  const busy = toggleMutation.isPending || refreshMutation.isPending || deleteMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-xs text-muted">
          支持任意 OpenAI 兼容或 Anthropic 兼容服务。保存后会出现在新建会话的模型选择中；已开始的会话保持原模型。
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => setEditor({ mode: "new" })}>
          <Plus className="h-3.5 w-3.5" />
          添加模型服务
        </Button>
      </div>

      {actionError ? (
        <p role="alert" className="rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
          {actionError}
        </p>
      ) : null}

      {providers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-linestrong bg-surface px-6 py-10 text-center">
          <Bot className="mx-auto h-6 w-6 text-muted" />
          <p className="mt-2 text-sm font-medium text-ink">还没有模型服务</p>
          <p className="mt-1 text-xs text-muted">
            填写 Base URL 与 API Key，测试连通后勾选要开放的模型。
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{provider.name}</span>
                  <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] text-inksoft">
                    {PROTOCOL_LABEL[provider.protocol]}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] ${
                      provider.enabled
                        ? "bg-successsoft text-success"
                        : "bg-subtle text-muted"
                    }`}
                  >
                    {provider.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted">{provider.baseUrl}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {provider.models.length} 个模型 · Key {provider.maskedKey || "未设置"}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    toggleMutation.mutate(provider);
                  }}
                >
                  {provider.enabled ? "停用" : "启用"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`刷新 ${provider.name} 的模型`}
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    refreshMutation.mutate(provider);
                  }}
                >
                  <RefreshCw className={`h-4 w-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`编辑 ${provider.name}`}
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    setEditor({ mode: "edit", provider });
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除 ${provider.name}`}
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    setDeleting(provider);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editor ? (
        <ProviderEditor
          state={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            invalidate();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`删除模型服务「${deleting.name}」？`}
          description="该服务下的模型会从模型列表中移除；已经使用它们的会话需要重新选择模型。"
          confirmLabel="删除"
          variant="danger"
          pending={deleteMutation.isPending}
          error={actionError}
          onCancel={() => {
            setDeleting(null);
            setActionError(null);
          }}
          onConfirm={() => {
            setActionError(null);
            deleteMutation.mutate(deleting);
          }}
        />
      ) : null}
    </div>
  );
}

function formatContext(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

function ProviderEditor({
  state,
  onClose,
  onSaved,
}: {
  state: EditorState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = state.mode === "edit" ? state.provider : undefined;
  const [draft, setDraft] = useState<EditorDraft>({
    name: existing?.name ?? "",
    protocol: existing?.protocol ?? "openai-completions",
    baseUrl: existing?.baseUrl ?? "",
    apiKey: "",
    selected: existing?.models ?? [],
  });
  const [tested, setTested] = useState<LlmProviderModel[]>(existing?.models ?? []);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const testMutation = useMutation({
    mutationFn: () =>
      testLlmProvider({
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
        providerId: existing?.id,
      }),
    onSuccess: (data) => {
      setError(null);
      setTested(data.models);
      const selectedIds = new Set(draft.selected.map((model) => model.id));
      // Keep existing choices; preselect everything on a fresh provider.
      const nextSelected =
        existing?.models.length
          ? data.models.filter((model) => selectedIds.has(model.id))
          : data.models;
      setDraft((current) => ({
        ...current,
        selected: nextSelected.length > 0 ? nextSelected : data.models,
      }));
      setNotice(`连接成功，获取到 ${data.count} 个模型`);
    },
    onError: (mutationError) => {
      setNotice(null);
      setError(describeApiError(mutationError, "测试失败，请检查地址与 Key"));
    },
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const models = draft.selected.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
      if (existing) {
        return updateLlmProvider(existing.id, {
          name: draft.name,
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          models,
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        });
      }
      return createLlmProvider({
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        models,
      });
    },
    onSuccess: onSaved,
    onError: (mutationError) => {
      setNotice(null);
      setError(describeApiError(mutationError, "保存失败"));
    },
  });

  const submit = () => {
    if (saveMutation.isPending) return;
    if (!draft.name.trim()) return setError("请填写名称");
    if (!/^https?:\/\/\S+$/i.test(draft.baseUrl.trim())) return setError("Base URL 需要以 http(s):// 开头");
    if (!existing && !draft.apiKey.trim()) return setError("请填写 API Key");
    if (draft.selected.length === 0) return setError("请至少勾选一个模型");
    setError(null);
    saveMutation.mutate();
  };

  const selectedIds = new Set(draft.selected.map((model) => model.id));
  const updateContext = (id: string, contextWindow: number) => {
    setDraft((current) => ({
      ...current,
      selected: current.selected.map((model) =>
        model.id === id ? { ...model, contextWindow } : model,
      ),
    }));
  };

  const toggleModel = (model: LlmProviderModel) => {
    setDraft((current) => {
      const has = current.selected.some((item) => item.id === model.id);
      return {
        ...current,
        selected: has
          ? current.selected.filter((item) => item.id !== model.id)
          : [...current.selected, model],
      };
    });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/30"
      role="presentation"
      onMouseDown={() => onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={existing ? "编辑模型服务" : "添加模型服务"}
        className="flex h-full w-full max-w-xl flex-col border-l border-line bg-surface shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">
              {existing ? "编辑模型服务" : "添加模型服务"}
            </h2>
            <p className="mt-0.5 text-xs text-muted">Key 使用 APP_SECRET 加密存储，不会回传明文。</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error ? (
            <p role="alert" className="rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="rounded-md border border-success/20 bg-successsoft px-3 py-2 text-xs text-success">
              {notice}
            </p>
          ) : null}

          <div>
            <label htmlFor="llm-name" className="text-sm font-medium text-inksoft">名称</label>
            <Input
              id="llm-name"
              className="mt-1.5"
              placeholder="例如 硅基流动、公司网关"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>

          <div>
            <label htmlFor="llm-protocol" className="text-sm font-medium text-inksoft">协议</label>
            <Select
              value={draft.protocol}
              onValueChange={(value) => setDraft({ ...draft, protocol: value as LlmProtocol })}
            >
              <SelectTrigger id="llm-protocol" className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-completions">
                  OpenAI 兼容（/v1/chat/completions）
                </SelectItem>
                <SelectItem value="anthropic-messages">Anthropic（/v1/messages）</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label htmlFor="llm-base-url" className="text-sm font-medium text-inksoft">Base URL</label>
            <Input
              id="llm-base-url"
              className="mt-1.5 font-mono text-xs"
              placeholder="https://api.siliconflow.cn/v1"
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
            <p className="mt-1 text-xs text-muted">
              测试时会请求 {draft.protocol === "anthropic-messages" ? "<Base>/v1/models" : "<Base>/models"}。
            </p>
          </div>

          <div>
            <label htmlFor="llm-api-key" className="text-sm font-medium text-inksoft">API Key</label>
            <Input
              id="llm-api-key"
              type="password"
              autoComplete="new-password"
              className="mt-1.5 font-mono text-xs"
              placeholder={existing?.maskedKey ? `${existing.maskedKey}（留空保持不变）` : "sk-..."}
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={testMutation.isPending || !draft.baseUrl.trim()}
              onClick={() => {
                setError(null);
                setNotice(null);
                testMutation.mutate();
              }}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${testMutation.isPending ? "animate-spin" : ""}`} />
              {testMutation.isPending ? "获取中…" : "测试并获取模型"}
            </Button>
            <span className="text-xs text-muted">已选 {draft.selected.length} 个模型</span>
          </div>

          {tested.length > 0 ? (
            <fieldset className="rounded-lg border border-line">
              <legend className="ml-2 px-1 text-xs font-medium text-inksoft">开放模型</legend>
              <div className="max-h-64 space-y-1 overflow-y-auto p-2">
                {tested.map((model) => {
                  const selected = draft.selected.find((item) => item.id === model.id);
                  return (
                    <div
                      key={model.id}
                      className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-subtle"
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-[rgb(var(--brand))]"
                          checked={selectedIds.has(model.id)}
                          onChange={() => toggleModel(model)}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">{model.name}</span>
                          <span className="block truncate font-mono text-[11px] text-muted">{model.id}</span>
                        </span>
                      </label>
                      {selected ? (
                        <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted">
                          上下文
                          <input
                            type="number"
                            min={1}
                            step={1}
                            aria-label={`${model.name} 上下文大小（千 tokens）`}
                            className="h-6 w-14 rounded border border-line bg-canvas px-1 text-right text-[11px] text-ink"
                            value={Math.max(1, Math.round(selected.contextWindow / 1000))}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              if (Number.isFinite(value) && value > 0) {
                                updateContext(model.id, Math.round(value * 1000));
                              }
                            }}
                          />
                          k
                        </label>
                      ) : (
                        <span className="shrink-0 text-[10px] text-muted">
                          {formatContext(model.contextWindow)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ) : (
            <p className="text-xs text-muted">先点击“测试并获取模型”，再勾选要开放的模型。</p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saveMutation.isPending}>
            取消
          </Button>
          <Button size="sm" onClick={submit} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "保存中…" : "保存"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
