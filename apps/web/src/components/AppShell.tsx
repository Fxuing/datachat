import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Brain,
  Clock,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { logout, type SessionUser } from "../lib/api";
import { cn } from "../lib/utils";
import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { NotificationBell } from "./NotificationBell";

export interface AppShellStatusIndicator {
  tone: "ready" | "busy" | "warning" | "error";
  label: string;
}

export interface AppShellProps {
  user: SessionUser;
  sidebar: ReactNode;
  topbar?: ReactNode;
  statusIndicator?: AppShellStatusIndicator | null;
  children: ReactNode;
}

const adminLinks: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/admin/settings", label: "管理设置", icon: Settings },
];

const STATUS_DOT_CLASSES: Record<AppShellStatusIndicator["tone"], string> = {
  ready: "bg-success",
  busy: "bg-brand animate-pulse",
  warning: "bg-warning",
  error: "bg-danger",
};

const SIDEBAR_STORAGE_KEY = "datachat:sidebar-collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage may be unavailable in restricted contexts.
  }
}

export function AppShell({
  user,
  sidebar,
  topbar,
  statusIndicator = null,
  children,
}: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed);

  const setCollapsed = (next: boolean) => {
    setSidebarCollapsed(next);
    writeSidebarCollapsed(next);
  };

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname, location.search]);

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear();
      navigate("/login", { replace: true });
    },
  });

  const initial = (user.displayName ?? user.username).slice(0, 1).toUpperCase();
  const inAdmin = location.pathname.startsWith("/admin");

  const renderSidebarContent = (showCloseButton: boolean) => (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <Link
          to="/chat"
          className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <BrandMark size={34} />
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold leading-tight tracking-tight text-ink">
              DataChat
            </span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
              数据工作台
            </span>
          </span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <NotificationBell />
          {showCloseButton ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭导航菜单"
              onClick={() => setMobileNavOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="收起侧边栏"
                  onClick={() => setCollapsed(true)}
                >
                  <PanelLeftClose className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">收起侧边栏</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{sidebar}</div>

      <nav className="shrink-0 border-t border-line px-2 py-2">
        <Link
          to="/dashboards"
          aria-current={location.pathname.startsWith("/dashboards") ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors",
            location.pathname.startsWith("/dashboards")
              ? "bg-brandsoft font-medium text-brandtext"
              : "text-inksoft hover:bg-subtle hover:text-ink",
          )}
        >
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          数据看板
        </Link>
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
        <Link
          to="/memory"
          aria-current={location.pathname.startsWith("/memory") ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors",
            location.pathname.startsWith("/memory")
              ? "bg-brandsoft font-medium text-brandtext"
              : "text-inksoft hover:bg-subtle hover:text-ink",
          )}
        >
          <Brain className="h-4 w-4 shrink-0" />
          我的记忆
        </Link>
      </nav>

      {user.role === "admin" && !inAdmin ? (
        <nav className="shrink-0 space-y-0.5 border-t border-line px-2 pb-2 pt-3">
          <p className="section-label pb-1.5">管理</p>
          {adminLinks.map(({ to, label, icon: Icon }) => {
            const active = location.pathname.startsWith("/admin");
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
              <Button
                variant="ghost"
                size="icon"
                aria-label="退出登录"
                disabled={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">退出登录</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <aside
        data-collapsed={sidebarCollapsed ? "true" : "false"}
        className={cn(
          "hidden w-60 shrink-0 flex-col border-r border-line bg-surface print:hidden",
          !sidebarCollapsed && "md:flex",
        )}
      >
        {renderSidebarContent(false)}
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" hideClose className="flex w-64 flex-col p-0">
          <SheetTitle className="sr-only">导航菜单</SheetTitle>
          <SheetDescription className="sr-only">切换页面与账号设置</SheetDescription>
          {renderSidebarContent(true)}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        {topbar ? (
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur print:hidden">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label="打开导航菜单"
                className="shrink-0 md:hidden"
                onClick={() => setMobileNavOpen(true)}
              >
                <Menu className="h-4 w-4" />
              </Button>
              {sidebarCollapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="展开侧边栏"
                      className="hidden shrink-0 md:inline-flex"
                      onClick={() => setCollapsed(false)}
                    >
                      <PanelLeftOpen className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">展开侧边栏</TooltipContent>
                </Tooltip>
              ) : null}
              <div className="flex min-w-0 flex-1 items-center gap-3">{topbar}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ThemeToggle className="md:hidden" />
              {statusIndicator ? (
                <span className="hidden items-center gap-1.5 rounded-full border border-line bg-subtle/60 px-2.5 py-1 text-[11px] font-medium text-muted md:inline-flex">
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT_CLASSES[statusIndicator.tone])}
                  />
                  {statusIndicator.label}
                </span>
              ) : null}
            </div>
          </header>
        ) : (
          <>
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-surface px-3 md:hidden print:hidden">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="打开导航菜单"
                  onClick={() => setMobileNavOpen(true)}
                >
                  <Menu className="h-4 w-4" />
                </Button>
                <span className="text-sm font-semibold text-ink">DataChat</span>
              </div>
              <ThemeToggle />
            </header>
            {sidebarCollapsed ? (
              <header className="hidden h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:flex print:hidden">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="展开侧边栏"
                      onClick={() => setCollapsed(false)}
                    >
                      <PanelLeftOpen className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">展开侧边栏</TooltipContent>
                </Tooltip>
                <span className="text-sm font-semibold text-ink">DataChat</span>
              </header>
            ) : null}
          </>
        )}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
