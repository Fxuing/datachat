import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowRight, BarChart3, Database, Sparkles } from "lucide-react";
import { ApiError, fetchMe, login } from "../lib/api";
import { queryKeys } from "../lib/query";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";

const highlights = [
  { icon: Database, title: "连接你的数据", body: "MySQL / PostgreSQL，只读安全访问" },
  { icon: Sparkles, title: "用一句话提问", body: "自动生成 SQL，解释每一步口径" },
  { icon: BarChart3, title: "从结果到报告", body: "图表、导出、分享，一步到位" },
];

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (input: { username: string; password: string }) => {
      await login(input);
      return fetchMe();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.me, data);
      navigate("/chat", { replace: true });
    },
  });

  const errorMessage =
    validationError ??
    (mutation.isError
      ? mutation.error instanceof ApiError
        ? mutation.error.message
        : "登录失败，请稍后重试"
      : null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const trimmed = username.trim();
    if (!trimmed || !password) {
      setValidationError("请输入用户名和密码");
      return;
    }
    setValidationError(null);
    mutation.mutate({ username: trimmed, password });
  };

  return (
    <div className="grid min-h-full bg-canvas lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[#101014] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgb(255 255 255 / 0.14) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / 0.14) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
            maskImage: "radial-gradient(ellipse 80% 60% at 30% 20%, black, transparent)",
          }}
        />
        <div
          aria-hidden
          className="absolute -left-24 top-1/3 h-96 w-96 rounded-full bg-indigo-500/25 blur-[120px]"
        />

        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-indigo-400 to-violet-500 text-[11px] font-bold text-white ring-1 ring-inset ring-white/25">
            DC
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-white">DataChat</span>
        </div>

        <div className="relative max-w-md">
          <p className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-surface/5 px-2.5 py-1 text-[11px] font-medium text-indigo-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            自然语言数据工作台
          </p>
          <h1 className="text-[2.1rem] font-semibold leading-[1.15] tracking-tight text-white">
            不用写 SQL，
            <br />
            也能把数据问明白。
          </h1>
          <p className="mt-4 text-sm leading-6 text-muted">
            连接 MySQL 与 PostgreSQL，用中文直接提问。每一步查询可审计，结果可导出、可成图、可分享。
          </p>

          <ul className="mt-8 space-y-4">
            {highlights.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-surface/5 text-indigo-300">
                  <Icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-[13px] font-medium text-neutral-100">{title}</span>
                  <span className="block text-xs leading-5 text-muted">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[11px] text-muted">
          只读访问 · SQL 审计 · 数据不出内网
        </p>
      </aside>

      <main className="relative flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>

        <div className="mx-auto w-full max-w-sm animate-fade-in">
          <div className="mb-8 lg:hidden">
            <span className="mb-4 flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-indigo-500 to-violet-500 text-[11px] font-bold text-white shadow-sm">
              DC
            </span>
            <h1 className="text-lg font-semibold tracking-tight text-ink">DataChat</h1>
            <p className="text-xs text-muted">与你的数据库对话</p>
          </div>

          <h2 className="hidden text-[1.6rem] font-semibold tracking-tight text-ink lg:block">
            登录工作台
          </h2>
          <p className="mt-1.5 hidden text-sm text-muted lg:block">使用管理员分配的账号继续</p>

          <form onSubmit={submit} className="mt-8 space-y-4 lg:mt-8" noValidate>
            <div className="space-y-1.5">
              <label htmlFor="username" className="block text-[13px] font-medium text-inksoft">
                用户名
              </label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="请输入用户名"
                disabled={mutation.isPending}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-[13px] font-medium text-inksoft">
                密码
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
                disabled={mutation.isPending}
              />
            </div>

            {errorMessage ? (
              <p
                role="alert"
                className="rounded-lg border border-danger/20 bg-dangersoft px-3 py-2 text-[13px] text-danger"
              >
                {errorMessage}
              </p>
            ) : null}

            <Button type="submit" className="group w-full" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              {mutation.isPending ? "登录中…" : "登录"}
              {!mutation.isPending ? (
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              ) : null}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-muted">
            账号由管理员分配，如需开通请联系管理员
          </p>
        </div>
      </main>
    </div>
  );
}
