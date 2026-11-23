import { useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Eye, EyeOff, Lock, User } from "lucide-react";
import { ApiError, fetchMe, login } from "../lib/api";
import { useBranding } from "../lib/branding";
import { queryKeys } from "../lib/query";
import { useTheme } from "../lib/theme";
import { BrandMark } from "../components/BrandMark";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

function ChatBubbleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[calc(1.5*var(--u))] w-[calc(1.5*var(--u))] drop-shadow-[0_0_5px_rgba(110,205,255,0.6)]"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 4.25c4.85 0 8.75 3.2 8.75 7.15s-3.9 7.15-8.75 7.15c-1.22 0-2.38-.21-3.44-.58l-3.46 1.73a.45.45 0 0 1-.63-.52l.73-2.73A6.58 6.58 0 0 1 3.25 11.4c0-3.95 3.9-7.15 8.75-7.15Z"
        stroke="#9cd8ff"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
      <circle cx="8.5" cy="11.4" r="1.05" fill="#bfe6ff" />
      <circle cx="12" cy="11.4" r="1.05" fill="#bfe6ff" />
      <circle cx="15.5" cy="11.4" r="1.05" fill="#bfe6ff" />
    </svg>
  );
}

function InsightBoltIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[calc(1.5*var(--u))] w-[calc(1.5*var(--u))] drop-shadow-[0_0_5px_rgba(110,205,255,0.6)]"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13.3 3 5.2 13.1h5.9l-.85 7.9 8.55-10.35h-6L13.3 3Z"
        stroke="#9cd8ff"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[calc(1.5*var(--u))] w-[calc(1.5*var(--u))] drop-shadow-[0_0_5px_rgba(110,205,255,0.6)]"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 3.1 4.9 5.95v5.35c0 4.6 3.02 8.55 7.1 9.85 4.08-1.3 7.1-5.25 7.1-9.85V5.95L12 3.1Z"
        stroke="#9cd8ff"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
      <path
        d="m9 12.1 2.05 2.05 4.1-4.25"
        stroke="#bfe6ff"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const highlights = [
  { Icon: ChatBubbleIcon, title: "自然语言问数", body: "像聊天一样查数据" },
  { Icon: InsightBoltIcon, title: "智能分析洞察", body: "发现数据背后的价值" },
  { Icon: ShieldCheckIcon, title: "只读安全可控", body: "权限审计不出内网" },
];

const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const branding = useBranding();
  const { theme } = useTheme();
  const dark = theme === "dark";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
    <div className="relative flex min-h-screen w-full overflow-hidden bg-gradient-to-br from-slate-50 via-indigo-50/40 to-sky-50 dark:from-canvas dark:via-canvas dark:to-canvas lg:bg-[linear-gradient(108deg,#0c1e4a_0%,#122b66_56%,#eef4ff_56.5%,#f8fafc_100%)] dark:lg:bg-[linear-gradient(108deg,#0c1e4a_0%,#122b66_56%,#0b1120_56.5%,#0b1120_100%)]">
      {/* Desktop full-bleed split artwork with hologram aligned to the floor stage */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 hidden overflow-hidden [container-type:size] lg:block"
      >
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: "max(100cqw, calc(100cqh * 2730 / 1536))",
            aspectRatio: "2730 / 1536",
          }}
        >
          {/* Both light and dark backdrops stay mounted on desktop so toggling
              themes never flashes while decoding; the global View Transition
              cross-fades the page, with an opacity transition fallback. */}
          <picture className="absolute inset-0 block">
            <source media="(min-width: 1024px)" srcSet="/login-bg.webp" type="image/webp" />
            <img
              src={TRANSPARENT_PIXEL}
              alt=""
              draggable={false}
              fetchPriority={dark ? "low" : "high"}
              decoding="async"
              className="h-full w-full select-none object-cover"
            />
          </picture>
          <div
            data-testid="login-bg-dark-layer"
            data-revealed={dark ? "true" : "false"}
            className="absolute inset-0 opacity-0 transition-opacity duration-300 data-[revealed=true]:opacity-100 motion-reduce:transition-none"
          >
            <picture>
              <source media="(min-width: 1024px)" srcSet="/login-bg-dark.webp" type="image/webp" />
              <img
                src={TRANSPARENT_PIXEL}
                alt=""
                draggable={false}
                fetchPriority={dark ? "high" : "low"}
                decoding="async"
                className="h-full w-full select-none object-cover"
              />
            </picture>
          </div>
          <picture>
            <source media="(min-width: 1024px)" srcSet="/login-hologram.svg" type="image/svg+xml" />
            <img
              src={TRANSPARENT_PIXEL}
              alt=""
              draggable={false}
              decoding="async"
              className="pointer-events-none absolute select-none"
              style={{
                left: "46.7%",
                top: "35.2%",
                width: "33.5%",
                transform: "translateX(-50%)",
              }}
            />
          </picture>
        </div>
      </div>

      <div className="relative z-10 grid min-h-screen w-full lg:grid-cols-[63%_37%]">
        <aside
          className="hidden lg:flex lg:flex-col lg:justify-between lg:px-[calc(4*var(--u))] lg:py-[calc(2.5*var(--u))]"
          style={
            {
              // 1 unit = 16px at 1920x1080, scaling continuously with the viewport
              "--u": "clamp(10px, min(0.8333vw, 1.4815vh), 24px)",
            } as CSSProperties
          }
        >
          <div className="flex items-center gap-[calc(0.75*var(--u))]">
            <BrandMark
              size={42}
              className="h-[calc(2.625*var(--u))] w-[calc(2.625*var(--u))] rounded-[calc(0.75*var(--u))] shadow-md shadow-indigo-950/30"
            />
            <span className="text-[length:calc(1.25*var(--u))] font-semibold tracking-tight text-white">
              {branding.title}
            </span>
          </div>

          <div className="mb-auto mt-[12.6vh]">
            <h1 className="origin-left -skew-x-[9deg] text-[length:calc(3.45*var(--u))] font-bold leading-[1.29] tracking-[0.04em] text-white">
              用自然语言
              <br />
              探索
              <span className="mx-[0.06em] bg-gradient-to-r from-[#58d2ff] via-[#75beff] to-[#988cff] bg-clip-text text-transparent">
                数据
              </span>
              的无限可能
            </h1>

            <div className="max-w-[calc(26.875*var(--u))]">
              <p className="mt-[calc(1.75*var(--u))] text-[length:calc(1.125*var(--u))] font-normal leading-[1.62] tracking-[0.015em] text-[#dce8ff]/75">
                让数据查询更简单，让数据分析更智能，
                <br />
                开启你的自然语言问数之旅。
              </p>

              <ul className="mt-[calc(4*var(--u))] grid grid-cols-3 gap-[calc(1.75*var(--u))]">
                {highlights.map(({ Icon, title, body }) => (
                  <li key={title} className="flex flex-col items-center text-center">
                    <span className="flex h-[calc(2.875*var(--u))] w-[calc(2.875*var(--u))] items-center justify-center rounded-[calc(0.8125*var(--u))] bg-gradient-to-b from-[#4f72ce]/30 to-[#5c80de]/38 shadow-[inset_0_0_0_1px_rgba(165,205,255,0.14)]">
                      <Icon />
                    </span>
                    <span className="mt-[calc(0.875*var(--u))] whitespace-nowrap text-[length:calc(0.96875*var(--u))] font-semibold tracking-[0.02em] text-white">
                      {title}
                    </span>
                    <span className="mt-[calc(0.375*var(--u))] whitespace-nowrap text-[length:calc(0.8125*var(--u))] font-normal leading-[calc(1*var(--u))] text-[#bfd4f8]/75">
                      {body}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex items-center gap-[calc(0.875*var(--u))] text-[length:calc(0.71875*var(--u))] tracking-[0.16em] text-[#bfd6ff]/65">
            <span className="h-px w-[calc(2*var(--u))] bg-white/25" aria-hidden="true" />
            <span>只读访问 · SQL 审计 · 数据不出内网</span>
            <span className="h-px w-[calc(2*var(--u))] bg-white/25" aria-hidden="true" />
          </div>
        </aside>

        <main className="relative flex min-h-full items-center justify-center px-6 py-12 sm:px-10 lg:px-8 xl:px-12">
          <div className="absolute right-4 top-4 z-20 sm:right-6 sm:top-6">
            <ThemeToggle />
          </div>

          <div className="w-full max-w-[clamp(340px,20.85vw,440px)] animate-fade-in rounded-2xl border border-white/80 bg-white/95 p-8 shadow-[0_24px_64px_-16px_rgba(30,58,138,0.18)] backdrop-blur-md transition-[background-color,border-color,color,box-shadow] duration-500 dark:border-white/10 dark:bg-surface/95 dark:shadow-[0_24px_64px_-16px_rgba(2,6,23,0.75)] sm:p-9">
            <div className="flex flex-col items-center text-center">
              <BrandMark size={52} className="rounded-2xl shadow-md shadow-indigo-500/20" />
              <h2 className="mt-4 text-2xl font-bold tracking-tight text-ink">{branding.title}</h2>
              <p className="mt-1.5 text-sm text-muted">开启你的数据对话之旅</p>
            </div>

            <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
              <div>
                <label htmlFor="username" className="sr-only">
                  用户名
                </label>
                <div className="relative">
                  <User
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                  />
                  <Input
                    id="username"
                    name="username"
                    autoComplete="username"
                    autoFocus
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      if (validationError) setValidationError(null);
                    }}
                    placeholder="请输入用户名"
                    disabled={mutation.isPending}
                    className="h-11 rounded-xl border-line/90 bg-subtle/40 pl-10 pr-3.5 transition-colors focus-visible:bg-surface dark:bg-subtle/60"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="sr-only">
                  密码
                </label>
                <div className="relative">
                  <Lock
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                  />
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (validationError) setValidationError(null);
                    }}
                    placeholder="请输入密码"
                    disabled={mutation.isPending}
                    className="h-11 rounded-xl border-line/90 bg-subtle/40 pl-10 pr-10 transition-colors focus-visible:bg-surface dark:bg-subtle/60"
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? "隐藏密码" : "显示密码"}
                        aria-pressed={showPassword}
                        disabled={mutation.isPending}
                        className="absolute right-2.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {showPassword ? "隐藏密码" : "显示密码"}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>

              {errorMessage ? (
                <p
                  role="alert"
                  className="rounded-xl border border-danger/20 bg-dangersoft px-3.5 py-2.5 text-[13px] text-danger"
                >
                  {errorMessage}
                </p>
              ) : null}

              <Button
                type="submit"
                className="group h-11 w-full rounded-xl bg-gradient-to-r from-[#2563eb] via-[#4f46e5] to-[#6366f1] text-white shadow-[0_10px_24px_-8px_rgba(79,70,229,0.55)] transition-all hover:brightness-105 disabled:opacity-60"
                disabled={mutation.isPending}
              >
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
    </div>
  );
}
