import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, DatabaseBackup, RefreshCw, Save, ShieldAlert } from "lucide-react";
import { AdminShell } from "../../components/admin/AdminShell";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { PageSpinner } from "../../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import {
  fetchMe,
  getAdminSettings,
  getOpsMetrics,
  getRetentionPreview,
  listOpsBackups,
  runRetention,
  updateAdminSettings,
  type OpsMetrics,
  type RetentionPreview,
  type RetentionRunResult,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { cn, formatDateTime } from "../../lib/utils";

const RANGES = [7, 30, 90] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-ink">{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted">{hint}</div> : null}
    </div>
  );
}

function MetricsSection() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const metricsQuery = useQuery({
    queryKey: queryKeys.opsMetrics(days),
    queryFn: () => getOpsMetrics(days),
  });

  const metrics: OpsMetrics | undefined = metricsQuery.data;
  const maxDaily = Math.max(1, ...(metrics?.daily.map((item) => item.runs) ?? [0]));
  const terminal = metrics
    ? metrics.totals.ok + metrics.totals.error + metrics.totals.aborted
    : 0;

  return (
    <section className="mt-6 rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">运行指标</h2>
          <p className="mt-0.5 text-[11px] text-muted">按运行创建时间统计，token 包含缓存读写。</p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-line p-0.5">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setDays(range)}
              className={cn(
                "rounded px-2.5 py-1 text-xs transition-colors",
                days === range ? "bg-brand text-white" : "text-muted hover:text-ink",
              )}
            >
              {range} 天
            </button>
          ))}
        </div>
      </header>

      <div className="p-4">
        {metricsQuery.isPending ? (
          <div className="py-10 text-center text-sm text-muted">加载指标…</div>
        ) : metricsQuery.isError ? (
          <div className="flex items-center justify-between gap-3 rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
            <span>{describeApiError(metricsQuery.error, "加载指标失败")}</span>
            <Button variant="ghost" size="sm" onClick={() => void metricsQuery.refetch()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              重试
            </Button>
          </div>
        ) : metrics ? (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Card
                label="总运行"
                value={formatNumber(metrics.totals.runs)}
                hint={`活跃用户 ${metrics.totals.activeUsers}`}
              />
              <Card
                label="成功率"
                value={terminal === 0 ? "—" : `${(metrics.totals.successRate * 100).toFixed(1)}%`}
                hint={`${metrics.totals.ok} 成功 / ${metrics.totals.error} 失败 / ${metrics.totals.aborted} 中止`}
              />
              <Card
                label="P95 耗时"
                value={`${(metrics.totals.p95Ms / 1000).toFixed(1)}s`}
                hint={`P50 ${(metrics.totals.p50Ms / 1000).toFixed(1)}s`}
              />
              <Card
                label="Token"
                value={formatNumber(metrics.totals.inputTokens + metrics.totals.outputTokens)}
                hint={`输入 ${formatNumber(metrics.totals.inputTokens)} / 输出 ${formatNumber(metrics.totals.outputTokens)}`}
              />
            </div>

            <div className="mt-4">
              <div className="mb-2 text-[11px] font-medium text-muted">每日运行</div>
              <div className="flex h-24 items-end gap-1">
                {metrics.daily.map((day) => (
                  <div
                    key={day.date}
                    className="group flex flex-1 flex-col items-center justify-end gap-1"
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          tabIndex={0}
                          className="w-full min-w-[2px] rounded-t bg-brand/70 transition-colors group-hover:bg-brand"
                          style={{ height: `${Math.max(2, (day.runs / maxDaily) * 76)}px` }}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {`${day.date}: ${day.runs} 次，失败 ${day.error + day.aborted}`}
                      </TooltipContent>
                    </Tooltip>
                    <span className="hidden text-[9px] text-muted sm:block">{day.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-2 text-[11px] font-medium text-muted">Top 数据源</div>
                {metrics.datasources.length === 0 ? (
                  <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-muted">
                    暂无运行数据
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="text-[10px] text-muted">
                      <tr>
                        <th className="pb-1 font-medium">数据源</th>
                        <th className="pb-1 text-right font-medium">运行</th>
                        <th className="pb-1 text-right font-medium">失败</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.datasources.map((item) => (
                        <tr key={item.datasourceId} className="border-t border-line/60">
                          <td className="py-1.5 text-ink">{item.name}</td>
                          <td className="py-1.5 text-right tabular-nums text-inksoft">{item.runs}</td>
                          <td className="py-1.5 text-right tabular-nums text-inksoft">{item.failed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <div className="mb-2 text-[11px] font-medium text-muted">查询审计</div>
                <div className="rounded-md border border-line px-3 py-2 text-xs text-inksoft">
                  <div className="flex justify-between py-0.5">
                    <span>查询总数</span>
                    <span className="tabular-nums">{metrics.queries.total}</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span>被拒绝</span>
                    <span className="tabular-nums">{metrics.queries.rejected}</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span>执行错误</span>
                    <span className="tabular-nums">{metrics.queries.error}</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span>超时</span>
                    <span className="tabular-nums">{metrics.queries.timeout}</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span>平均行数</span>
                    <span className="tabular-nums">
                      {metrics.queries.averageRows === null
                        ? "—"
                        : metrics.queries.averageRows.toFixed(0)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function RetentionSection() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: queryKeys.adminSettings, queryFn: getAdminSettings });
  const [conversationDays, setConversationDays] = useState<string | null>(null);
  const [auditDays, setAuditDays] = useState<string | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [result, setResult] = useState<RetentionRunResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const saveMutation = useMutation({
    mutationFn: () =>
      updateAdminSettings({
        retentionConversationDays: Number(
          conversationDays ?? settingsQuery.data?.settings.retentionConversationDays ?? 0,
        ),
        retentionAuditDays: Number(
          auditDays ?? settingsQuery.data?.settings.retentionAuditDays ?? 0,
        ),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.adminSettings, data);
      setConversationDays(String(data.settings.retentionConversationDays));
      setAuditDays(String(data.settings.retentionAuditDays));
      setPreview(null);
    },
  });

  const previewMutation = useMutation({
    mutationFn: getRetentionPreview,
    onSuccess: setPreview,
  });

  const runMutation = useMutation({
    mutationFn: runRetention,
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.opsRetention });
      void queryClient.invalidateQueries({ queryKey: queryKeys.opsMetrics(7) });
    },
  });

  const settings = settingsQuery.data?.settings;
  const conversationValue = conversationDays ?? String(settings?.retentionConversationDays ?? 0);
  const auditValue = auditDays ?? String(settings?.retentionAuditDays ?? 0);
  const disabled = saveMutation.isPending || previewMutation.isPending || runMutation.isPending;

  return (
    <section className="mt-6 rounded-xl border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">数据保留</h2>
          <p className="mt-0.5 text-[11px] text-muted">
            0 表示关闭；清理不可撤销，活跃分享与运行中的会话会跳过。
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => saveMutation.mutate()}>
          <Save className="mr-1 h-3.5 w-3.5" />
          保存设置
        </Button>
      </header>
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          会话保留天数
          <Input
            type="number"
            min={0}
            max={3650}
            value={conversationValue}
            disabled={settingsQuery.isPending}
            onChange={(event) => setConversationDays(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          审计日志保留天数
          <Input
            type="number"
            min={0}
            max={3650}
            value={auditValue}
            disabled={settingsQuery.isPending}
            onChange={(event) => setAuditDays(event.target.value)}
          />
        </label>
      </div>

      {saveMutation.isError ? (
        <div className="mx-4 mb-3 rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
          {describeApiError(saveMutation.error, "保存失败")}
        </div>
      ) : null}
      {previewMutation.isError ? (
        <div className="mx-4 mb-3 rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
          {describeApiError(previewMutation.error, "预览失败")}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => previewMutation.mutate()}
        >
          预览影响
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={disabled || preview === null}
          onClick={() => setConfirmOpen(true)}
        >
          <ShieldAlert className="mr-1 h-3.5 w-3.5" />
          执行清理
        </Button>
        {result ? (
          <span className="text-[11px] text-muted">
            上次清理：删除 {result.deletedConversations} 个会话、{result.deletedArtifacts} 个
            artifact、{result.deletedAuditRows} 条审计，跳过{" "}
            {result.skippedActiveShares + result.skippedBusy} 个
          </span>
        ) : null}
      </div>

      {preview ? (
        <div className="border-t border-line px-4 py-3 text-xs text-inksoft">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div>到期会话：{preview.conversations.eligible}</div>
            <div>将删除：{preview.conversations.willDelete}</div>
            <div>活跃分享跳过：{preview.conversations.skippedActiveShares}</div>
            <div>运行中跳过：{preview.conversations.skippedBusy}</div>
            <div>Run：{preview.conversations.runs}</div>
            <div>事件：{preview.conversations.events}</div>
            <div>
              Artifact：{preview.conversations.artifacts}（
              {formatBytes(preview.conversations.artifactBytes)}）
            </div>
            <div>审计行：{preview.auditRows}</div>
          </div>
        </div>
      ) : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认执行清理？</DialogTitle>
            <DialogDescription>
              将永久删除 {preview?.conversations.willDelete ?? 0} 个会话及其 run、artifact、报告与分享，并删除{" "}
              {preview?.auditRows ?? 0} 条审计日志。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={runMutation.isPending}
              onClick={() => runMutation.mutate()}
            >
              {runMutation.isPending ? "清理中…" : "确认清理"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function BackupSection() {
  const backupsQuery = useQuery({ queryKey: queryKeys.opsBackups, queryFn: listOpsBackups });
  return (
    <section className="mt-6 rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">备份</h2>
        <p className="mt-0.5 text-[11px] text-muted">
          备份包含 SQLite、artifact、Pi 会话、技能与 agent 配置，不包含 .env。恢复前请停止服务。
        </p>
      </header>
      <div className="space-y-2 p-4 text-xs">
        <div className="rounded-md bg-subtle px-3 py-2 font-mono text-[11px] text-inksoft">
          pnpm ops:backup
        </div>
        <div className="rounded-md bg-subtle px-3 py-2 font-mono text-[11px] text-inksoft">
          pnpm ops:restore --from data/backups/&lt;name&gt; --yes
        </div>
        {backupsQuery.isPending ? (
          <div className="py-4 text-center text-muted">加载备份列表…</div>
        ) : backupsQuery.isError ? (
          <div className="text-danger">
            {describeApiError(backupsQuery.error, "加载备份列表失败")}
          </div>
        ) : backupsQuery.data.length === 0 ? (
          <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-muted">
            还没有备份
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="text-[10px] text-muted">
              <tr>
                <th className="pb-1 font-medium">名称</th>
                <th className="pb-1 font-medium">时间</th>
                <th className="pb-1 text-right font-medium">文件</th>
                <th className="pb-1 text-right font-medium">大小</th>
              </tr>
            </thead>
            <tbody>
              {backupsQuery.data.map((backup) => (
                <tr key={backup.name} className="border-t border-line/60">
                  <td className="py-1.5 font-mono text-[11px] text-ink">{backup.name}</td>
                  <td className="py-1.5 text-muted">{formatDateTime(backup.createdAt)}</td>
                  <td className="py-1.5 text-right tabular-nums text-inksoft">{backup.files}</td>
                  <td className="py-1.5 text-right tabular-nums text-inksoft">
                    {formatBytes(backup.bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default function OpsPage() {
  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  return (
    <AdminShell user={user}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-6">
          <header className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-brand" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink">运维</h1>
              <p className="mt-0.5 text-sm text-muted">运行指标、数据保留与备份。</p>
            </div>
          </header>
          <MetricsSection />
          <RetentionSection />
          <BackupSection />
          <p className="mt-4 flex items-center gap-1 text-[11px] text-muted">
            <DatabaseBackup className="h-3.5 w-3.5" />
            备份/恢复是命令行操作，不在浏览器内直接下载数据。
          </p>
        </div>
      </div>
    </AdminShell>
  );
}
