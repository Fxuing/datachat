import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Filter, Pencil, Plus, Search, Star, Trash2, X } from "lucide-react";
import {
  clearMemories,
  createMemory,
  deleteMemory,
  fetchMe,
  getMemorySettings,
  listDatasources,
  listMemories,
  updateMemory,
  updateMemorySettings,
  type MemoryInput,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
} from "../lib/api";
import { AppShell } from "../components/AppShell";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useToast } from "../components/ui/toast";
import { useCan } from "../hooks/use-access";
import { describeApiError } from "../lib/errors";
import { queryKeys } from "../lib/query";
import { cn, formatDateTime } from "../lib/utils";
import { MemoryDialog } from "../components/memory/MemoryDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const kindLabels: Record<MemoryKind, string> = {
  profile: "画像",
  instruction: "固定指令",
  preference: "偏好",
  fact: "事实",
};

const kindTones: Record<MemoryKind, string> = {
  profile: "bg-brandsoft text-brandtext",
  instruction: "bg-warningsoft text-warning",
  preference: "bg-successsoft text-success",
  fact: "bg-subtle text-inksoft",
};

export default function MemoryPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const canChat = useCan("chat.use");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [kind, setKind] = useState<"all" | MemoryKind>("all");
  const [scope, setScope] = useState<"all" | MemoryScope>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filters = {
    q: debouncedQuery || undefined,
    kind: kind === "all" ? undefined : kind,
    scope: scope === "all" ? undefined : scope,
  };
  const memoriesQuery = useQuery({
    queryKey: queryKeys.memories(filters),
    queryFn: () => listMemories(filters),
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.memorySettings,
    queryFn: getMemorySettings,
  });
  const datasourcesQuery = useQuery({
    queryKey: queryKeys.datasources,
    queryFn: listDatasources,
  });

  const datasourceNames = useMemo(
    () => new Map((datasourcesQuery.data?.datasources ?? []).map((item) => [item.id, item.name])),
    [datasourcesQuery.data],
  );

  const saveMutation = useMutation({
    mutationFn: async (input: MemoryInput) => {
      if (editing) {
        return updateMemory(editing.id, {
          title: input.title,
          content: input.content,
          core: input.core,
          confidence: input.confidence,
        });
      }
      return createMemory(input);
    },
    onSuccess: () => {
      setDialogOpen(false);
      setEditing(null);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
      toast.success(editing ? "记忆已更新" : "记忆已添加");
    },
    onError: (error) => setFormError(describeApiError(error, "保存失败")),
  });

  const rowMutation = useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof updateMemory>[1] }) =>
      updateMemory(input.id, input.patch),
    onSuccess: () => {
      setPageError(null);
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
    onError: (error) => setPageError(describeApiError(error, "操作失败，请稍后重试")),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteMemory,
    onSuccess: () => {
      setPageError(null);
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
      toast.success("记忆已删除");
    },
    onError: (error) => {
      setDeleteTarget(null);
      setPageError(describeApiError(error, "删除失败，请稍后重试"));
    },
  });

  const clearMutation = useMutation({
    mutationFn: clearMemories,
    onSuccess: () => {
      setPageError(null);
      setClearOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
      toast.success("已清空全部记忆");
    },
    onError: (error) => {
      setClearOpen(false);
      setPageError(describeApiError(error, "清空失败，请稍后重试"));
    },
  });

  const settingsMutation = useMutation({
    mutationFn: updateMemorySettings,
    onSuccess: () => {
      setPageError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.memorySettings });
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
    onError: (error) => setPageError(describeApiError(error, "记忆开关切换失败，请稍后重试")),
  });

  const memories = memoriesQuery.data?.memories ?? [];
  const hasActiveFilter = Boolean(debouncedQuery || kind !== "all" || scope !== "all");
  const settings = settingsQuery.data;
  const enabled = settings?.enabled ?? true;
  const globalEnabled = settings?.globalEnabled ?? true;

  return (
    <AppShell
      user={meQuery.data?.user ?? { id: "", username: "", displayName: null, role: "user", status: "active" }}
      sidebar={<ConversationSidebar datasources={datasourcesQuery.data?.datasources ?? []} />}
      topbar={
        <div className="flex min-w-0 items-center gap-2">
          <Brain className="h-4 w-4 text-muted" />
          <h1 className="truncate text-sm font-semibold text-ink">我的记忆</h1>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[13px] text-muted">
                记住你的角色、口径和习惯，后续对话会自动参考；不会保存查询结果或密钥。
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {memories.length} 条记忆 · {enabled && globalEnabled ? "已开启" : "已关闭"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1">
                <span className="text-xs text-inksoft">记忆注入</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled && globalEnabled}
                  aria-label="记忆注入"
                  disabled={!globalEnabled || settingsMutation.isPending}
                  onClick={() => settingsMutation.mutate(!enabled)}
                  className={cn(
                    "relative h-5 w-9 rounded-full transition-colors",
                    enabled && globalEnabled ? "bg-brand" : "bg-line",
                    !globalEnabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
                      enabled && globalEnabled ? "left-[18px]" : "left-0.5",
                    )}
                  />
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!canChat || (!hasActiveFilter && memories.length === 0)}
                onClick={() => setClearOpen(true)}
              >
                清空全部
              </Button>
              <Button
                size="sm"
                disabled={!canChat || !globalEnabled}
                onClick={() => {
                  setEditing(null);
                  setFormError(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> 新增记忆
              </Button>
            </div>
          </div>

          {!globalEnabled ? (
            <p className="mt-4 rounded-lg border border-warning/30 bg-warningsoft px-3 py-2 text-[12px] text-warning">
              管理员已全局关闭记忆功能；已有记忆不会被删除，恢复后继续生效。
            </p>
          ) : !enabled ? (
            <p className="mt-4 rounded-lg border border-line bg-subtle px-3 py-2 text-[12px] text-muted">
              记忆已关闭，历史记忆不会删除；重新开启后恢复注入。
            </p>
          ) : null}

          {pageError ? (
            <div
              role="alert"
              className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-danger/20 bg-dangersoft px-3 py-2 text-[12px] text-danger"
            >
              <span>{pageError}</span>
              <button
                type="button"
                aria-label="关闭错误提示"
                className="rounded p-0.5 text-danger/70 hover:bg-danger/10 hover:text-danger"
                onClick={() => setPageError(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={query}
              placeholder="搜索标题或内容"
              className="pl-8"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Select value={kind} onValueChange={(value) => setKind(value as "all" | MemoryKind)}>
            <SelectTrigger className="w-28">
              <Filter className="h-3.5 w-3.5 text-muted" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              {(Object.keys(kindLabels) as MemoryKind[]).map((value) => (
                <SelectItem key={value} value={value}>{kindLabels[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={scope} onValueChange={(value) => setScope(value as "all" | MemoryScope)}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部范围</SelectItem>
              <SelectItem value="global">全局</SelectItem>
              <SelectItem value="datasource">数据源</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {memoriesQuery.isPending ? (
          <p className="py-10 text-center text-sm text-muted">加载中…</p>
        ) : memoriesQuery.isError ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-danger">
            <p>{describeApiError(memoriesQuery.error, "加载记忆失败")}</p>
            <Button variant="outline" size="sm" onClick={() => void memoriesQuery.refetch()}>
              重试
            </Button>
          </div>
        ) : memories.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-line py-14 text-center">
            <Brain className="mx-auto h-7 w-7 text-muted" />
            <p className="mt-3 text-sm font-medium text-ink">
              {debouncedQuery || kind !== "all" || scope !== "all" ? "没有匹配的记忆" : "还没有记忆"}
            </p>
            <p className="mt-1 text-[12px] text-muted">
              你可以在对话里说“记住：金额按万元展示”，或在这里手动添加。
            </p>
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            {memories.map((memory) => {
              const datasourceName = memory.datasourceId
                ? datasourceNames.get(memory.datasourceId) ?? "已删除的数据源"
                : null;
              return (
                <article
                  key={memory.id}
                  className={cn(
                    "rounded-xl border border-line bg-surface p-4 transition-opacity",
                    (!enabled || !globalEnabled || !memory.enabled) && "opacity-60",
                  )}
                >
                  <div className="flex flex-wrap items-start gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", kindTones[memory.kind])}>
                      {kindLabels[memory.kind]}
                    </span>
                    {memory.core ? (
                      <span className="inline-flex items-center gap-0.5 rounded bg-warningsoft px-1.5 py-0.5 text-[10px] text-warning">
                        <Star className="h-2.5 w-2.5 fill-current" /> 核心
                      </span>
                    ) : null}
                    <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                      {datasourceName ?? "全局"}
                    </span>
                    <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                      置信度 {memory.confidence}
                    </span>
                    {!memory.enabled ? (
                      <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">已停用</span>
                    ) : null}
                    <span className="ml-auto text-[10px] text-muted">{formatDateTime(memory.updatedAt)}</span>
                  </div>
                  <h2 className="mt-2 text-sm font-medium text-ink">{memory.title}</h2>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-inksoft">{memory.content}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() =>
                        rowMutation.mutate({ id: memory.id, patch: { enabled: !memory.enabled } })
                      }
                    >
                      {memory.enabled ? "停用" : "启用"}
                    </Button>
                    {(memory.kind === "profile" ||
                      memory.kind === "instruction" ||
                      memory.kind === "preference") ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => rowMutation.mutate({ id: memory.id, patch: { core: !memory.core } })}
                      >
                        <Star className={cn("h-3 w-3", memory.core && "fill-current text-warning")} />
                        {memory.core ? "取消核心" : "设为核心"}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => {
                        setEditing(memory);
                        setFormError(null);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-3 w-3" /> 编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px] text-danger hover:text-danger"
                      onClick={() => setDeleteTarget(memory)}
                    >
                      <Trash2 className="h-3 w-3" /> 删除
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        </div>
      </div>

      <MemoryDialog
        open={dialogOpen}
        memory={editing}
        datasources={datasourcesQuery.data?.datasources ?? []}
        pending={saveMutation.isPending}
        error={formError}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
          setFormError(null);
        }}
        onSubmit={(input) => saveMutation.mutateAsync(input).then(() => undefined)}
      />

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除这条记忆？</DialogTitle>
            <DialogDescription>删除后不再参与后续对话，无法恢复。</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-inksoft">{deleteTarget?.title}</p>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>清空全部记忆？</DialogTitle>
            <DialogDescription>将删除你的所有记忆，此操作无法撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setClearOpen(false)}>取消</Button>
            <Button
              variant="danger"
              size="sm"
              disabled={clearMutation.isPending}
              onClick={() => clearMutation.mutate()}
            >
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
