import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ApiError, fetchMe, login } from "../lib/api";
import { queryKeys } from "../lib/query";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";

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
    <div className="flex min-h-full items-center justify-center bg-neutral-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-neutral-900 text-xs font-semibold text-white">
            DC
          </span>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-neutral-900">DataChat</h1>
            <p className="text-xs text-neutral-500">与你的数据库对话</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm"
          noValidate
        >
          <div className="space-y-1.5">
            <label htmlFor="username" className="block text-sm font-medium text-neutral-800">
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
            <label htmlFor="password" className="block text-sm font-medium text-neutral-800">
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
            <p role="alert" className="text-sm text-red-600">
              {errorMessage}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            {mutation.isPending ? "登录中…" : "登录"}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-neutral-500">
          账号由管理员分配，如需开通请联系管理员
        </p>
      </div>
    </div>
  );
}
