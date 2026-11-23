import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Clock,
  Code2,
  Columns2,
  Database,
  ExternalLink,
  LayoutDashboard,
  Maximize2,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";
import { AppShell } from "../components/AppShell";
import { ShareDialog } from "../components/ShareDialog";
import { ConfirmDialog } from "../components/admin/ConfirmDialog";
import { ChartCard, chartOptionFromSpec } from "../components/chat/ChartCard";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { PageSpinner } from "../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { useCan } from "../hooks/use-access";
import {
  createDashboard,
  deleteDashboard,
  deleteDashboardCard,
  fetchMe,
  getDashboard,
  listDashboards,
  refreshAllDashboardCards,
  refreshDashboardCard,
  reorderDashboardCards,
  updateDashboard,
  updateDashboardCard,
  type DashboardCard,
  type DashboardDetail,
  type DashboardSummary,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { queryKeys } from "../lib/query";
import { cn } from "../lib/utils";

function formatTime(ts: number | null): string {
  if (!ts) return "未刷新";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function DashboardMetaDialog({
  dashboard,
  saving,
  error,
  onSave,
  onClose,
}: {
  dashboard: DashboardSummary | null;
  saving: boolean;
  error: string | null;
  onSave: (input: { name: string; description: string | null }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(dashboard?.name ?? "");
  const [description, setDescription] = useState(dashboard?.description ?? "");

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{dashboard ? "编辑看板" : "新建数据看板"}</DialogTitle>
          <DialogDescription>
            将对话中验证好的核心图表固定到看板，随时一键刷新查看最新业务指标。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            onSave({ name: name.trim(), description: description.trim() || null });
          }}
        >
          {error ? (
            <p role="alert" className="rounded-md border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="space-y-1">
            <label htmlFor="dashboard-name" className="text-xs font-medium text-inksoft">
              看板名称 *
            </label>
            <Input
              id="dashboard-name"
              value={name}
              maxLength={100}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：经营日看板"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="dashboard-desc" className="text-xs font-medium text-inksoft">
              说明（可选）
            </label>
            <Input
              id="dashboard-desc"
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="记录看板用途或关注指标"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SCHEDULE_PRESETS = [
  { label: "关闭", cron: "" },
  { label: "每小时", cron: "0 * * * *" },
  { label: "每 6 小时", cron: "0 */6 * * *" },
  { label: "每天 08:00", cron: "0 8 * * *" },
  { label: "工作日 09:00", cron: "0 9 * * 1-5" },
];

function DashboardScheduleDialog({
  dashboard,
  saving,
  error,
  onSave,
  onClose,
}: {
  dashboard: DashboardDetail;
  saving: boolean;
  error: string | null;
  onSave: (input: { refreshCron: string | null; refreshTimezone: string }) => void;
  onClose: () => void;
}) {
  const [cron, setCron] = useState(dashboard.refreshCron ?? "");
  const [timezone, setTimezone] = useState(dashboard.refreshTimezone || "Asia/Shanghai");

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>定时自动刷新</DialogTitle>
          <DialogDescription>
            按计划自动重新查询看板中的可刷新卡片（以当前所有者的最新权限和数据范围执行）。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave({
              refreshCron: cron.trim() ? cron.trim() : null,
              refreshTimezone: timezone.trim() || "Asia/Shanghai",
            });
          }}
        >
          <div className="space-y-4 px-5 py-4">
            {error ? (
              <p
                role="alert"
                className="rounded-md border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger"
              >
                {error}
              </p>
            ) : null}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-inksoft">快捷预设</span>
              <div className="flex flex-wrap gap-1.5">
                {SCHEDULE_PRESETS.map((preset) => {
                  const active = cron.trim() === preset.cron;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setCron(preset.cron)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-xs transition-colors",
                        active
                          ? "border-brand bg-brandsoft font-medium text-brandtext"
                          : "border-line bg-surface text-inksoft hover:bg-subtle",
                      )}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="dashboard-refresh-cron" className="text-xs font-medium text-inksoft">
                Cron 表达式（5 段，留空即关闭）
              </label>
              <Input
                id="dashboard-refresh-cron"
                value={cron}
                maxLength={100}
                onChange={(e) => setCron(e.target.value)}
                placeholder="例如：0 8 * * *（每天 08:00，最小间隔 5 分钟）"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="dashboard-refresh-tz" className="text-xs font-medium text-inksoft">
                时区（IANA）
              </label>
              <Input
                id="dashboard-refresh-tz"
                value={timezone}
                maxLength={64}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Shanghai"
                className="font-mono text-xs"
              />
            </div>
            {dashboard.nextRefreshAt ? (
              <p className="text-[11px] text-muted">
                当前下次计划刷新：{formatTime(dashboard.nextRefreshAt)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "保存中…" : "保存计划"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CardSqlDialog({
  card,
  saving,
  error,
  onSave,
  onClose,
}: {
  card: DashboardCard;
  saving: boolean;
  error: string | null;
  onSave: (sqlText: string, refreshAfter: boolean) => void;
  onClose: () => void;
}) {
  const [sqlDraft, setSqlDraft] = useState(card.sqlText ?? "");

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>查看 / 编辑卡片 SQL</DialogTitle>
          <DialogDescription>
            卡片「{card.title}」的只读查询语句。保存时会经过 SQL 安全守卫校验；如果修改了返回列名，请确保与原图表维度/指标字段匹配。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 py-4">
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          ) : null}
          <div className="space-y-1">
            <label htmlFor="dashboard-card-sql" className="text-xs font-medium text-inksoft">
              SQL 语句（仅允许只读 SELECT / WITH 查询）
            </label>
            <Textarea
              id="dashboard-card-sql"
              rows={10}
              value={sqlDraft}
              onChange={(e) => setSqlDraft(e.target.value)}
              className="font-mono text-xs leading-5"
              placeholder="SELECT ..."
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || !sqlDraft.trim()}
            onClick={() => onSave(sqlDraft.trim(), false)}
          >
            仅保存
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || !sqlDraft.trim()}
            onClick={() => onSave(sqlDraft.trim(), true)}
          >
            {saving ? "处理中…" : "保存并刷新"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DashboardsPage() {
  const { dashboardId } = useParams<{ dashboardId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canShare = useCan("share.create");

  const [metaModal, setMetaModal] = useState<{ mode: "new" | "edit"; item: DashboardSummary | null } | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [sqlCard, setSqlCard] = useState<DashboardCard | null>(null);
  const [deletingDashboard, setDeletingDashboard] = useState<DashboardSummary | null>(null);
  const [deletingCard, setDeletingCard] = useState<DashboardCard | null>(null);
  const [renamingCard, setRenamingCard] = useState<DashboardCard | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [refreshingCardId, setRefreshingCardId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const listQuery = useQuery({ queryKey: queryKeys.dashboards, queryFn: listDashboards });

  const dashboards = useMemo(
    () => listQuery.data?.dashboards ?? [],
    [listQuery.data?.dashboards],
  );
  const activeId = dashboardId ?? dashboards[0]?.id ?? null;

  useEffect(() => {
    if (!dashboardId && dashboards.length > 0) {
      navigate(`/dashboards/${dashboards[0]!.id}`, { replace: true });
    }
  }, [dashboardId, dashboards, navigate]);

  const detailQuery = useQuery({
    queryKey: queryKeys.dashboard(activeId ?? ""),
    queryFn: () => getDashboard(activeId as string),
    enabled: Boolean(activeId),
    retry: false,
  });

  const activeDashboard = detailQuery.data?.dashboard ?? null;

  const saveMetaMutation = useMutation({
    mutationFn: (vars: { id: string | null; name: string; description: string | null }) =>
      vars.id
        ? updateDashboard(vars.id, { name: vars.name, description: vars.description })
        : createDashboard({ name: vars.name, description: vars.description }),
    onSuccess: (res, vars) => {
      setMetaModal(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards });
      if (vars.id) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(vars.id) });
      } else {
        navigate(`/dashboards/${res.dashboard.id}`);
      }
    },
  });

  const deleteDashboardMutation = useMutation({
    mutationFn: (id: string) => deleteDashboard(id),
    onSuccess: (_data, id) => {
      setDeletingDashboard(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards });
      queryClient.removeQueries({ queryKey: queryKeys.dashboard(id) });
      navigate("/dashboards", { replace: true });
    },
  });

  const saveScheduleMutation = useMutation({
    mutationFn: (input: { refreshCron: string | null; refreshTimezone: string }) =>
      updateDashboard(activeId as string, input),
    onSuccess: (res) => {
      setScheduleOpen(false);
      queryClient.setQueryData<{ dashboard: DashboardDetail }>(
        queryKeys.dashboard(res.dashboard.id),
        res,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards });
      setBanner({
        tone: "info",
        text: res.dashboard.refreshCron
          ? `已启用定时刷新（${res.dashboard.refreshCron}），下次刷新：${formatTime(res.dashboard.nextRefreshAt ?? null)}`
          : "已关闭定时自动刷新。",
      });
    },
  });

  const saveCardSqlMutation = useMutation({
    mutationFn: async (vars: { cardId: string; sqlText: string; refreshAfter: boolean }) => {
      const updated = await updateDashboardCard(activeId as string, vars.cardId, {
        sqlText: vars.sqlText,
      });
      if (vars.refreshAfter) {
        return refreshDashboardCard(activeId as string, vars.cardId);
      }
      return updated;
    },
    onSuccess: ({ card }, vars) => {
      setSqlCard(null);
      queryClient.setQueryData<{ dashboard: DashboardDetail }>(
        queryKeys.dashboard(activeId as string),
        (prev) =>
          prev
            ? {
                dashboard: {
                  ...prev.dashboard,
                  cards: prev.dashboard.cards.map((c) => (c.id === card.id ? card : c)),
                },
              }
            : prev,
      );
      setBanner({
        tone: "info",
        text: vars.refreshAfter ? "SQL 已保存并重新刷新图表数据。" : "卡片 SQL 已保存。",
      });
    },
  });

  const updateCardMutation = useMutation({
    mutationFn: (vars: { cardId: string; patch: { title?: string; width?: 1 | 2 } }) =>
      updateDashboardCard(activeId as string, vars.cardId, vars.patch),
    onSuccess: ({ card }) => {
      setRenamingCard(null);
      queryClient.setQueryData<{ dashboard: DashboardDetail }>(
        queryKeys.dashboard(activeId as string),
        (prev) =>
          prev
            ? {
                dashboard: {
                  ...prev.dashboard,
                  cards: prev.dashboard.cards.map((c) => (c.id === card.id ? card : c)),
                },
              }
            : prev,
      );
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (cardIds: string[]) => reorderDashboardCards(activeId as string, cardIds),
    onSuccess: ({ cards }) => {
      queryClient.setQueryData<{ dashboard: DashboardDetail }>(
        queryKeys.dashboard(activeId as string),
        (prev) => (prev ? { dashboard: { ...prev.dashboard, cards } } : prev),
      );
    },
  });

  const deleteCardMutation = useMutation({
    mutationFn: (cardId: string) => deleteDashboardCard(activeId as string, cardId),
    onSuccess: () => {
      setDeletingCard(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(activeId as string) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards });
    },
  });

  const refreshCardMutation = useMutation({
    mutationFn: (cardId: string) => refreshDashboardCard(activeId as string, cardId),
    onMutate: (cardId) => {
      setRefreshingCardId(cardId);
      setBanner(null);
    },
    onSuccess: ({ card }) => {
      queryClient.setQueryData<{ dashboard: DashboardDetail }>(
        queryKeys.dashboard(activeId as string),
        (prev) =>
          prev
            ? {
                dashboard: {
                  ...prev.dashboard,
                  cards: prev.dashboard.cards.map((c) => (c.id === card.id ? card : c)),
                },
              }
            : prev,
      );
    },
    onError: (err) => {
      setBanner({ tone: "error", text: describeApiError(err, "刷新卡片失败") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(activeId as string) });
    },
    onSettled: () => setRefreshingCardId(null),
  });

  const refreshAllMutation = useMutation({
    mutationFn: () => refreshAllDashboardCards(activeId as string),
    onMutate: () => setBanner(null),
    onSuccess: (res) => {
      queryClient.setQueryData<{ dashboard: DashboardDetail }>(
        queryKeys.dashboard(activeId as string),
        (prev) => (prev ? { dashboard: { ...prev.dashboard, cards: res.cards } } : prev),
      );
      setBanner({
        tone: res.failed > 0 ? "error" : "info",
        text: `刷新完成：成功 ${res.refreshed} 张${res.failed > 0 ? `，失败 ${res.failed} 张` : ""}${
          res.skipped > 0 ? `，跳过静态快照 ${res.skipped} 张` : ""
        }。`,
      });
    },
    onError: (err) => {
      setBanner({ tone: "error", text: describeApiError(err, "批量刷新失败") });
    },
  });

  const moveCard = (index: number, delta: -1 | 1) => {
    if (!activeDashboard) return;
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= activeDashboard.cards.length) return;
    const ids = activeDashboard.cards.map((c) => c.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(nextIndex, 0, moved!);
    reorderMutation.mutate(ids);
  };

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const topbar = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <LayoutDashboard className="h-4 w-4 shrink-0 text-brand" />
        <span className="truncate text-sm font-medium text-ink">
          {activeDashboard ? activeDashboard.name : "数据看板"}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {activeDashboard ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshAllMutation.isPending || activeDashboard.cards.length === 0}
              onClick={() => refreshAllMutation.mutate()}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshAllMutation.isPending && "animate-spin")} />
              {refreshAllMutation.isPending ? "刷新中…" : "全部刷新"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                activeDashboard.refreshCron && "border-brand/40 bg-brandsoft/60 text-brandtext",
              )}
              onClick={() => {
                saveScheduleMutation.reset();
                setScheduleOpen(true);
              }}
            >
              <Clock className="h-3.5 w-3.5" />
              {activeDashboard.refreshCron ? "已定时" : "定时刷新"}
            </Button>
            {canShare ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShareOpen(true)}
              >
                <Share2 className="h-3.5 w-3.5" />
                分享
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                saveMetaMutation.reset();
                setMetaModal({ mode: "edit", item: activeDashboard });
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-danger hover:bg-dangersoft hover:text-danger"
              onClick={() => setDeletingDashboard(activeDashboard)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          onClick={() => {
            saveMetaMutation.reset();
            setMetaModal({ mode: "new", item: null });
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          新建看板
        </Button>
      </div>
    </>
  );

  return (
    <AppShell user={user} sidebar={<ConversationSidebar />} topbar={topbar}>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-6xl space-y-4">
          {dashboards.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
              {dashboards.map((item) => {
                const selected = item.id === activeId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(`/dashboards/${item.id}`)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                      selected
                        ? "border-brand bg-brandsoft font-medium text-brandtext"
                        : "border-line bg-surface text-inksoft hover:bg-subtle",
                    )}
                  >
                    <span>{item.name}</span>
                    <span className="text-[10px] opacity-75">{item.cardCount}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {banner ? (
            <div
              role="alert"
              className={cn(
                "rounded-lg border px-3 py-2 text-xs",
                banner.tone === "error"
                  ? "border-danger/25 bg-dangersoft text-danger"
                  : "border-line bg-subtle text-inksoft",
              )}
            >
              {banner.text}
            </div>
          ) : null}

          {listQuery.isPending ? (
            <PageSpinner label="加载数据看板…" />
          ) : dashboards.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line bg-surface px-6 py-16 text-center">
              <LayoutDashboard className="h-10 w-10 text-muted/60" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-ink">还没有数据看板</p>
                <p className="max-w-md text-xs text-muted">
                  你可以先创建一个看板，或者在任意对话生成的图表卡片右上角点击「固定」，把常用指标图表沉淀到这里随时刷新看数。
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  saveMetaMutation.reset();
                  setMetaModal({ mode: "new", item: null });
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                新建第一个看板
              </Button>
            </div>
          ) : detailQuery.isPending ? (
            <PageSpinner label="加载看板卡片…" />
          ) : detailQuery.isError || !activeDashboard ? (
            <div className="rounded-lg border border-danger/25 bg-dangersoft p-4 text-xs text-danger">
              看板加载失败或已被删除。
            </div>
          ) : (
            <>
              {activeDashboard.description || activeDashboard.refreshCron ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  {activeDashboard.description ? <p>{activeDashboard.description}</p> : <span />}
                  {activeDashboard.refreshCron ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-subtle px-2.5 py-1 text-[11px] text-inksoft">
                      <Clock className="h-3 w-3 text-brand" />
                      <span>
                        定时刷新：<code className="font-mono">{activeDashboard.refreshCron}</code>
                        （{activeDashboard.refreshTimezone || "Asia/Shanghai"}）
                      </span>
                      {activeDashboard.nextRefreshAt ? (
                        <span>· 下次：{formatTime(activeDashboard.nextRefreshAt)}</span>
                      ) : null}
                      {activeDashboard.lastAutoRefreshError ? (
                        <span className="text-danger">
                          · 上次自动刷新失败：{activeDashboard.lastAutoRefreshError}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {activeDashboard.cards.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface px-6 py-14 text-center">
                  <p className="text-sm font-medium text-ink">这个看板还没有图表卡片</p>
                  <p className="max-w-md text-xs text-muted">
                    前往对话页生成图表后，点击图表右上角的「固定」按钮即可添加到「{activeDashboard.name}」。
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-1"
                    onClick={() => navigate("/chat")}
                  >
                    去对话探索数据
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {activeDashboard.cards.map((card, index) => {
                    const isRefreshing = refreshingCardId === card.id || refreshAllMutation.isPending;
                    return (
                      <div
                        key={card.id}
                        className={cn(
                          "flex flex-col gap-1.5",
                          card.width === 2 && "lg:col-span-2",
                        )}
                      >
                        <ChartCard
                          title={card.title}
                          option={chartOptionFromSpec(card.spec)}
                          points={card.points}
                        />
                        {card.lastError ? (
                          <div
                            role="alert"
                            className="flex items-start gap-1.5 rounded-md border border-danger/25 bg-dangersoft px-2.5 py-1.5 text-[11px] text-danger"
                          >
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>上次刷新失败：{card.lastError}</span>
                          </div>
                        ) : null}
                        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1">
                              <Database className="h-3 w-3" />
                              {card.datasourceName ?? (card.refreshable ? "数据源" : "静态快照")}
                            </span>
                            <span>· 更新：{formatTime(card.lastRefreshedAt)}</span>
                            {card.sourceConversationId ? (
                              <Link
                                to={`/chat/${card.sourceConversationId}`}
                                className="inline-flex items-center gap-0.5 text-brandtext hover:underline"
                              >
                                来源对话
                                <ExternalLink className="h-2.5 w-2.5" />
                              </Link>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-0.5">
                            {card.refreshable ? (
                              <>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      aria-label={`刷新 ${card.title}`}
                                      disabled={isRefreshing}
                                      onClick={() => refreshCardMutation.mutate(card.id)}
                                    >
                                      <RefreshCw className={cn("h-3 w-3", isRefreshing && "animate-spin")} />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">重新查询并刷新数据</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      aria-label={`查看或编辑 ${card.title} SQL`}
                                      onClick={() => {
                                        saveCardSqlMutation.reset();
                                        setSqlCard(card);
                                      }}
                                    >
                                      <Code2 className="h-3 w-3" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">查看 / 编辑 SQL</TooltipContent>
                                </Tooltip>
                              </>
                            ) : null}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  aria-label={card.width === 2 ? "切换为半宽" : "切换为通栏"}
                                  onClick={() =>
                                    updateCardMutation.mutate({
                                      cardId: card.id,
                                      patch: { width: card.width === 2 ? 1 : 2 },
                                    })
                                  }
                                >
                                  {card.width === 2 ? (
                                    <Columns2 className="h-3 w-3" />
                                  ) : (
                                    <Maximize2 className="h-3 w-3" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                {card.width === 2 ? "切换为半宽" : "切换为通栏"}
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  aria-label="前移卡片"
                                  disabled={index === 0 || reorderMutation.isPending}
                                  onClick={() => moveCard(index, -1)}
                                >
                                  <ArrowLeft className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">前移</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  aria-label="后移卡片"
                                  disabled={
                                    index === activeDashboard.cards.length - 1 ||
                                    reorderMutation.isPending
                                  }
                                  onClick={() => moveCard(index, 1)}
                                >
                                  <ArrowRight className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">后移</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  aria-label={`重命名 ${card.title}`}
                                  onClick={() => {
                                    setRenamingCard(card);
                                    setRenameDraft(card.title);
                                  }}
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">重命名</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-danger hover:bg-dangersoft hover:text-danger"
                                  aria-label={`移除 ${card.title}`}
                                  onClick={() => setDeletingCard(card)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">移除卡片</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {metaModal ? (
        <DashboardMetaDialog
          dashboard={metaModal.item}
          saving={saveMetaMutation.isPending}
          error={
            saveMetaMutation.error
              ? describeApiError(saveMetaMutation.error, "保存看板失败")
              : null
          }
          onSave={(input) =>
            saveMetaMutation.mutate({ id: metaModal.item?.id ?? null, ...input })
          }
          onClose={() => setMetaModal(null)}
        />
      ) : null}

      {renamingCard ? (
        <Dialog open onOpenChange={(open) => (!open ? setRenamingCard(null) : undefined)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>重命名卡片</DialogTitle>
              <DialogDescription>修改看板中展示的图表标题。</DialogDescription>
            </DialogHeader>
            <form
              className="space-y-3 px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!renameDraft.trim()) return;
                updateCardMutation.mutate({
                  cardId: renamingCard.id,
                  patch: { title: renameDraft.trim() },
                });
              }}
            >
              <Input
                aria-label="新卡片标题"
                value={renameDraft}
                maxLength={200}
                autoFocus
                onChange={(e) => setRenameDraft(e.target.value)}
              />
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={() => setRenamingCard(null)}>
                  取消
                </Button>
                <Button type="submit" size="sm" disabled={!renameDraft.trim() || updateCardMutation.isPending}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {scheduleOpen && activeDashboard ? (
        <DashboardScheduleDialog
          dashboard={activeDashboard}
          saving={saveScheduleMutation.isPending}
          error={
            saveScheduleMutation.error
              ? describeApiError(saveScheduleMutation.error, "保存定时刷新配置失败")
              : null
          }
          onSave={(input) => saveScheduleMutation.mutate(input)}
          onClose={() => setScheduleOpen(false)}
        />
      ) : null}

      {canShare && shareOpen && activeDashboard ? (
        <ShareDialog
          target={{
            dashboardId: activeDashboard.id,
            label: activeDashboard.name,
          }}
          onClose={() => setShareOpen(false)}
        />
      ) : null}

      {sqlCard ? (
        <CardSqlDialog
          card={sqlCard}
          saving={saveCardSqlMutation.isPending}
          error={
            saveCardSqlMutation.error
              ? describeApiError(saveCardSqlMutation.error, "保存 SQL 失败")
              : null
          }
          onSave={(sqlText, refreshAfter) =>
            saveCardSqlMutation.mutate({ cardId: sqlCard.id, sqlText, refreshAfter })
          }
          onClose={() => setSqlCard(null)}
        />
      ) : null}

      {deletingDashboard ? (
        <ConfirmDialog
          title="删除看板"
          description={`确定删除看板「${deletingDashboard.name}」及其所有卡片吗？不影响原始对话和报告。`}
          confirmLabel="删除"
          variant="danger"
          pending={deleteDashboardMutation.isPending}
          onConfirm={() => deleteDashboardMutation.mutate(deletingDashboard.id)}
          onCancel={() => setDeletingDashboard(null)}
        />
      ) : null}

      {deletingCard ? (
        <ConfirmDialog
          title="移除看板卡片"
          description={`确定从看板中移除「${deletingCard.title}」吗？`}
          confirmLabel="移除"
          variant="danger"
          pending={deleteCardMutation.isPending}
          onConfirm={() => deleteCardMutation.mutate(deletingCard.id)}
          onCancel={() => setDeletingCard(null)}
        />
      ) : null}
    </AppShell>
  );
}
