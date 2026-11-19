import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, ListFilter, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  ApiError,
  deleteConversation,
  listConversations,
  updateConversation,
  type Conversation,
  type DatasourceSummary,
} from "../../lib/api";
import { queryKeys } from "../../lib/query";
import { cn, formatClock } from "../../lib/utils";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export interface ConversationSidebarProps {
  activeId?: string;
  datasources?: DatasourceSummary[];
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "操作失败，请稍后重试";
}

export function ConversationSidebar({ activeId, datasources }: ConversationSidebarProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterInput, setFilterInput] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);

  const conversationsQuery = useInfiniteQuery({
    queryKey: filterQuery ? queryKeys.conversationList(filterQuery) : queryKeys.conversations,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params: { q?: string; before?: string } = {};
      if (filterQuery) params.q = filterQuery;
      if (pageParam) params.before = pageParam;
      return listConversations(params);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const cachedDatasources =
    queryClient.getQueryData<{ datasources: DatasourceSummary[] }>(queryKeys.datasources)
      ?.datasources ?? [];
  const datasourceNames = new Map(
    (datasources ?? cachedDatasources).map((item) => [item.id, item.name]),
  );
  const conversations = useMemo(() => {
    const pages = conversationsQuery.data?.pages ?? [];
    const seen = new Set<string>();
    const list: Conversation[] = [];
    for (const page of pages) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        list.push(item);
      }
    }
    return list;
  }, [conversationsQuery.data?.pages]);

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!filterOpen) return;
    const trimmed = filterInput.trim();
    debounceRef.current = window.setTimeout(() => {
      setFilterQuery(trimmed);
      debounceRef.current = null;
    }, 300);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [filterOpen, filterInput]);

  const closeFilter = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setFilterOpen(false);
    setFilterInput("");
    setFilterQuery("");
  };

  const submitFilter = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const q = filterInput.trim();
    if (!q) {
      closeFilter();
      return;
    }
    setFilterQuery(q);
  };

  const clearFilterInput = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setFilterInput("");
    setFilterQuery("");
    filterInputRef.current?.focus();
  };

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => updateConversation(id, { title }),
    onSuccess: ({ conversation }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversation(conversation.id) });
      setRenamingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: (_data, id) => {
      queryClient.setQueriesData<
        InfiniteData<{ items: Conversation[]; nextCursor: string | null }>
      >({ queryKey: queryKeys.conversations }, (previous) =>
        previous
          ? {
              ...previous,
              pages: previous.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== id),
              })),
            }
          : previous,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      setDeleting(null);
      if (activeId === id) navigate("/chat");
    },
  });

  const startRename = (conversation: Conversation) => {
    renameMutation.reset();
    setRenamingId(conversation.id);
    setDraft(conversation.title ?? "");
  };

  const cancelRename = () => {
    renameMutation.reset();
    setRenamingId(null);
  };

  const submitRename = (id: string) => {
    const title = draft.trim();
    if (!title) return;
    renameMutation.mutate({ id, title });
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
            onClick={() => navigate("/chat")}
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
          <>
            <ul className="flex flex-col gap-0.5">
              {conversations.map((conversation) => {
                const title = conversation.title || "未命名会话";
                const active = conversation.id === activeId;
                const datasourceName = datasourceNames.get(conversation.datasourceId);
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
                          disabled={renameMutation.isPending}
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") cancelRename();
                          }}
                          className="h-7 min-w-0 flex-1 px-2 text-xs"
                        />
                        <button
                          type="submit"
                          aria-label="保存名称"
                          disabled={renameMutation.isPending}
                          className="rounded p-1 text-muted hover:bg-line hover:text-ink disabled:opacity-50"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="取消重命名"
                          disabled={renameMutation.isPending}
                          onClick={cancelRename}
                          className="rounded p-1 text-muted hover:bg-line hover:text-ink disabled:opacity-50"
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
                              {datasourceName ? (
                                <span className="block truncate text-[10px] text-muted">
                                  {datasourceName}
                                </span>
                              ) : null}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" align="start" className="max-w-[16rem]">
                            {title}
                          </TooltipContent>
                        </Tooltip>
                        <span className="shrink-0 text-[10px] text-muted group-hover:hidden group-focus-within:hidden [@media(hover:none)]:hidden">
                          {formatClock(conversation.lastMessageAt ?? conversation.updatedAt)}
                        </span>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
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
                                onClick={() => {
                                  deleteMutation.reset();
                                  setDeleting(conversation);
                                }}
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
            {conversationsQuery.hasNextPage ? (
              <div className="pt-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs text-muted hover:text-ink"
                  disabled={conversationsQuery.isFetchingNextPage}
                  onClick={() => void conversationsQuery.fetchNextPage()}
                >
                  {conversationsQuery.isFetchingNextPage ? "加载中…" : "加载更多"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {renameMutation.error ? (
        <p role="alert" className="px-3 pb-2 text-xs text-danger">
          重命名失败：{errorMessage(renameMutation.error)}
        </p>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="删除会话"
          description={`确定删除「${deleting.title || "未命名会话"}」吗？消息与查询结果将一并删除，且无法恢复。`}
          confirmLabel={deleteMutation.isPending ? "删除中…" : "删除"}
          variant="danger"
          pending={deleteMutation.isPending}
          error={deleteMutation.error ? errorMessage(deleteMutation.error) : null}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onCancel={() => {
            deleteMutation.reset();
            setDeleting(null);
          }}
        />
      ) : null}
    </div>
  );
}
