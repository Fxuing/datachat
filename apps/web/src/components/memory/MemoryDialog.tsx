import { useEffect, useState } from "react";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type {
  DatasourceSummary,
  MemoryInput,
  MemoryItem,
  MemoryKind,
  MemoryScope,
} from "../../lib/api";
import { cn } from "../../lib/utils";

const kindLabels: Record<MemoryKind, string> = {
  profile: "画像",
  instruction: "固定指令",
  preference: "偏好",
  fact: "事实",
};

const kindHints: Record<MemoryKind, string> = {
  profile: "你的角色、行业、负责范围",
  instruction: "每次回答都要遵守的要求",
  preference: "展示口径、格式、习惯",
  fact: "跨会话仍成立的业务事实",
};

interface MemoryDialogProps {
  open: boolean;
  memory: MemoryItem | null;
  datasources: DatasourceSummary[];
  pending?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (input: MemoryInput) => Promise<void> | void;
}

export function MemoryDialog({
  open,
  memory,
  datasources,
  pending,
  error,
  onClose,
  onSubmit,
}: MemoryDialogProps) {
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [scope, setScope] = useState<MemoryScope>("global");
  const [datasourceId, setDatasourceId] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [core, setCore] = useState(false);
  const [confidence, setConfidence] = useState(80);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(memory?.kind ?? "preference");
    setScope(memory?.scope ?? "global");
    setDatasourceId(memory?.datasourceId ?? datasources[0]?.id ?? "");
    setTitle(memory?.title ?? "");
    setContent(memory?.content ?? "");
    setCore(memory?.core ?? false);
    setConfidence(memory?.confidence ?? 80);
    setLocalError(null);
  }, [open, memory, datasources]);

  const supportsCore = kind === "profile" || kind === "instruction" || kind === "preference";

  async function submit() {
    if (!title.trim()) return setLocalError("请填写标题");
    if (!content.trim()) return setLocalError("请填写内容");
    if (title.trim().length > 60) return setLocalError("标题不能超过 60 个字符");
    if (content.trim().length > 1000) return setLocalError("内容不能超过 1000 个字符");
    if (scope === "datasource" && !datasourceId) return setLocalError("请选择数据源");
    setLocalError(null);
    await onSubmit({
      kind,
      title: title.trim(),
      content: content.trim(),
      scope,
      datasourceId: scope === "datasource" ? datasourceId : undefined,
      core: supportsCore ? core : false,
      confidence,
    });
  }

  return (
    <Sheet open={open} onOpenChange={(value) => !value && onClose()}>
      <SheetContent hideClose className="max-w-lg">
        <SheetHeader>
          <SheetTitle>{memory ? "编辑记忆" : "新增记忆"}</SheetTitle>
          <SheetDescription>
            {memory ? "可修改标题、内容、置信度和核心标记；类型与范围创建后固定。" : "记忆会在后续对话中按相关度注入，不会改变历史数据。"}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-[12px] font-medium text-inksoft">
              类型
              <Select value={kind} disabled={Boolean(memory)} onValueChange={(value) => setKind(value as MemoryKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(kindLabels) as MemoryKind[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {kindLabels[value]} · {kindHints[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-[12px] font-medium text-inksoft">
              作用范围
              <Select value={scope} disabled={Boolean(memory)} onValueChange={(value) => setScope(value as MemoryScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">全局</SelectItem>
                  <SelectItem value="datasource">指定数据源</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          {scope === "datasource" ? (
            <label className="block space-y-1.5 text-[12px] font-medium text-inksoft">
              数据源
              <Select value={datasourceId} disabled={Boolean(memory)} onValueChange={setDatasourceId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择数据源" />
                </SelectTrigger>
                <SelectContent>
                  {datasources.map((datasource) => (
                    <SelectItem key={datasource.id} value={datasource.id}>
                      {datasource.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}

          <label className="block space-y-1.5 text-[12px] font-medium text-inksoft">
            标题
            <Input
              value={title}
              maxLength={60}
              placeholder="例如：金额展示口径"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-[12px] font-medium text-inksoft">
            内容
            <Textarea
              value={content}
              rows={5}
              maxLength={1000}
              placeholder="例如：金额一律按万元展示，保留两位小数"
              onChange={(event) => setContent(event.target.value)}
            />
            <span className="block text-right text-[11px] text-muted">{content.length}/1000</span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-[12px] font-medium text-inksoft">
              置信度
              <Input
                type="number"
                min={0}
                max={100}
                value={confidence}
                onChange={(event) => setConfidence(Number(event.target.value))}
              />
            </label>
            <label
              className={cn(
                "flex cursor-pointer items-center gap-2 self-end rounded-lg border border-line px-3 py-2 text-[12px]",
                !supportsCore && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand"
                checked={core}
                disabled={!supportsCore}
                onChange={(event) => setCore(event.target.checked)}
              />
              <span>
                核心记忆
                <span className="block text-[10px] text-muted">
                  每次对话优先注入（置信度 ≥80 的偏好也会自动常驻）
                </span>
              </span>
            </label>
          </div>

          {localError || error ? (
            <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
              {localError ?? error}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <SheetClose asChild>
            <Button variant="ghost" size="sm">
              取消
            </Button>
          </SheetClose>
          <Button size="sm" disabled={pending} onClick={() => void submit()}>
            {pending ? "保存中…" : "保存"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
