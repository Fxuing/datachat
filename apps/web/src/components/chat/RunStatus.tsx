import { Spinner } from "../ui/spinner";
import type { RunStreamState } from "../../lib/run-events";

export function RunStatus({ state }: { state: RunStreamState }) {
  if (state.status === "queued") {
    return (
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        <Spinner className="h-3.5 w-3.5" />
        <span>
          排队中
          {typeof state.queuePosition === "number" ? `（第 ${state.queuePosition} 位）` : ""}
        </span>
      </div>
    );
  }

  if (state.status === "running") {
    return (
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        <Spinner className="h-3.5 w-3.5" />
        <span>{state.text ? "正在生成回答…" : "正在思考…"}</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p className="text-xs text-red-600">
        运行失败{state.error ? `：${state.error}` : "，请重试。"}
      </p>
    );
  }

  if (state.status === "aborted") {
    return <p className="text-xs text-neutral-500">已停止生成</p>;
  }

  return null;
}
