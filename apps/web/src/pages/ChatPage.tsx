import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Share2 } from "lucide-react";
import { AppShell } from "../components/AppShell";
import { Composer } from "../components/chat/Composer";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { MessageList } from "../components/chat/MessageList";
import { ShareDialog } from "../components/ShareDialog";
import { PageSpinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { useRunStream } from "../hooks/useRunStream";
import {
  ApiError,
  createReport,
  fetchMe,
  getConversation,
  listDatasources,
  listModels,
  sendMessage,
  updateConversation,
  type ChatModelInfo,
  type ConversationDetail,
} from "../lib/api";
import { queryKeys } from "../lib/query";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

function groupModelsByProvider(models: ChatModelInfo[]): Array<[string, ChatModelInfo[]]> {
  const groups = new Map<string, ChatModelInfo[]>();
  for (const model of models) {
    const list = groups.get(model.providerName) ?? [];
    list.push(model);
    groups.set(model.providerName, list);
  }
  return [...groups.entries()];
}

function ModelSelector({
  models,
  currentId,
  disabled,
  onChange,
}: {
  models: ChatModelInfo[];
  currentId: string;
  disabled: boolean;
  onChange: (modelId: string) => void;
}) {
  return (
    <select
      aria-label="选择模型"
      className="h-8 max-w-[12rem] rounded-lg border border-line bg-surface px-2 text-xs text-inksoft shadow-sm transition-colors hover:border-linestrong focus:border-brand/50 focus:outline-none focus:ring-2 focus:ring-brand/10 disabled:cursor-not-allowed disabled:opacity-60"
      value={currentId}
      disabled={disabled || models.length === 0}
      onChange={(event) => onChange(event.target.value)}
    >
      {currentId ? null : (
        <option value="" disabled>
          默认模型
        </option>
      )}
      {groupModelsByProvider(models).map(([providerName, providerModels]) => (
        <optgroup key={providerName} label={providerName}>
          {providerModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [optimisticText, setOptimisticText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const datasourcesQuery = useQuery({
    queryKey: queryKeys.datasources,
    queryFn: listDatasources,
  });
  const conversationQuery = useQuery({
    queryKey: queryKeys.conversation(conversationId ?? ""),
    queryFn: () => getConversation(conversationId as string),
    enabled: Boolean(conversationId),
  });
  const modelsQuery = useQuery({
    queryKey: queryKeys.models,
    queryFn: listModels,
    enabled: Boolean(conversationId),
  });

  const conversation = conversationQuery.data?.conversation;
  const messages = conversationQuery.data?.messages;
  const activeRunFromServer = conversationQuery.data?.activeRun ?? null;
  const datasource = datasourcesQuery.data?.datasources.find(
    (item) => item.id === conversation?.datasourceId,
  );

  const stream = useRunStream({ runId: activeRunId, conversationId: conversationId ?? null });

  const modelMutation = useMutation({
    mutationFn: (modelId: string) => updateConversation(conversationId as string, { modelId }),
    onSuccess: ({ conversation: updated }) => {
      queryClient.setQueryData<ConversationDetail>(
        queryKeys.conversation(conversationId as string),
        (previous) => (previous ? { ...previous, conversation: updated } : previous),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });

  const thinkingMutation = useMutation({
    mutationFn: (thinkingLevel: string) =>
      updateConversation(conversationId as string, { thinkingLevel }),
    onSuccess: ({ conversation: updated }) => {
      queryClient.setQueryData<ConversationDetail>(
        queryKeys.conversation(conversationId as string),
        (previous) => (previous ? { ...previous, conversation: updated } : previous),
      );
    },
  });

  const sendMutation = useMutation({
    mutationFn: (content: string) => sendMessage(conversationId as string, content),
    onSuccess: ({ runId }) => {
      setActiveRunId(runId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
    onError: (error) => {
      setOptimisticText(null);
      setSendError(errorMessage(error, "发送失败，请稍后重试"));
    },
  });

  const reportMutation = useMutation({
    mutationFn: (artifactId: string) =>
      createReport({ conversationId: conversationId as string, artifactIds: [artifactId] }),
    onSuccess: ({ report }) => navigate(`/reports/${report.id}`),
    onError: (error) =>
      setSendError(errorMessage(error, "生成报告失败，请稍后重试")),
  });
  const handleCreateReport = conversationId
    ? (artifactId: string) => reportMutation.mutate(artifactId)
    : undefined;

  // Once the persisted history contains the finished run, drop the optimistic block
  // so the same message is not rendered twice. A still-running persisted group does
  // not clear the block, otherwise a background refetch (e.g. after a rename) would
  // detach from the live stream.
  const activeRunPersisted = Boolean(
    activeRunId &&
      messages?.some(
        (message) =>
          message.runId === activeRunId &&
          message.status !== "queued" &&
          message.status !== "running",
      ),
  );

  useEffect(() => {
    if (!activeRunPersisted) return;
    setActiveRunId(null);
    setOptimisticText(null);
  }, [activeRunPersisted]);

  useEffect(() => {
    setActiveRunId(null);
    setOptimisticText(null);
    setSendError(null);
  }, [conversationId]);

  // Reattach to a run that was still queued/running when the page was (re)loaded.
  useEffect(() => {
    if (activeRunId || !activeRunFromServer) return;
    const alreadyFinished = messages?.some(
      (message) =>
        message.runId === activeRunFromServer.id &&
        message.status !== "queued" &&
        message.status !== "running",
    );
    if (!alreadyFinished) setActiveRunId(activeRunFromServer.id);
  }, [activeRunId, activeRunFromServer, messages]);

  const handleSend = async (content: string) => {
    setSendError(null);
    setOptimisticText(content);
    await sendMutation.mutateAsync(content);
  };

  const user = meQuery.data?.user;
  if (!user) {
    return <PageSpinner />;
  }

  const showStream = !activeRunPersisted && (activeRunId !== null || optimisticText !== null);
  const active = sendMutation.isPending || stream.active;
  const models = modelsQuery.data;
  const currentModelId = conversation?.modelId ?? models?.defaultId ?? "";
  const topbar = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-ink">
          {conversation?.title ?? (conversationId ? "未命名会话" : "新对话")}
        </span>
        {datasource ? (
          <span className="hidden shrink-0 rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted sm:inline">
            {datasource.name} · {datasource.type === "mysql" ? "MySQL" : "PostgreSQL"}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {models?.configured === false ? (
          <span
            className="text-xs text-muted"
            title="服务端未配置 SILICONFLOW_API_KEY"
          >
            未配置模型
          </span>
        ) : (
          <ModelSelector
            models={models?.models ?? []}
            currentId={currentModelId}
            disabled={
              !conversationId ||
              modelsQuery.isPending ||
              modelMutation.isPending ||
              !conversation
            }
            onChange={(modelId) => modelMutation.mutate(modelId)}
          />
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={!conversationId || !conversation}
          onClick={() => setShareOpen(true)}
        >
          <Share2 className="h-3.5 w-3.5" />
          分享
        </Button>
      </div>
    </>
  );

  let content: ReactNode;
  if (!conversationId) {
    content = (
      <MessageList
        messages={[]}
        stream={stream.state}
        showStream={false}
        optimisticText={null}
      />
    );
  } else if (conversationQuery.isPending) {
    content = <PageSpinner label="加载会话…" />;
  } else if (conversationQuery.isError) {
    const notFound = conversationQuery.error instanceof ApiError && conversationQuery.error.status === 404;
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted">
        <p>{notFound ? "会话不存在或已被删除。" : "会话加载失败，请稍后重试。"}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/chat")}>
            返回
          </Button>
          {notFound ? null : (
            <Button size="sm" onClick={() => void conversationQuery.refetch()}>
              重试
            </Button>
          )}
        </div>
      </div>
    );
  } else {
    content = (
      <MessageList
        messages={messages ?? []}
        artifacts={conversationQuery.data?.artifacts ?? []}
        stream={stream.state}
        showStream={showStream}
        optimisticText={optimisticText}
        onCreateReport={handleCreateReport}
      />
    );
  }

  return (
    <AppShell user={user} sidebar={<ConversationSidebar activeId={conversationId} />} topbar={topbar}>
      <div className="flex min-h-0 flex-1 flex-col">
        {content}
        {sendError ? (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <p
              role="alert"
              className="rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              {sendError}
            </p>
          </div>
        ) : null}
        <Composer
          conversationReady={Boolean(conversationId) && Boolean(conversation)}
          active={active}
          canStop={activeRunId !== null}
          thinkingLevel={conversation?.thinkingLevel ?? "off"}
          onThinkingChange={(level) => thinkingMutation.mutate(level)}
          onSend={handleSend}
          onStop={stream.stop}
        />
      </div>
      {shareOpen && conversationId ? (
        <ShareDialog
          target={{
            conversationId,
            ...(conversation?.title ? { label: conversation.title } : {}),
          }}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </AppShell>
  );
}
