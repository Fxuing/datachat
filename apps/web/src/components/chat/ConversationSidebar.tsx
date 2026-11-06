import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  ApiError,
  createConversation,
  deleteConversation,
  listConversations,
  listDatasources,
  updateConversation,
  type Conversation,
} from "../../lib/api";
import { queryKeys } from "../../lib/query";
import { cn, formatClock } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface ConversationSidebarProps {
  activeId?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "操作失败，请稍后重试";
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-neutral-900/30 p-4"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-neutral-200 px-4 py-3 text-sm font-semibold text-neutral-900">
          {title}
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function ConversationSidebar({ activeId }: ConversationSidebarProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [datasourceId, setDatasourceId] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);

  const conversationsQuery = useQuery({
    queryKey: queryKeys.conversations,
    queryFn: listConversations,
  });
  const datasourcesQuery = useQuery({
    queryKey: queryKeys.datasources,
    queryFn: listDatasources,
    enabled: dialogOpen,
  });

  const datasources = datasourcesQuery.data?.datasources ?? [];
  const conversations = conversationsQuery.data?.items ?? [];

  useEffect(() => {
    if (!dialogOpen || datasourceId) return;
    const first = datasources[0];
    if (first) setDatasourceId(first.id);
  }, [dialogOpen, datasourceId, datasources]);

  const closeDialog = () => {
    setDialogOpen(false);
    setDatasourceId("");
    createMutation.reset();
  };

  const createMutation = useMutation({
    mutationFn: (id: string) => createConversation({ datasourceId: id }),
    onSuccess: ({ conversation }) => {
      queryClient.setQueryData<{ items: Conversation[]; nextCursor: number | null }>(
        queryKeys.conversations,
        (previous) =>
          previous
            ? { ...previous, items: [conversation, ...previous.items] }
            : { items: [conversation], nextCursor: null },
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      closeDialog();
      navigate(`/chat/${conversation.id}`);
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => updateConversation(id, { title }),
    onSuccess: ({ conversation }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversation(conversation.id) });
      setRenamingId(null);
    },
    onSettled: () => setRenamingId(null),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<{ items: Conversation[]; nextCursor: number | null }>(
        queryKeys.conversations,
        (previous) =>
          previous ? { ...previous, items: previous.items.filter((item) => item.id !== id) } : previous,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      setDeleting(null);
      if (activeId === id) navigate("/chat");
    },
  });

  const startRename = (conversation: Conversation) => {
    setRenamingId(conversation.id);
    setDraft(conversation.title ?? "");
  };

  const submitRename = (id: string) => {
    const title = draft.trim();
    if (!title) return;
    renameMutation.mutate({ id, title });
  };

  const submitCreate = () => {
    if (!datasourceId) return;
    createMutation.mutate(datasourceId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-4 w-4" />
          新建对话
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {conversationsQuery.isPending ? (
          <p className="px-2 py-3 text-xs text-neutral-400">加载中…</p>
        ) : conversationsQuery.isError ? (
          <div className="px-2 py-3 text-xs text-red-600">
            <p>会话列表加载失败</p>
            <button
              type="button"
              className="mt-1 underline"
              onClick={() => void conversationsQuery.refetch()}
            >
              重试
            </button>
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-xs text-neutral-400">还没有会话，点击上方新建对话开始。</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map((conversation) => {
              const title = conversation.title || "未命名会话";
              const active = conversation.id === activeId;
              return (
                <li
                  key={conversation.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-2 py-1.5",
                    active ? "bg-neutral-100" : "hover:bg-neutral-50",
                  )}
                >
                  {renamingId === conversation.id ? (
                    <form
                      className="flex w-full items-center gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitRename(conversation.id);
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label="会话名称"
                        value={draft}
                        maxLength={120}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setRenamingId(null);
                        }}
                        className="h-7 min-w-0 flex-1 px-2 text-xs"
                      />
                      <button
                        type="submit"
                        aria-label="保存名称"
                        className="rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="取消重命名"
                        onClick={() => setRenamingId(null)}
                        className="rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        title={title}
                        onClick={() => navigate(`/chat/${conversation.id}`)}
                        className="min-w-0 flex-1 truncate text-left"
                      >
                        <span
                          className={cn(
                            "block truncate text-sm",
                            active ? "font-medium text-neutral-900" : "text-neutral-700",
                          )}
                        >
                          {title}
                        </span>
                      </button>
                      <span className="shrink-0 text-[10px] text-neutral-400 group-hover:hidden group-focus-within:hidden">
                        {formatClock(conversation.lastMessageAt ?? conversation.updatedAt)}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          aria-label="重命名会话"
                          title="重命名"
                          onClick={() => startRename(conversation)}
                          className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="删除会话"
                          title="删除"
                          onClick={() => setDeleting(conversation)}
                          className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {renameMutation.error ? (
        <p className="px-3 pb-2 text-xs text-red-600">
          重命名失败：{errorMessage(renameMutation.error)}
        </p>
      ) : null}

      {dialogOpen ? (
        <Modal title="新建对话" onClose={closeDialog}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <div>
              <label
                htmlFor="new-chat-datasource"
                className="mb-1 block text-xs font-medium text-neutral-600"
              >
                选择数据源
              </label>
              {datasourcesQuery.isPending ? (
                <p className="text-sm text-neutral-500">正在加载数据源…</p>
              ) : datasourcesQuery.isError ? (
                <p className="text-sm text-red-600">数据源加载失败，请稍后重试。</p>
              ) : datasources.length === 0 ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  还没有可用的数据源，请联系管理员授权。
                </p>
              ) : (
                <select
                  id="new-chat-datasource"
                  value={datasourceId}
                  onChange={(event) => setDatasourceId(event.target.value)}
                  className="h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-800 focus:border-neutral-500 focus:outline-none"
                >
                  <option value="">请选择数据源</option>
                  {datasources.map((datasource) => (
                    <option key={datasource.id} value={datasource.id}>
                      {datasource.name}（{datasource.type === "mysql" ? "MySQL" : "PostgreSQL"} ·{" "}
                      {datasource.database}）
                    </option>
                  ))}
                </select>
              )}
            </div>
            {createMutation.error ? (
              <p className="text-xs text-red-600">{errorMessage(createMutation.error)}</p>
            ) : null}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={closeDialog}>
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!datasourceId || createMutation.isPending}
              >
                {createMutation.isPending ? "创建中…" : "创建并开始对话"}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal title="删除会话" onClose={() => setDeleting(null)}>
          <p className="text-sm text-neutral-600">
            确定删除「{deleting.title || "未命名会话"}」吗？消息与查询结果将一并删除，且无法恢复。
          </p>
          {deleteMutation.error ? (
            <p className="mt-2 text-xs text-red-600">{errorMessage(deleteMutation.error)}</p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(deleting.id)}
            >
              {deleteMutation.isPending ? "删除中…" : "删除"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
