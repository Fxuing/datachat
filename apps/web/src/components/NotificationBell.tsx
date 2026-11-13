import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from "../lib/api";
import { queryKeys } from "../lib/query";
import { cn, formatDateTime } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const typeLabels: Record<string, string> = {
  task_success: "定时任务成功",
  task_failed: "定时任务失败",
  task_disabled: "定时任务已停用",
};

export function NotificationBell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const notificationsQuery = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => listNotifications(),
    refetchInterval: 30_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications });

  const readMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: invalidate,
  });
  const readAllMutation = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: invalidate,
  });

  const notifications: NotificationItem[] = notificationsQuery.data?.notifications ?? [];
  const unread = notificationsQuery.data?.unread ?? 0;

  const openNotification = (item: NotificationItem) => {
    if (!item.readAt) readMutation.mutate(item.id);
    setOpen(false);
    if (item.href) navigate(item.href);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="通知">
          <Bell className="h-4 w-4" />
          {unread > 0 ? (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold text-canvas">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[12px] font-semibold text-ink">通知</span>
          <button
            type="button"
            className="text-[11px] text-brand hover:underline disabled:text-muted"
            disabled={unread === 0 || readAllMutation.isPending}
            onClick={() => readAllMutation.mutate()}
          >
            全部已读
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {notificationsQuery.isPending ? (
            <p className="px-3 py-6 text-center text-[12px] text-muted">加载中…</p>
          ) : notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-muted">还没有通知</p>
          ) : (
            notifications.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "block w-full border-b border-line/60 px-3 py-2.5 text-left last:border-0 hover:bg-subtle",
                  !item.readAt && "bg-brandsoft/40",
                )}
                onClick={() => openNotification(item)}
              >
                <span className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                      item.readAt ? "bg-transparent" : "bg-brand",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-ink">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-muted">
                      {item.body}
                    </span>
                    <span className="mt-1 block text-[10px] text-muted">
                      {typeLabels[item.type] ?? item.type} · {formatDateTime(item.createdAt)}
                    </span>
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
