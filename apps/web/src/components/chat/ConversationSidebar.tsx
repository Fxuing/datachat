import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, ListFilter, Pencil, Plus, Trash2, X } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

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
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-lg border border-line bg-surface shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
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
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterInput, setFilterInput] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  const conversationsQuery = useQuery({
    queryKey: filterQuery ? queryKeys.conversationList(filterQuery) : queryKeys.conversations,
    queryFn: () => listConversations(filterQuery ? { q: filterQuery } : {}),
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

  const closeFilter = () => {
    setFilterOpen(false);
    setFilterInput("");
    setFilterQuery("");
  };

  const submitFilter = () => {
    const q = filterInput.trim();
    if (!q) {
      closeFilter();
      return;
    }
    setFilterQuery(q);
  };

  const clearFilterInput = () => {
    setFilterInput("");
    setFilterQuery("");
    filterInputRef.current?.focus();
  };

  const createMutation = useMutation({
    mutationFn: (id: string) => createConversation({ datasourceId: id }),
    onSuccess: ({ conversation }) => {
      queryClient.setQueryData<{ items: Conversation[]; nextCursor: string | null }>(
        queryKeys.conversations,
        (previous) =>
          previous
            ? { ...previous, items: [conversation, ...previous.items] }
            : { items: [conversation], nextCursor: null },
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      closeDialog();
      setFilterOpen(false);
      setFilterInput("");
      setFilterQuery("");
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
      queryClient.setQueryData<{ items: Conversation[]; nextCursor: string | null }>(
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
      <div className="flex items-center gap-1.5 p-2">
        {filterOpen ? (
          <form
            className="relative min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              submitFilter();
            }}
          >
            <Input
              ref={filterInputRef}
              autoFocus
              aria-label="筛选对话关键词"
              placeholder="筛选对话…"
              value={filterInput}
              maxLength={100}
              onChange={(event) => setFilterInput(event.target.value)}
              onBlur={() => {
                if (!filterInput.trim()) closeFilter();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeFilter();
              }}
              className="h-8 pr-7 text-xs"
            />
            {filterInput ? (
              <button
                type="button"
                aria-label="清除筛选关键词"
                onClick={clearFilterInput}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:bg-line hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </form>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="min-w-0 flex-1 justify-start gap-2"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            新建对话
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={filterOpen ? "secondary" : "outline"}
              size="icon"
              aria-label={filterOpen ? "关闭筛选" : "筛选对话"}
              aria-pressed={filterOpen}
              onClick={() => (filterOpen ? closeFilter() : setFilterOpen(true))}
            >
              {filterOpen ? <X className="h-4 w-4" /> : <ListFilter className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{filterOpen ? "关闭筛选" : "筛选对话"}</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {conversationsQuery.isPending ? (
          <p className="px-2 py-3 text-xs text-muted">加载中…</p>
        ) : conversationsQuery.isError ? (
          <div className="px-2 py-3 text-xs text-danger">
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
          filterQuery ? (
            <p className="px-2 py-3 text-xs text-muted">
              没有匹配“{filterQuery}”的会话。
              <button type="button" className="ml-1 underline" onClick={closeFilter}>
                清除筛选
              </button>
            </p>
          ) : (
            <p className="px-2 py-3 text-xs text-muted">还没有会话，点击上方新建对话开始。</p>
          )
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map((conversation) => {
              const title = conversation.title || "未命名会话";
              const active = conversation.id === activeId;
              return (
                <li
                  key={conversation.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-lg px-2.5 py-2",
                    active ? "bg-brandsoft" : "hover:bg-subtle",
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
                        className="rounded p-1 text-muted hover:bg-line hover:text-ink"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="取消重命名"
                        onClick={() => setRenamingId(null)}
                        className="rounded p-1 text-muted hover:bg-line hover:text-ink"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  ) : (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => navigate(`/chat/${conversation.id}`)}
                            className="min-w-0 flex-1 truncate text-left"
                          >
                            <span
                              className={cn(
                                "block truncate text-sm",
                                active ? "font-medium text-brandtext" : "text-inksoft",
                              )}
                            >
                              {title}
                            </span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" align="start" className="max-w-[16rem]">
                          {title}
                        </TooltipContent>
                      </Tooltip>
                      <span className="shrink-0 text-[10px] text-muted group-hover:hidden group-focus-within:hidden">
                        {formatClock(conversation.lastMessageAt ?? conversation.updatedAt)}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="重命名会话"
                              onClick={() => startRename(conversation)}
                              className="rounded p-1 text-muted hover:bg-line hover:text-inksoft"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">重命名</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="删除会话"
                              onClick={() => setDeleting(conversation)}
                              className="rounded p-1 text-muted hover:bg-line hover:text-danger"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">删除</TooltipContent>
                        </Tooltip>
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
        <p className="px-3 pb-2 text-xs text-danger">
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
                className="mb-1 block text-xs font-medium text-muted"
              >
                选择数据源
              </label>
              {datasourcesQuery.isPending ? (
                <p className="text-sm text-muted">正在加载数据源…</p>
              ) : datasourcesQuery.isError ? (
                <p className="text-sm text-danger">数据源加载失败，请稍后重试。</p>
              ) : datasources.length === 0 ? (
                <p className="rounded-md bg-warningsoft px-3 py-2 text-sm text-warning">
                  还没有可用的数据源，请联系管理员授权。
                </p>
              ) : (
                <Select
                  value={datasourceId || "__none__"}
                  onValueChange={(value) => setDatasourceId(value === "__none__" ? "" : value)}
                >
                  <SelectTrigger id="new-chat-datasource">
                    <SelectValue placeholder="请选择数据源" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">请选择数据源</SelectItem>
                    {datasources.map((datasource) => (
                      <SelectItem key={datasource.id} value={datasource.id}>
                        {datasource.name}（
                        {datasource.type === "mysql" ? "MySQL" : "PostgreSQL"} ·{" "}
                        {datasource.database}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {createMutation.error ? (
              <p className="text-xs text-danger">{errorMessage(createMutation.error)}</p>
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
          <p className="text-sm text-muted">
            确定删除「{deleting.title || "未命名会话"}」吗？消息与查询结果将一并删除，且无法恢复。
          </p>
          {deleteMutation.error ? (
            <p className="mt-2 text-xs text-danger">{errorMessage(deleteMutation.error)}</p>
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
