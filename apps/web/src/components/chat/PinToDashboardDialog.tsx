import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, LayoutDashboard, Loader2, Pin, Plus } from "lucide-react";
import {
  createDashboard,
  listDashboards,
  pinChartToDashboard,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export interface PinToDashboardDialogProps {
  artifactId: string;
  defaultTitle: string;
  onClose: () => void;
}

export function PinToDashboardDialog({
  artifactId,
  defaultTitle,
  onClose,
}: PinToDashboardDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(defaultTitle);
  const [width, setWidth] = useState<1 | 2>(1);
  const [selectedDashboardId, setSelectedDashboardId] = useState<string>("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState("我的数据看板");
  const [pinnedDashboardId, setPinnedDashboardId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const dashboardsQuery = useQuery({
    queryKey: queryKeys.dashboards,
    queryFn: listDashboards,
  });

  const dashboards = useMemo(
    () => dashboardsQuery.data?.dashboards ?? [],
    [dashboardsQuery.data?.dashboards],
  );

  useEffect(() => {
    if (!dashboardsQuery.isSuccess) return;
    if (dashboards.length === 0) {
      setCreatingNew(true);
    } else if (!selectedDashboardId) {
      setSelectedDashboardId(dashboards[0]!.id);
    }
  }, [dashboardsQuery.isSuccess, dashboards, selectedDashboardId]);

  const pinMutation = useMutation({
    mutationFn: async () => {
      let targetId = selectedDashboardId;
      if (creatingNew || !targetId) {
        const name = newDashboardName.trim();
        if (!name) throw new Error("请输入新看板名称");
        const { dashboard } = await createDashboard({ name });
        targetId = dashboard.id;
      }
      await pinChartToDashboard(targetId, {
        artifactId,
        title: title.trim() || defaultTitle,
        width,
      });
      return targetId;
    },
    onSuccess: (targetId) => {
      setPinnedDashboardId(targetId);
      setLocalError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(targetId) });
    },
    onError: (err) => {
      setLocalError(describeApiError(err, err instanceof Error ? err.message : "固定失败"));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pin className="h-4 w-4 text-brand" />
            固定图表到数据看板
          </DialogTitle>
          <DialogDescription>
            固定后可在看板页集中查看，数据库图表支持一键重新查询刷新最新数据。
          </DialogDescription>
        </DialogHeader>

        {pinnedDashboardId ? (
          <div className="space-y-4 px-4 py-4">
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-xs text-ink">
              <Check className="h-4 w-4 shrink-0 text-success" />
              <span>图表已固定到数据看板。</span>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                留在当前页
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onClose();
                  navigate(`/dashboards/${pinnedDashboardId}`);
                }}
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                前往看板查看
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3 px-4 py-3">
            {localError ? (
              <p role="alert" className="rounded-md border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger">
                {localError}
              </p>
            ) : null}

            <div className="space-y-1">
              <label htmlFor="pin-card-title" className="text-xs font-medium text-inksoft">
                卡片标题
              </label>
              <Input
                id="pin-card-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="输入卡片标题"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-inksoft">目标看板</span>
                {dashboards.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setCreatingNew((v) => !v)}
                    className="inline-flex items-center gap-1 text-[11px] text-brandtext hover:underline"
                  >
                    <Plus className="h-3 w-3" />
                    {creatingNew ? "选择已有看板" : "新建看板"}
                  </button>
                ) : null}
              </div>

              {dashboardsQuery.isPending ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  加载看板列表…
                </div>
              ) : creatingNew ? (
                <Input
                  aria-label="新看板名称"
                  value={newDashboardName}
                  maxLength={100}
                  onChange={(e) => setNewDashboardName(e.target.value)}
                  placeholder="输入新看板名称"
                />
              ) : (
                <Select value={selectedDashboardId} onValueChange={setSelectedDashboardId}>
                  <SelectTrigger aria-label="选择目标看板" className="h-9 text-xs">
                    <SelectValue placeholder="选择一个看板" />
                  </SelectTrigger>
                  <SelectContent>
                    {dashboards.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}（{d.cardCount} 张卡片）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-1">
              <span className="text-xs font-medium text-inksoft">卡片宽度</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setWidth(1)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    width === 1
                      ? "border-brand bg-brandsoft text-brandtext font-medium"
                      : "border-line bg-canvas text-inksoft hover:bg-subtle"
                  }`}
                >
                  半宽（双列并排）
                </button>
                <button
                  type="button"
                  onClick={() => setWidth(2)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    width === 2
                      ? "border-brand bg-brandsoft text-brandtext font-medium"
                      : "border-line bg-canvas text-inksoft hover:bg-subtle"
                  }`}
                >
                  通栏（整行宽图）
                </button>
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pinMutation.isPending}>
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  pinMutation.isPending ||
                  dashboardsQuery.isPending ||
                  (creatingNew ? !newDashboardName.trim() : !selectedDashboardId)
                }
                onClick={() => pinMutation.mutate()}
              >
                {pinMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Pin className="h-3.5 w-3.5" />
                )}
                {pinMutation.isPending ? "固定中…" : "确认固定"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
