import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  BookOpen,
  Clock,
  Database,
  LogOut,
  Plug,
  ScrollText,
  Settings,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react";
import { logout, type SessionUser } from "../lib/api";
import { cn } from "../lib/utils";
import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { NotificationBell } from "./NotificationBell";

export interface AppShellProps {
  user: SessionUser;
  sidebar: ReactNode;
  topbar?: ReactNode;
  children: ReactNode;
}

const adminLinks: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/admin/users", label: "用户", icon: Users },
  { to: "/admin/roles", label: "角色", icon: Shield },
  { to: "/admin/datasources", label: "数据源", icon: Database },
  { to: "/admin/skills", label: "技能管理", icon: BookOpen },
  { to: "/admin/mcp", label: "MCP 服务器", icon: Plug },
  { to: "/admin/audit", label: "审计日志", icon: ScrollText },
  { to: "/admin/settings", label: "设置", icon: Settings },
  { to: "/admin/ops", label: "运维", icon: Activity },
];

export function AppShell({ user, sidebar, topbar, children }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear();
      navigate("/login", { replace: true });
    },
  });

  const initial = (user.displayName ?? user.username).slice(0, 1).toUpperCase();

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface print:hidden">
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <BrandMark size={34} />
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold leading-tight tracking-tight text-ink">
              DataChat
            </span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
              数据工作台
            </span>
          </span>
          <div className="ml-auto">
            <NotificationBell />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{sidebar}</div>

        <nav className="shrink-0 border-t border-line px-2 py-2">
          <Link
            to="/scheduled"
            aria-current={location.pathname.startsWith("/scheduled") ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors",
              location.pathname.startsWith("/scheduled")
                ? "bg-brandsoft font-medium text-brandtext"
                : "text-inksoft hover:bg-subtle hover:text-ink",
            )}
          >
            <Clock className="h-4 w-4 shrink-0" />
            定时任务
          </Link>
        </nav>

        {user.role === "admin" ? (
          <nav className="shrink-0 space-y-0.5 border-t border-line px-2 pb-2 pt-3">
            <p className="section-label pb-1.5">管理</p>
            {adminLinks.map(({ to, label, icon: Icon }) => {
              const active = location.pathname.startsWith(to);
              return (
                <Link
                  key={to}
                  to={to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors",
                    active
                      ? "bg-brandsoft font-medium text-brandtext"
                      : "text-inksoft hover:bg-subtle hover:text-ink",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      active ? "text-brandtext" : "text-muted group-hover:text-inksoft",
                    )}
                  />
                  {label}
                </Link>
              );
            })}
          </nav>
        ) : null}

        <div className="shrink-0 border-t border-line p-2">
          <div className="flex items-center gap-2 rounded-lg px-1.5 py-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brandsoft text-xs font-semibold text-brandtext ring-1 ring-inset ring-brand/10">
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium leading-tight text-ink">
                {user.displayName ?? user.username}
              </p>
              <p className="truncate text-[11px] text-muted">
                @{user.username} · {user.role === "admin" ? "管理员" : "成员"}
              </p>
            </div>
            <ThemeToggle />
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="退出登录"
                    disabled={logoutMutation.isPending}
                    onClick={() => logoutMutation.mutate()}
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">退出登录</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {topbar ? (
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur print:hidden">
            <div className="flex min-w-0 flex-1 items-center gap-3">{topbar}</div>
            <div className="flex shrink-0 items-center gap-1">
              <ThemeToggle className="md:hidden" />
              <span className="hidden items-center gap-1.5 rounded-full border border-line bg-subtle/60 px-2.5 py-1 text-[11px] font-medium text-muted md:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                就绪
              </span>
            </div>
          </header>
        ) : null}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
