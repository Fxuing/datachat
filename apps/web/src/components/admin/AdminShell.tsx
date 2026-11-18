import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Bot,
  Building2,
  ChevronDown,
  ChevronRight,
  Database,
  Gauge,
  Plug,
  ScrollText,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  Users,
} from "lucide-react";
import { AppShell } from "../AppShell";
import { Button } from "../ui/button";
import type { SessionUser } from "../../lib/api";

interface AdminShellProps {
  user: SessionUser;
  children: ReactNode;
}

const SETTINGS_SECTIONS = [
  { id: "general", label: "通用", icon: Settings },
  { id: "providers", label: "模型服务", icon: Bot },
  { id: "query", label: "查询限制", icon: Gauge },
  { id: "share", label: "分享", icon: Share2 },
];

const ADMIN_LINKS = [
  { to: "/admin/datasources", label: "数据源", icon: Database },
  { to: "/admin/skills", label: "技能管理", icon: BookOpen },
  { to: "/admin/mcp", label: "MCP 服务器", icon: Plug },
  { to: "/admin/audit", label: "审计日志", icon: ScrollText },
  { to: "/admin/ops", label: "运维", icon: Activity },
];

const ACCESS_GROUP = {
  label: "权限管理",
  icon: ShieldCheck,
  items: [
    { to: "/admin/roles", label: "角色", icon: Shield },
    { to: "/admin/users", label: "用户", icon: Users },
    { to: "/admin/departments", label: "部门", icon: Building2 },
  ],
};

export function AdminShell({ user, children }: AdminShellProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const activeSection = pathname === "/admin/settings" ? (params.get("section") ?? "general") : null;
  const accessActive = ACCESS_GROUP.items.some(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  const [accessOpen, setAccessOpen] = useState(accessActive);
  const AccessIcon = ACCESS_GROUP.icon;

  useEffect(() => {
    if (accessActive) setAccessOpen(true);
  }, [accessActive]);

  const sidebar = (
    <div className="p-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => navigate("/chat")}
      >
        <ArrowLeft className="h-4 w-4" />
        返回对话
      </Button>
    </div>
  );

  const itemClass = (active: boolean) =>
    `flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors ${
      active ? "bg-brandsoft font-medium text-brandtext" : "text-inksoft hover:bg-subtle"
    }`;

  return (
    <AppShell user={user} sidebar={sidebar}>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-line p-2 md:w-48 md:overflow-y-auto md:border-b-0 md:border-r">
          <nav aria-label="管理导航" className="flex gap-1 overflow-x-auto md:flex-col">
            <p className="section-label hidden px-3 pb-1 pt-2 md:block">设置</p>
            {SETTINGS_SECTIONS.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.id}
                  to={`/admin/settings?section=${item.id}`}
                  aria-current={activeSection === item.id ? "page" : undefined}
                  className={itemClass(activeSection === item.id)}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
            <p className="section-label hidden px-3 pb-1 pt-4 md:block">管理</p>
            <div className="md:col-span-1">
              <button
                type="button"
                aria-expanded={accessOpen}
                aria-label={ACCESS_GROUP.label}
                className={`${itemClass(accessActive)} justify-between`}
                onClick={() => setAccessOpen((open) => !open)}
              >
                <span className="flex items-center gap-2">
                  <AccessIcon className="h-4 w-4 shrink-0" />
                  {ACCESS_GROUP.label}
                </span>
                {accessOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                )}
              </button>
              {accessOpen ? (
                <div className="mt-0.5 space-y-0.5 md:ml-4 md:border-l md:border-line md:pl-1">
                  {ACCESS_GROUP.items.map((item) => {
                    const Icon = item.icon;
                    const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        aria-current={active ? "page" : undefined}
                        className={itemClass(active)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {ADMIN_LINKS.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className={itemClass(active)}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        {children}
      </div>
    </AppShell>
  );
}
