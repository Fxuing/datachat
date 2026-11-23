import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Link2 } from "lucide-react";
import { createShare, revokeShare, type CreatedShare } from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import { describeApiError } from "../lib/errors";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface ShareTarget {
  conversationId?: string;
  reportId?: string;
  dashboardId?: string;
  label?: string;
}

export interface ShareDialogProps {
  target: ShareTarget;
  onClose: () => void;
}

const EXPIRY_OPTIONS = [
  { value: 1, label: "1 天" },
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
];

function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

export function ShareDialog({ target, onClose }: ShareDialogProps) {
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [copied, setCopied] = useState(false);

  const createMutation = useMutation({
    mutationFn: () =>
      createShare({
        ...(target.conversationId !== undefined
          ? { conversationId: target.conversationId }
          : {}),
        ...(target.reportId !== undefined ? { reportId: target.reportId } : {}),
        ...(target.dashboardId !== undefined ? { dashboardId: target.dashboardId } : {}),
        expiresInDays,
      }),
    onSuccess: (data) => setCreated(data.share),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeShare(id),
  });

  const shareUrl = created ? absoluteUrl(created.url) : null;
  const revoked = revokeMutation.isSuccess;
  const createError = createMutation.isError
    ? describeApiError(createMutation.error, "创建分享链接失败，请稍后重试。")
    : null;
  const revokeError = revokeMutation.isError
    ? describeApiError(revokeMutation.error, "撤销分享链接失败，请稍后重试。")
    : null;

  const handleCopy = async () => {
    if (!shareUrl) return;
    setCopied(await copyToClipboard(shareUrl));
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !createMutation.isPending ? onClose() : undefined)}>
      <DialogContent className="max-w-md p-5">
        <div className="flex items-start gap-3 pr-8">
          <div>
            <DialogTitle>分享</DialogTitle>
            <DialogDescription className="mt-1">
              {target.label ? `分享“${target.label}”` : "生成只读的公开链接"}
            </DialogDescription>
          </div>
        </div>

        {created === null ? (
          <div className="mt-4 space-y-4">
            <label className="block text-xs font-medium text-inksoft">
              有效期
              <Select
                value={String(expiresInDays)}
                onValueChange={(value) => setExpiresInDays(Number(value))}
                disabled={createMutation.isPending}
              >
                <SelectTrigger className="mt-1.5 h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {createError ? (
              <p role="alert" className="text-xs text-danger">
                {createError}
              </p>
            ) : null}
            <Button
              className="w-full"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
            >
              <Link2 className="h-3.5 w-3.5" />
              {createMutation.isPending ? "创建中…" : "创建分享链接"}
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2">
              <input
                readOnly
                aria-label="分享链接"
                className="h-9 min-w-0 flex-1 rounded-md border border-linestrong bg-subtle px-2 text-xs text-inksoft"
                value={shareUrl ?? created.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                variant="outline"
                onClick={() => void handleCopy()}
                disabled={revoked}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "已复制" : "复制"}
              </Button>
            </div>
            <p className="rounded-md bg-warningsoft px-3 py-2 text-xs text-warning">
              链接仅显示一次，关闭后无法再次查看，请立即复制。
            </p>
            <p className="text-xs text-muted">
              过期时间：{new Date(created.expiresAt).toLocaleString("zh-CN", { hour12: false })}
            </p>
            {revoked ? (
              <p className="text-xs text-muted">链接已撤销，访问时将显示已失效。</p>
            ) : (
              <Button
                variant="outline"
                className="w-full text-danger hover:bg-dangersoft hover:text-danger"
                onClick={() => revokeMutation.mutate(created.id)}
                disabled={revokeMutation.isPending}
              >
                {revokeMutation.isPending ? "撤销中…" : "撤销链接"}
              </Button>
            )}
            {revokeError ? (
              <p role="alert" className="text-xs text-danger">
                {revokeError}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
