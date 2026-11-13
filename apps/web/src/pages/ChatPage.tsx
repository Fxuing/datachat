import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Share2 } from "lucide-react";
import { AppShell } from "../components/AppShell";
import { Composer } from "../components/chat/Composer";
import { QuestionCard } from "../components/chat/QuestionCard";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { MessageList } from "../components/chat/MessageList";
import type { ModelPickerStatus } from "../components/chat/ModelPicker";
import { ShareDialog } from "../components/ShareDialog";
import { PageSpinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { useRunStream } from "../hooks/useRunStream";
import { useCan } from "../hooks/use-access";
import {
  ApiError,
  createConversation,
  createReport,
  deleteConversation,
  fetchMe,
  getConversation,
  listDatasources,
  listConversationSkills,
  listModels,
  retryRun,
  sendMessage,
  updateConversation,
  type ChatMessage,
  type ConversationDetail,
} from "../lib/api";
import { queryKeys } from "../lib/query";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [optimisticText, setOptimisticText] = useState<string | null>(null);
  const [optimisticSkill, setOptimisticSkill] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [failedSend, setFailedSend] = useState<{ content: string; skill?: string } | null>(null);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [draftDatasourceId, setDraftDatasourceId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const location = useLocation();

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const canUseChat = useCan("chat.use");
  const canUseSkills = useCan("skill.use");
  const canReport = useCan("report.create");
  const canShare = useCan("share.create");
  const canExport = useCan("export.data");
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
  });
  const skillsQuery = useQuery({
    queryKey: queryKeys.conversationSkills(conversationId ?? ""),
    queryFn: () => listConversationSkills(conversationId as string),
    enabled: Boolean(conversationId) && canUseSkills,
    staleTime: 60_000,
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

  const startMutation = useMutation({
    mutationFn: async (input: { content: string; datasourceId: string }) => {
      const { conversation: created } = await createConversation({
        datasourceId: input.datasourceId,
      });
      try {
        const { runId } = await sendMessage(created.id, input.content);
        return { conversationId: created.id, runId };
      } catch (error) {
        await deleteConversation(created.id).catch(() => undefined);
        throw error;
      }
    },
    onSuccess: ({ conversationId: createdId, runId }, input) => {
      setFailedSend(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      navigate(`/chat/${createdId}`, {
        state: { pendingRun: { runId, content: input.content } },
      });
    },
    onError: (error, input) => {
      setFailedSend({ content: input.content });
      setSendError(errorMessage(error, "创建会话失败，请稍后重试"));
    },
  });

  const sendMutation = useMutation({
    mutationFn: (input: { content: string; skill?: string }) =>
      sendMessage(conversationId as string, input.content, input.skill),
    onSuccess: ({ runId }) => {
      setActiveRunId(runId);
      setFailedSend(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
    onError: (error, input) => {
      setOptimisticText(null);
      setOptimisticSkill(null);
      setFailedSend(input);
      setSendError(errorMessage(error, "发送失败，请稍后重试"));
    },
  });

  const retryMutation = useMutation({
    mutationFn: async ({ message, modelId }: { message: ChatMessage; modelId?: string }) => {
      if (modelId) {
        await updateConversation(conversationId as string, { modelId });
      }
      return retryRun(message.runId);
    },
    onMutate: ({ message }) => {
      setRetryingRunId(message.runId);
      setSendError(null);
    },
    onSuccess: ({ runId }, { message }) => {
      setOptimisticText(message.user.content);
      setOptimisticSkill(message.user.skill ?? null);
      setActiveRunId(runId);
      setRetryingRunId(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversation(conversationId as string),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
    onError: (error) => {
      setRetryingRunId(null);
      setSendError(errorMessage(error, "重试失败，请稍后重试"));
    },
  });

  const reportMutation = useMutation({
    mutationFn: (artifactId: string) =>
      createReport({ conversationId: conversationId as string, artifactIds: [artifactId] }),
    onSuccess: ({ report }) => navigate(`/reports/${report.id}`),
    onError: (error) =>
      setSendError(errorMessage(error, "生成报告失败，请稍后重试")),
  });
  const handleCreateReport =
    conversationId && canReport
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
    setOptimisticSkill(null);
  }, [activeRunPersisted]);

  useEffect(() => {
    setActiveRunId(null);
    setOptimisticText(null);
    setOptimisticSkill(null);
    setSendError(null);
  }, [conversationId]);

  // A brand-new conversation is created on the empty state and navigated to
  // immediately; seed the optimistic turn and stream from the navigation state
  // so the first question does not flash away while history is fetched.
  useEffect(() => {
    const pending = (
      location.state as
        | { pendingRun?: { runId: string; content: string; skill?: string } }
        | null
    )?.pendingRun;
    if (!pending || !conversationId) return;
    setActiveRunId(pending.runId);
    setOptimisticText(pending.content);
    setOptimisticSkill(pending.skill ?? null);
    navigate(location.pathname, { replace: true, state: null });
  }, [conversationId, location.pathname, location.state, navigate]);

  const availableDatasources = datasourcesQuery.data?.datasources ?? [];
  useEffect(() => {
    if (availableDatasources.length === 0) {
      if (draftDatasourceId) setDraftDatasourceId(null);
      return;
    }
    if (
      !draftDatasourceId ||
      !availableDatasources.some((item) => item.id === draftDatasourceId)
    ) {
      setDraftDatasourceId(availableDatasources[0]!.id);
    }
  }, [availableDatasources, draftDatasourceId]);

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

  const handleSend = async (content: string, skill?: string) => {
    if (!canUseChat) return;
    if (!conversationId) {
      if (!draftDatasourceId) {
        setSendError("请先选择一个数据源");
        return;
      }
      if (modelsStatus !== "ready" || modelCount === 0) {
        setSendError("模型服务尚未就绪，请稍后重试");
        return;
      }
      setSendError(null);
      await startMutation.mutateAsync({ content, datasourceId: draftDatasourceId });
      return;
    }
    setSendError(null);
    setOptimisticText(content);
    setOptimisticSkill(skill ?? null);
    await sendMutation.mutateAsync(skill ? { content, skill } : { content });
  };

  const handleRetry = (message: ChatMessage, modelId?: string) => {
    if (!canUseChat) return;
    retryMutation.mutate(modelId ? { message, modelId } : { message });
  };

  const handleExample = canUseChat
    ? (content: string) => void handleSend(content)
    : undefined;

  const user = meQuery.data?.user;
  if (!user) {
    return <PageSpinner />;
  }

  const showStream = !activeRunPersisted && (activeRunId !== null || optimisticText !== null);
  const active = sendMutation.isPending || startMutation.isPending || stream.active;
  const models = modelsQuery.data;
  const modelCount = models?.models.length ?? 0;
  const modelsStatus: ModelPickerStatus = modelsQuery.isPending
    ? "loading"
    : modelsQuery.isError
      ? "error"
      : "ready";
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
        {canShare ? (
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
        ) : null}
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
        datasources={availableDatasources}
        datasourcesLoading={datasourcesQuery.isPending}
        datasourcesError={
          datasourcesQuery.isError
            ? errorMessage(datasourcesQuery.error, "数据源加载失败")
            : null
        }
        onRetryDatasources={() => void datasourcesQuery.refetch()}
        modelsStatus={modelsStatus}
        modelsCount={modelCount}
        onRetryModels={() => void modelsQuery.refetch()}
        selectedDatasourceId={draftDatasourceId}
        onSelectDatasource={setDraftDatasourceId}
        onExample={handleExample}
        starting={startMutation.isPending}
        isAdmin={user.role === "admin"}
        canExport={canExport}
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
        optimisticSkill={optimisticSkill}
        onCreateReport={handleCreateReport}
        activeRunId={activeRunId}
        models={models?.models ?? []}
        retryingRunId={retryingRunId}
        onRetry={handleRetry}
        datasources={availableDatasources}
        datasourcesLoading={datasourcesQuery.isPending}
        datasourcesError={
          datasourcesQuery.isError
            ? errorMessage(datasourcesQuery.error, "数据源加载失败")
            : null
        }
        onRetryDatasources={() => void datasourcesQuery.refetch()}
        modelsStatus={modelsStatus}
        modelsCount={modelCount}
        onRetryModels={() => void modelsQuery.refetch()}
        datasourceLocked
        boundDatasource={datasource ?? null}
        onExample={handleExample}
        starting={sendMutation.isPending}
        isAdmin={user.role === "admin"}
        canExport={canExport}
      />
    );
  }

  return (
    <AppShell user={user} sidebar={<ConversationSidebar activeId={conversationId} />} topbar={topbar}>
      <div className="flex min-h-0 flex-1 flex-col">
        {content}
        {sendError ? (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              <span>{sendError}</span>
              {failedSend ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={sendMutation.isPending}
                  onClick={() => void handleSend(failedSend.content, failedSend.skill)}
                >
                  重新发送
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {conversationId && stream.state.questions.length > 0 ? (
          <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-2">
            {stream.state.questions.map((question) => (
              <QuestionCard
                key={question.toolCallId}
                conversationId={conversationId}
                toolCallId={question.toolCallId}
                questions={question.questions}
              />
            ))}
          </div>
        ) : null}
        <Composer
          conversationReady={
            conversationId
              ? Boolean(conversation)
              : Boolean(draftDatasourceId) && modelsStatus === "ready" && modelCount > 0
          }
          active={active}
          canStop={activeRunId !== null}
          models={models?.models ?? []}
          modelId={currentModelId}
          modelsStatus={modelsStatus}
          modelPickerDisabled={
            modelsQuery.isPending || modelMutation.isPending || !conversation || !canUseChat
          }
          thinkingLevel={conversation?.thinkingLevel ?? "off"}
          skills={canUseSkills ? skillsQuery.data?.skills ?? [] : []}
          readOnlyReason={canUseChat ? undefined : "当前角色没有对话权限，请联系管理员"}
          contextUsage={stream.state.contextUsage ?? conversationQuery.data?.contextUsage ?? null}
          onModelChange={(modelId) => modelMutation.mutate(modelId)}
          onThinkingChange={(level) => thinkingMutation.mutate(level)}
          onSend={handleSend}
          onStop={stream.stop}
        />
      </div>
      {canShare && shareOpen && conversationId ? (
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
