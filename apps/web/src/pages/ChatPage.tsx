import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Download, FileSpreadsheet, Share2, X } from "lucide-react";
import { AppShell, type AppShellStatusIndicator } from "../components/AppShell";
import { Composer } from "../components/chat/Composer";
import { QuestionCard } from "../components/chat/QuestionCard";
import { SuggestedQuestions } from "../components/chat/SuggestedQuestions";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { FileTablesDialog } from "../components/chat/FileTablesDialog";
import { MessageList } from "../components/chat/MessageList";
import type { ModelPickerStatus } from "../components/chat/ModelPicker";
import { ShareDialog } from "../components/ShareDialog";
import { PageSpinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { useRunStream } from "../hooks/useRunStream";
import { useCan } from "../hooks/use-access";
import {
  ApiError,
  appendConversationFiles,
  createConversation,
  createConversationFromDataset,
  createFileConversation,
  createReport,
  deleteConversation,
  deleteFileDataset,
  fetchMe,
  getConversation,
  getRunSuggestions,
  listDatasources,
  listConversationSkills,
  listDatasourceSkills,
  listFileDatasets,
  listGlobalSkills,
  listModels,
  previewUploadedFiles,
  retryRun,
  saveConversationAsDataset,
  sendMessage,
  updateConversation,
  type ChatMessage,
  type ConversationDetail,
  type FilePreviewResponse,
} from "../lib/api";
import { queryKeys } from "../lib/query";
import { applyContextWindow } from "../lib/context-usage";
import {
  buildConversationMarkdown,
  downloadTextFile,
  sanitizeFileName,
} from "../lib/conversation-export";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeTurn, setActiveTurn] = useState<{
    conversationId: string;
    runId: string | null;
    optimisticText: string | null;
    optimisticSkill: string | null;
  } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [failedSend, setFailedSend] = useState<{ content: string; skill?: string } | null>(null);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [draftDatasourceId, setDraftDatasourceId] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState<"datasource" | "file">("datasource");
  const [draftFiles, setDraftFiles] = useState<File[]>([]);
  const [draftHeaderRows, setDraftHeaderRows] = useState<Array<number | undefined>>([]);
  const [filePreview, setFilePreview] = useState<FilePreviewResponse | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [savedDatasetName, setSavedDatasetName] = useState<string | null>(null);
  const [fileTablesOpen, setFileTablesOpen] = useState(false);
  const previewSeqRef = useRef(0);
  const [draftModelId, setDraftModelId] = useState<string | null>(null);
  const [draftThinkingLevel, setDraftThinkingLevel] = useState<string>("off");
  const [dismissedSuggestionRunId, setDismissedSuggestionRunId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const location = useLocation();

  const currentTurn =
    activeTurn && conversationId && activeTurn.conversationId === conversationId
      ? activeTurn
      : null;
  const activeRunId = currentTurn?.runId ?? null;
  const optimisticText = currentTurn?.optimisticText ?? null;
  const optimisticSkill = currentTurn?.optimisticSkill ?? null;

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
  const isNewFileDraft = !conversationId && draftMode === "file";
  const fileDatasetsQuery = useQuery({
    queryKey: queryKeys.fileDatasets,
    queryFn: listFileDatasets,
    enabled: canUseChat && isNewFileDraft,
    staleTime: 30_000,
  });
  const skillsDatasourceId =
    conversationQuery.data?.conversation?.datasourceId ?? (isNewFileDraft ? null : draftDatasourceId);
  const skillsQuery = useQuery({
    queryKey: conversationId
      ? queryKeys.conversationSkills(conversationId)
      : isNewFileDraft
        ? queryKeys.globalSkills
        : queryKeys.datasourceSkills(skillsDatasourceId ?? ""),
    queryFn: () =>
      conversationId
        ? listConversationSkills(conversationId)
        : isNewFileDraft
          ? listGlobalSkills()
          : listDatasourceSkills(skillsDatasourceId as string),
    enabled: canUseSkills && Boolean(conversationId || isNewFileDraft || skillsDatasourceId),
    staleTime: 60_000,
  });

  const conversation = conversationQuery.data?.conversation;
  const messages = conversationQuery.data?.messages;
  const conversationFiles = conversationQuery.data?.files ?? [];
  const conversationTables = conversationQuery.data?.tables ?? [];
  const isFileConversation = conversation?.sourceKind === "file";
  const activeRunFromServer = conversationQuery.data?.activeRun ?? null;
  const datasource = datasourcesQuery.data?.datasources.find(
    (item) => item.id === conversation?.datasourceId,
  );

  const stream = useRunStream({ runId: activeRunId, conversationId: conversationId ?? null });

  const modelMutation = useMutation({
    mutationFn: (input: { id: string; modelId: string }) =>
      updateConversation(input.id, { modelId: input.modelId }),
    onSuccess: ({ conversation: updated }, input) => {
      queryClient.setQueryData<ConversationDetail>(
        queryKeys.conversation(input.id),
        (previous) => (previous ? { ...previous, conversation: updated } : previous),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });

  const thinkingMutation = useMutation({
    mutationFn: (input: { id: string; thinkingLevel: string }) =>
      updateConversation(input.id, { thinkingLevel: input.thinkingLevel }),
    onSuccess: ({ conversation: updated }, input) => {
      queryClient.setQueryData<ConversationDetail>(
        queryKeys.conversation(input.id),
        (previous) => (previous ? { ...previous, conversation: updated } : previous),
      );
    },
  });

  const startMutation = useMutation({
    mutationFn: async (input: {
      content: string;
      datasourceId: string;
      skill?: string;
      modelId?: string;
      thinkingLevel?: string;
    }) => {
      const { conversation: created } = await createConversation({
        datasourceId: input.datasourceId,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.thinkingLevel && input.thinkingLevel !== "off"
          ? { thinkingLevel: input.thinkingLevel }
          : {}),
      });
      try {
        const { runId } = await sendMessage(created.id, input.content, input.skill);
        return { conversationId: created.id, runId };
      } catch (error) {
        await deleteConversation(created.id).catch(() => undefined);
        throw error;
      }
    },
    onSuccess: ({ conversationId: createdId, runId }, input) => {
      setFailedSend(null);
      setDraftModelId(null);
      setDraftThinkingLevel("off");
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      navigate(`/chat/${createdId}`, {
        state: { pendingRun: { runId, content: input.content, skill: input.skill } },
      });
    },
    onError: (error, input) => {
      setFailedSend({ content: input.content, skill: input.skill });
      setSendError(errorMessage(error, "创建会话失败，请稍后重试"));
    },
  });

  const startFileMutation = useMutation({
    mutationFn: async (input: {
      content: string;
      files: File[];
      headerRows: Array<number | undefined>;
      skill?: string;
      modelId?: string;
      thinkingLevel?: string;
    }) => {
      const created = await createFileConversation({
        files: input.files,
        headerRows: input.headerRows,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.thinkingLevel && input.thinkingLevel !== "off"
          ? { thinkingLevel: input.thinkingLevel }
          : {}),
      });
      try {
        const { runId } = await sendMessage(created.conversation.id, input.content, input.skill);
        return { conversationId: created.conversation.id, runId };
      } catch (error) {
        await deleteConversation(created.conversation.id).catch(() => undefined);
        throw error;
      }
    },
    onSuccess: ({ conversationId: createdId, runId }, input) => {
      setFailedSend(null);
      setDraftModelId(null);
      setDraftThinkingLevel("off");
      previewSeqRef.current += 1;
      setDraftFiles([]);
      setDraftHeaderRows([]);
      setFilePreview(null);
      setFilePreviewError(null);
      setDraftMode("datasource");
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      navigate(`/chat/${createdId}`, {
        state: { pendingRun: { runId, content: input.content, skill: input.skill } },
      });
    },
    onError: (error, input) => {
      setFailedSend({ content: input.content, skill: input.skill });
      setSendError(errorMessage(error, "创建文件分析会话失败，请稍后重试"));
    },
  });

  const startDatasetMutation = useMutation({
    mutationFn: async (input: {
      content: string;
      datasetId: string;
      skill?: string;
      modelId?: string;
      thinkingLevel?: string;
    }) => {
      const created = await createConversationFromDataset({
        datasetId: input.datasetId,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.thinkingLevel && input.thinkingLevel !== "off"
          ? { thinkingLevel: input.thinkingLevel }
          : {}),
      });
      try {
        const { runId } = await sendMessage(created.conversation.id, input.content, input.skill);
        return { conversationId: created.conversation.id, runId };
      } catch (error) {
        await deleteConversation(created.conversation.id).catch(() => undefined);
        throw error;
      }
    },
    onSuccess: ({ conversationId: createdId, runId }, input) => {
      setFailedSend(null);
      setDraftModelId(null);
      setDraftThinkingLevel("off");
      setSelectedDatasetId(null);
      setDraftMode("datasource");
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      navigate(`/chat/${createdId}`, {
        state: { pendingRun: { runId, content: input.content, skill: input.skill } },
      });
    },
    onError: (error, input) => {
      setFailedSend({ content: input.content, skill: input.skill });
      setSendError(errorMessage(error, "使用数据集创建会话失败，请稍后重试"));
    },
  });

  const saveDatasetMutation = useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      saveConversationAsDataset(conversationId as string, input),
    onSuccess: ({ dataset }) => {
      setSavedDatasetName(dataset.name);
      void queryClient.invalidateQueries({ queryKey: queryKeys.fileDatasets });
    },
  });

  const deleteDatasetMutation = useMutation({
    mutationFn: (id: string) => deleteFileDataset(id),
    onSuccess: (_data, id) => {
      if (selectedDatasetId === id) setSelectedDatasetId(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.fileDatasets });
    },
  });

  const appendFilesMutation = useMutation({
    mutationFn: (files: File[]) =>
      appendConversationFiles(conversationId as string, { files }),
    onSuccess: ({ files, tables }) => {
      queryClient.setQueryData<ConversationDetail>(
        queryKeys.conversation(conversationId as string),
        (previous) => (previous ? { ...previous, files, tables } : previous),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversation(conversationId as string),
      });
    },
  });

  const sendMutation = useMutation({
    mutationFn: (input: { targetConversationId: string; content: string; skill?: string }) =>
      sendMessage(input.targetConversationId, input.content, input.skill),
    onSuccess: ({ runId }, input) => {
      setActiveTurn((prev) =>
        prev && prev.conversationId === input.targetConversationId
          ? { ...prev, runId }
          : {
              conversationId: input.targetConversationId,
              runId,
              optimisticText: input.content,
              optimisticSkill: input.skill ?? null,
            },
      );
      setFailedSend(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
    onError: (error, input) => {
      setActiveTurn((prev) =>
        prev && prev.conversationId === input.targetConversationId ? null : prev,
      );
      if (conversationId === input.targetConversationId) {
        setFailedSend({ content: input.content, skill: input.skill });
        setSendError(errorMessage(error, "发送失败，请稍后重试"));
      }
    },
  });

  const retryMutation = useMutation({
    mutationFn: async ({
      targetConversationId,
      message,
      modelId,
    }: {
      targetConversationId: string;
      message: ChatMessage;
      modelId?: string;
    }) => {
      if (modelId) {
        await updateConversation(targetConversationId, { modelId });
      }
      return retryRun(message.runId);
    },
    onMutate: ({ message }) => {
      setRetryingRunId(message.runId);
      setSendError(null);
    },
    onSuccess: ({ runId }, { targetConversationId, message }) => {
      setActiveTurn({
        conversationId: targetConversationId,
        runId,
        optimisticText: message.user.content,
        optimisticSkill: message.user.skill ?? null,
      });
      setRetryingRunId(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversation(targetConversationId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
    },
    onError: (error, { targetConversationId }) => {
      setRetryingRunId(null);
      if (conversationId === targetConversationId) {
        setSendError(errorMessage(error, "重试失败，请稍后重试"));
      }
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
    if (!activeRunPersisted || !conversationId) return;
    setActiveTurn((prev) => (prev && prev.conversationId === conversationId ? null : prev));
  }, [activeRunPersisted, conversationId]);

  useEffect(() => {
    setActiveTurn((prev) =>
      prev && conversationId && prev.conversationId === conversationId ? prev : null,
    );
    setSendError(null);
    setFailedSend(null);
    setFileTablesOpen(false);
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
    setActiveTurn({
      conversationId,
      runId: pending.runId,
      optimisticText: pending.content,
      optimisticSkill: pending.skill ?? null,
    });
    navigate(location.pathname, { replace: true, state: null });
  }, [conversationId, location.pathname, location.state, navigate]);

  const availableDatasources = useMemo(
    () => datasourcesQuery.data?.datasources ?? [],
    [datasourcesQuery.data],
  );
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
    if (activeRunId || !activeRunFromServer || !conversationId) return;
    const alreadyFinished = messages?.some(
      (message) =>
        message.runId === activeRunFromServer.id &&
        message.status !== "queued" &&
        message.status !== "running",
    );
    if (!alreadyFinished) {
      setActiveTurn({
        conversationId,
        runId: activeRunFromServer.id,
        optimisticText: null,
        optimisticSkill: null,
      });
    }
  }, [activeRunId, activeRunFromServer, conversationId, messages]);

  const runFilePreview = async (
    nextFiles: File[],
    nextHeaderRows: Array<number | undefined>,
  ) => {
    const seq = ++previewSeqRef.current;
    if (nextFiles.length === 0) {
      setFilePreview(null);
      setFilePreviewLoading(false);
      setFilePreviewError(null);
      return;
    }
    if (nextFiles.length > 5) {
      setFilePreview(null);
      setFilePreviewLoading(false);
      setFilePreviewError("单次最多上传 5 个文件，请先移除多余文件");
      return;
    }
    setFilePreviewLoading(true);
    setFilePreviewError(null);
    try {
      const response = await previewUploadedFiles({
        files: nextFiles,
        headerRows: nextHeaderRows,
      });
      if (seq !== previewSeqRef.current) return;
      setFilePreview(response);
      setFilePreviewError(null);
    } catch (error) {
      if (seq !== previewSeqRef.current) return;
      setFilePreview(null);
      setFilePreviewError(errorMessage(error, "文件解析失败，请检查文件格式"));
    } finally {
      if (seq === previewSeqRef.current) {
        setFilePreviewLoading(false);
      }
    }
  };

  const handleAddDraftFiles = (incoming: File[]) => {
    setSelectedDatasetId(null);
    const nextFiles = [...draftFiles, ...incoming];
    const nextHeaderRows = [...draftHeaderRows, ...incoming.map(() => undefined)];
    setDraftFiles(nextFiles);
    setDraftHeaderRows(nextHeaderRows);
    void runFilePreview(nextFiles, nextHeaderRows);
  };

  const handleRemoveDraftFile = (index: number) => {
    const nextFiles = draftFiles.filter((_, idx) => idx !== index);
    const nextHeaderRows = draftHeaderRows.filter((_, idx) => idx !== index);
    setDraftFiles(nextFiles);
    setDraftHeaderRows(nextHeaderRows);
    void runFilePreview(nextFiles, nextHeaderRows);
  };

  const handleHeaderRowChange = (index: number, headerRow: number | undefined) => {
    const nextHeaderRows = draftHeaderRows.map((value, idx) =>
      idx === index ? headerRow : value,
    );
    setDraftHeaderRows(nextHeaderRows);
    void runFilePreview(draftFiles, nextHeaderRows);
  };

  const handleClearDraftFiles = () => {
    previewSeqRef.current += 1;
    setDraftFiles([]);
    setDraftHeaderRows([]);
    setFilePreview(null);
    setFilePreviewLoading(false);
    setFilePreviewError(null);
  };

  const handleSelectDataset = (datasetId: string | null) => {
    setSelectedDatasetId(datasetId);
    if (datasetId) {
      previewSeqRef.current += 1;
      setDraftFiles([]);
      setDraftHeaderRows([]);
      setFilePreview(null);
      setFilePreviewLoading(false);
      setFilePreviewError(null);
    }
  };

  const handleSend = async (content: string, skill?: string) => {
    if (!canUseChat) return;
    if (!conversationId) {
      if (draftMode === "file") {
        if (selectedDatasetId) {
          if (modelsStatus !== "ready" || modelCount === 0) {
            setSendError("模型服务尚未就绪，请稍后重试");
            return;
          }
          setSendError(null);
          await startDatasetMutation.mutateAsync({
            content,
            datasetId: selectedDatasetId,
            skill,
            ...(draftModelId ? { modelId: draftModelId } : {}),
            thinkingLevel: draftThinkingLevel,
          });
          return;
        }
        if (
          draftFiles.length === 0 ||
          filePreviewLoading ||
          !filePreview ||
          filePreview.totalTables === 0
        ) {
          setSendError("请先上传并完成文件解析，或选择一个已保存的数据集");
          return;
        }
        if (modelsStatus !== "ready" || modelCount === 0) {
          setSendError("模型服务尚未就绪，请稍后重试");
          return;
        }
        setSendError(null);
        await startFileMutation.mutateAsync({
          content,
          files: draftFiles,
          headerRows: draftHeaderRows,
          skill,
          ...(draftModelId ? { modelId: draftModelId } : {}),
          thinkingLevel: draftThinkingLevel,
        });
        return;
      }
      if (!draftDatasourceId) {
        setSendError("请先选择一个数据源");
        return;
      }
      if (modelsStatus !== "ready" || modelCount === 0) {
        setSendError("模型服务尚未就绪，请稍后重试");
        return;
      }
      setSendError(null);
      await startMutation.mutateAsync({
        content,
        datasourceId: draftDatasourceId,
        skill,
        ...(draftModelId ? { modelId: draftModelId } : {}),
        thinkingLevel: draftThinkingLevel,
      });
      return;
    }
    setSendError(null);
    setActiveTurn({
      conversationId,
      runId: null,
      optimisticText: content,
      optimisticSkill: skill ?? null,
    });
    await sendMutation.mutateAsync(
      skill
        ? { targetConversationId: conversationId, content, skill }
        : { targetConversationId: conversationId, content },
    );
  };

  const handleRetry = (message: ChatMessage, modelId?: string) => {
    if (!canUseChat || !conversationId) return;
    retryMutation.mutate(
      modelId
        ? { targetConversationId: conversationId, message, modelId }
        : { targetConversationId: conversationId, message },
    );
  };

  const handleExample = canUseChat
    ? (content: string) => void handleSend(content)
    : undefined;

  const sendingForCurrent =
    sendMutation.isPending && sendMutation.variables?.targetConversationId === conversationId;
  const startingNew =
    !conversationId &&
    (startMutation.isPending || startFileMutation.isPending || startDatasetMutation.isPending);
  const showStream = !activeRunPersisted && (activeRunId !== null || optimisticText !== null);
  const active = sendingForCurrent || startingNew || stream.active;
  const models = modelsQuery.data;
  const modelCount = models?.models.length ?? 0;
  const modelsStatus: ModelPickerStatus = modelsQuery.isPending
    ? "loading"
    : modelsQuery.isError
      ? "error"
      : "ready";
  const latestMessage =
    conversationId && messages && messages.length > 0
      ? messages[messages.length - 1]
      : null;
  const latestSuggestionRunId = latestMessage?.runId ?? "";
  const turnSettled =
    !active && !showStream && !retryingRunId && stream.state.questions.length === 0;
  const shouldFetchSuggestions = Boolean(
    conversationId &&
      canUseChat &&
      turnSettled &&
      latestMessage &&
      latestMessage.status === "ok" &&
      latestMessage.suggestions === null &&
      modelsStatus === "ready" &&
      modelCount > 0,
  );
  const suggestionsQuery = useQuery({
    queryKey: queryKeys.runSuggestions(latestSuggestionRunId),
    queryFn: () => getRunSuggestions(latestSuggestionRunId),
    enabled: shouldFetchSuggestions,
    staleTime: Infinity,
    retry: false,
  });
  const visibleSuggestions =
    conversationId &&
    canUseChat &&
    turnSettled &&
    latestMessage &&
    latestMessage.status === "ok" &&
    dismissedSuggestionRunId !== latestMessage.runId
      ? (latestMessage.suggestions ?? suggestionsQuery.data?.suggestions ?? [])
      : [];

  const user = meQuery.data?.user;
  if (!user) {
    return <PageSpinner />;
  }

  const savedDatasets = fileDatasetsQuery.data?.datasets ?? [];
  const fileReady = Boolean(
    (selectedDatasetId && savedDatasets.some((item) => item.id === selectedDatasetId)) ||
      (filePreview && filePreview.totalTables > 0 && !filePreviewLoading),
  );
  const currentModelId = conversation
    ? (conversation.modelId ?? models?.defaultId ?? "")
    : (draftModelId ?? models?.defaultId ?? "");
  const currentThinkingLevel = conversation
    ? (conversation.thinkingLevel ?? "off")
    : draftThinkingLevel;
  const selectedModel = models?.models.find((model) => model.id === currentModelId);
  const statusIndicator: AppShellStatusIndicator | null =
    stream.state.connection === "reconnecting"
      ? { tone: "warning", label: "重连中…" }
      : active
        ? { tone: "busy", label: "生成中…" }
        : modelsStatus === "error"
          ? { tone: "error", label: "模型异常" }
          : null;
  const contextUsage = applyContextWindow(
    stream.state.contextUsage ?? conversationQuery.data?.contextUsage ?? null,
    selectedModel?.contextWindow,
  );
  const handleExportMarkdown = () => {
    if (!conversationId || !conversation || !messages || messages.length === 0) return;
    const title = conversation.title ?? "未命名会话";
    const sourceLabel = isFileConversation
      ? `Excel / CSV（${conversationTables.length} 张表）`
      : datasource
        ? `${datasource.name} · ${datasource.type === "mysql" ? "MySQL" : "PostgreSQL"}`
        : null;
    const markdown = buildConversationMarkdown({
      title,
      sourceLabel,
      messages,
      artifacts: conversationQuery.data?.artifacts ?? [],
    });
    downloadTextFile(
      sanitizeFileName(title, "datachat-conversation", "md"),
      markdown,
      "text/markdown;charset=utf-8",
    );
  };

  const topbar = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-ink">
          {conversation?.title ?? (conversationId ? "未命名会话" : "新对话")}
        </span>
        {isFileConversation ? (
          <button
            type="button"
            onClick={() => {
              appendFilesMutation.reset();
              saveDatasetMutation.reset();
              setSavedDatasetName(null);
              setFileTablesOpen(true);
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded bg-subtle px-2 py-0.5 text-[11px] text-inksoft transition-colors hover:bg-line"
          >
            <FileSpreadsheet className="h-3 w-3 text-brand" />
            <span>Excel / CSV · {conversationTables.length} 张表</span>
          </button>
        ) : datasource ? (
          <span className="hidden shrink-0 rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted sm:inline">
            {datasource.name} · {datasource.type === "mysql" ? "MySQL" : "PostgreSQL"}
          </span>
        ) : null}
        {!isFileConversation && (meQuery.data?.departmentNames ?? []).length > 0 ? (
          <span
            className="hidden shrink-0 rounded bg-brandsoft px-1.5 py-0.5 text-[11px] text-brandtext sm:inline"
            title="查询结果按这些部门的子树过滤"
          >
            范围：{(meQuery.data?.departmentNames ?? []).join("、")}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={!conversationId || !conversation || !messages || messages.length === 0}
          onClick={handleExportMarkdown}
        >
          <Download className="h-3.5 w-3.5" />
          导出
        </Button>
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
        key="messages-new"
        conversationId={null}
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
        newChatMode={draftMode}
        onNewChatModeChange={setDraftMode}
        fileReady={fileReady}
        fileUploadProps={{
          files: draftFiles,
          headerRows: draftHeaderRows,
          preview: filePreview,
          previewLoading: filePreviewLoading,
          previewError: filePreviewError,
          disabled: startFileMutation.isPending || startDatasetMutation.isPending,
          savedDatasets,
          selectedDatasetId,
          deletingDatasetId: deleteDatasetMutation.isPending
            ? (deleteDatasetMutation.variables ?? null)
            : null,
          onAddFiles: handleAddDraftFiles,
          onRemoveFile: handleRemoveDraftFile,
          onHeaderRowChange: handleHeaderRowChange,
          onClearAll: handleClearDraftFiles,
          onSelectDataset: handleSelectDataset,
          onDeleteDataset: (id) => deleteDatasetMutation.mutate(id),
        }}
        onExample={handleExample}
        starting={
          startMutation.isPending || startFileMutation.isPending || startDatasetMutation.isPending
        }
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
        key={`messages-${conversationId}`}
        conversationId={conversationId}
        messages={messages ?? []}
        artifacts={conversationQuery.data?.artifacts ?? []}
        stream={stream.state}
        showStream={showStream}
        optimisticText={optimisticText}
        optimisticSkill={optimisticSkill}
        onCreateReport={handleCreateReport}
        creatingReport={reportMutation.isPending}
        activeRunId={activeRunId}
        models={models?.models ?? []}
        retryingRunId={retryingRunId}
        onRetry={handleRetry}
        onEditResend={
          canUseChat
            ? (nextContent, skill) =>
                void handleSend(nextContent, canUseSkills ? (skill ?? undefined) : undefined)
            : undefined
        }
        editDisabled={active || showStream || Boolean(retryingRunId)}
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
        conversationSourceKind={isFileConversation ? "file" : "datasource"}
        conversationFiles={conversationFiles}
        conversationTables={conversationTables}
        onOpenFileTables={
          isFileConversation
            ? () => {
                appendFilesMutation.reset();
                saveDatasetMutation.reset();
                setSavedDatasetName(null);
                setFileTablesOpen(true);
              }
            : undefined
        }
        onExample={handleExample}
        starting={sendMutation.isPending}
        isAdmin={user.role === "admin"}
        canExport={canExport}
      />
    );
  }

  return (
    <AppShell
      user={user}
      sidebar={<ConversationSidebar activeId={conversationId} datasources={availableDatasources} />}
      topbar={topbar}
      statusIndicator={statusIndicator}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {content}
        {sendError ? (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              <span className="min-w-0 flex-1">{sendError}</span>
              <div className="flex shrink-0 items-center gap-1">
                {failedSend ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    disabled={
                      sendMutation.isPending ||
                      startMutation.isPending ||
                      startFileMutation.isPending ||
                      startDatasetMutation.isPending
                    }
                    onClick={() => void handleSend(failedSend.content, failedSend.skill)}
                  >
                    重新发送
                  </Button>
                ) : null}
                <button
                  type="button"
                  aria-label="关闭错误提示"
                  className="rounded p-1 text-danger/70 transition-colors hover:bg-danger/10 hover:text-danger"
                  onClick={() => {
                    setSendError(null);
                    setFailedSend(null);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
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
        <SuggestedQuestions
          suggestions={visibleSuggestions}
          disabled={active}
          onSelect={(question) => void handleSend(question)}
          onDismiss={() => {
            if (latestMessage) setDismissedSuggestionRunId(latestMessage.runId);
          }}
        />
        <Composer
          key={`composer-${conversationId ?? "new"}`}
          conversationReady={
            conversationId
              ? Boolean(conversation)
              : (draftMode === "file" ? fileReady : Boolean(draftDatasourceId)) &&
                modelsStatus === "ready" &&
                modelCount > 0
          }
          active={active}
          canStop={activeRunId !== null}
          models={models?.models ?? []}
          modelId={currentModelId}
          modelsStatus={modelsStatus}
          modelPickerDisabled={
            modelsQuery.isPending ||
            modelMutation.isPending ||
            thinkingMutation.isPending ||
            (Boolean(conversationId) && !conversation) ||
            !canUseChat
          }
          thinkingLevel={currentThinkingLevel}
          skills={canUseSkills ? skillsQuery.data?.skills ?? [] : []}
          readOnlyReason={canUseChat ? undefined : "当前角色没有对话权限，请联系管理员"}
          contextUsage={contextUsage}
          onModelChange={(id) =>
            conversationId
              ? modelMutation.mutate({ id: conversationId, modelId: id })
              : setDraftModelId(id)
          }
          onThinkingChange={(level) =>
            conversationId
              ? thinkingMutation.mutate({ id: conversationId, thinkingLevel: level })
              : setDraftThinkingLevel(level)
          }
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
      {conversationId && isFileConversation ? (
        <FileTablesDialog
          open={fileTablesOpen}
          files={conversationFiles}
          tables={conversationTables}
          defaultDatasetName={conversation?.title ?? ""}
          busy={active}
          appending={appendFilesMutation.isPending}
          appendError={
            appendFilesMutation.error
              ? errorMessage(appendFilesMutation.error, "追加文件失败，请稍后重试")
              : null
          }
          savingDataset={saveDatasetMutation.isPending}
          saveDatasetError={
            saveDatasetMutation.error
              ? errorMessage(saveDatasetMutation.error, "保存数据集失败，请稍后重试")
              : null
          }
          savedDatasetName={savedDatasetName}
          onClose={() => setFileTablesOpen(false)}
          onAppendFiles={
            canUseChat
              ? (files) => appendFilesMutation.mutate(files)
              : undefined
          }
          onSaveDataset={
            canUseChat
              ? (input) => {
                  setSavedDatasetName(null);
                  saveDatasetMutation.mutate(input);
                }
              : undefined
          }
        />
      ) : null}
    </AppShell>
  );
}
