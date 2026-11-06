import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { BookOpen, LogOut } from "lucide-react";
import { logout, type SessionUser } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export interface AppShellProps {
  user: SessionUser;
  sidebar: ReactNode;
  topbar?: ReactNode;
  children: ReactNode;
}

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
    <div className="flex h-full min-h-0 bg-neutral-50">
      <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-white">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 px-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-[10px] font-semibold text-white">
            DC
          </span>
          <span className="text-sm font-semibold tracking-tight text-neutral-900">DataChat</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{sidebar}</div>

        {user.role === "admin" ? (
          <div className="shrink-0 border-t border-neutral-200 p-2">
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
              管理
            </p>
            <Link
              to="/admin/skills"
              aria-current={location.pathname.startsWith("/admin/skills") ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                location.pathname.startsWith("/admin/skills")
                  ? "bg-neutral-100 font-medium text-neutral-900"
                  : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900",
              )}
            >
              <BookOpen className="h-4 w-4" />
              技能管理
            </Link>
          </div>
        ) : null}

        <div className="shrink-0 border-t border-neutral-200 p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-700">
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-neutral-900">
                {user.displayName ?? user.username}
              </p>
              <p className="truncate text-xs text-neutral-500">
                {user.role === "admin" ? "管理员" : "成员"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              title="退出登录"
              aria-label="退出登录"
              disabled={logoutMutation.isPending}
              onClick={() => logoutMutation.mutate()}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {topbar ? (
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4">
            {topbar}
          </header>
        ) : null}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
