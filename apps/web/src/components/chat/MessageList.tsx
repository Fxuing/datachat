import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, Bot, Database, FileSpreadsheet, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import {
  datasourceTypeLabel,
  type ChatArtifact,
  type ChatMessage,
  type ChatModelInfo,
  type ConversationFileSummary,
  type ConversationFileTableSummary,
  type DatasourceSummary,
} from "../../lib/api";
import type { RunStreamState } from "../../lib/run-events";
import { PageSpinner } from "../ui/spinner";
import { Button } from "../ui/button";
import { BrandMark } from "../BrandMark";
import { ChartCard, chartOptionFromSpec } from "./ChartCard";
import { FileUploadPanel, type FileUploadPanelProps } from "./FileUploadPanel";
import { MarkdownText, MessageItem, UserBubble } from "./MessageItem";
import { RunStatus } from "./RunStatus";
import { TurnTrace } from "./TurnTrace";
import { TurnFooter } from "./TurnFooter";
import { ConversationMinimap } from "./ConversationMinimap";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ResultCard } from "./ResultCard";
import { ResultLinkGroup } from "./ResultLink";
import {
  groupChatSegments,
  parseChatMarkdown,
  reportArtifactIdsFromTools,
} from "../../lib/report-markdown";
import { pairQueries } from "../../lib/pair-queries";
import type { ModelPickerStatus } from "./ModelPicker";
import { cn } from "../../lib/utils";
import { isNearBottom, readScrollPosition, writeScrollPosition, type StoredScrollPosition } from "../../lib/message-scroll";

export interface MessageListProps {
  /** Conversation whose reading position is persisted; null for a new chat. */
  conversationId?: string | null;
  messages: ChatMessage[];
  stream: RunStreamState;
  showStream: boolean;
  optimisticText: string | null;
  optimisticSkill?: string | null;
  loading?: boolean;
  /** Conversation artifacts, used to restore charts for persisted runs. */
  artifacts?: ChatArtifact[];
  /** Turns a result artifact into a report and opens it. */
  onCreateReport?: (artifactId: string) => void;
  /** Disables report creation while a report mutation is running. */
  creatingReport?: boolean;
  /** The run currently streaming, if any (enables feedback once it ends). */
  activeRunId?: string | null;
  /** Models available for retrying a failed turn on another model. */
  models?: ChatModelInfo[];
  /** Run id currently being retried, used to disable its actions. */
  retryingRunId?: string | null;
  onRetry?: (message: ChatMessage, modelId?: string) => void;
  /** Re-submits an edited historical prompt in the active conversation. */
  onEditResend?: (content: string, skill?: string | null) => void;
  /** Disables prompt editing while a run is streaming or mutating. */
  editDisabled?: boolean;
  /** Pins a chart artifact onto a user dashboard. */
  onPinChart?: (artifact: ChatArtifact, title: string) => void;
  /** Datasources offered on the empty state so a new chat can start in place. */
  datasources?: DatasourceSummary[];
  datasourcesLoading?: boolean;
  datasourcesError?: string | null;
  onRetryDatasources?: () => void;
  modelsStatus?: ModelPickerStatus;
  modelsCount?: number;
  onRetryModels?: () => void;
  selectedDatasourceId?: string | null;
  onSelectDatasource?: (id: string) => void;
  newChatMode?: "datasource" | "file";
  onNewChatModeChange?: (mode: "datasource" | "file") => void;
  fileUploadProps?: FileUploadPanelProps;
  fileReady?: boolean;
  conversationSourceKind?: "datasource" | "file";
  conversationFiles?: ConversationFileSummary[];
  conversationTables?: ConversationFileTableSummary[];
  onOpenFileTables?: () => void;
  /** Set for an existing conversation: its datasource cannot be changed. */
  datasourceLocked?: boolean;
  boundDatasource?: DatasourceSummary | null;
  onExample?: (content: string) => void;
  starting?: boolean;
  isAdmin?: boolean;
  /** Downloads are disabled when the user lacks `export.data`. */
  canExport?: boolean;
}

function AssistantHeader() {
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-line text-muted">
        <Bot className="h-3.5 w-3.5" />
      </span>
      DataChat
    </div>
  );
}

const examples = [
  {
    title: "先了解数据结构",
    body: "这个库有哪些表？分别做什么？",
  },
  {
    title: "抽查几张表",
    body: "找出数据量最大的 3 张表，各看 5 行样例",
  },
  {
    title: "做一个趋势分析",
    body: "选一个关键指标，看看最近 12 个月的趋势",
  },
];

const fileExamples = [
  {
    title: "先了解文件数据结构",
    body: "这些表里有哪些字段？数据大致是什么情况？",
  },
  {
    title: "统计汇总与排名",
    body: "按核心维度汇总统计金额和数量，列出前 10 名",
  },
  {
    title: "发现异常与趋势",
    body: "检查数据里有没有异常值、空值，并分析关键变化趋势",
  },
];

function EmptyChat({
  datasources = [],
  datasourcesLoading = false,
  datasourcesError = null,
  onRetryDatasources,
  modelsStatus = "ready",
  modelsCount = 0,
  onRetryModels,
  selectedDatasourceId = null,
  onSelectDatasource,
  newChatMode = "datasource",
  onNewChatModeChange,
  fileUploadProps,
  fileReady = false,
  conversationSourceKind = "datasource",
  conversationFiles = [],
  conversationTables = [],
  onOpenFileTables,
  datasourceLocked = false,
  boundDatasource = null,
  onExample,
  starting = false,
  isAdmin = false,
}: {
  datasources?: DatasourceSummary[];
  datasourcesLoading?: boolean;
  datasourcesError?: string | null;
  onRetryDatasources?: () => void;
  modelsStatus?: ModelPickerStatus;
  modelsCount?: number;
  onRetryModels?: () => void;
  selectedDatasourceId?: string | null;
  onSelectDatasource?: (id: string) => void;
  newChatMode?: "datasource" | "file";
  onNewChatModeChange?: (mode: "datasource" | "file") => void;
  fileUploadProps?: FileUploadPanelProps;
  fileReady?: boolean;
  conversationSourceKind?: "datasource" | "file";
  conversationFiles?: ConversationFileSummary[];
  conversationTables?: ConversationFileTableSummary[];
  onOpenFileTables?: () => void;
  datasourceLocked?: boolean;
  boundDatasource?: DatasourceSummary | null;
  onExample?: (content: string) => void;
  starting?: boolean;
  isAdmin?: boolean;
}) {
  const isFileMode = datasourceLocked
    ? conversationSourceKind === "file"
    : newChatMode === "file";
  const activeDatasourceId = datasourceLocked ? boundDatasource?.id : selectedDatasourceId;
  const canStart =
    (isFileMode ? datasourceLocked || fileReady : Boolean(activeDatasourceId)) &&
    modelsStatus === "ready" &&
    modelsCount > 0 &&
    !starting;
  const visibleExamples = isFileMode ? fileExamples : examples;

  return (
    <div className="flex flex-col items-center justify-center gap-5 py-8 text-center">
      <div className="relative">
        <span className="absolute inset-0 -z-10 rounded-full bg-brand/20 blur-2xl" />
        <BrandMark size={60} className="rounded-[14px] shadow-card" />
      </div>
      <div>
        <p className="text-lg font-semibold tracking-tight text-ink">
          {datasourceLocked ? "开始提问" : "开始新的对话"}
        </p>
        <p className="mt-1.5 text-sm text-muted">
          {datasourceLocked
            ? isFileMode
              ? "已导入上传文件数据，直接提问或用下面的示例开始"
              : "直接提问或用下面的示例开始"
            : isFileMode
              ? "上传 Excel / CSV 文件，解析完成后直接提问或用下面的示例开始"
              : "选择一个数据源，然后直接提问或用下面的示例开始"}
        </p>
      </div>

      {!datasourceLocked && onNewChatModeChange ? (
        <div
          role="tablist"
          aria-label="分析模式"
          className="inline-flex rounded-lg border border-line bg-subtle/60 p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={newChatMode === "datasource"}
            disabled={starting}
            onClick={() => onNewChatModeChange("datasource")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              newChatMode === "datasource"
                ? "bg-surface text-ink shadow-card"
                : "text-muted hover:text-ink",
            )}
          >
            <Database className="h-3.5 w-3.5" />
            数据库分析
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={newChatMode === "file"}
            disabled={starting}
            onClick={() => onNewChatModeChange("file")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              newChatMode === "file"
                ? "bg-surface text-ink shadow-card"
                : "text-muted hover:text-ink",
            )}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Excel / CSV 文件
          </button>
        </div>
      ) : null}

      {!datasourceLocked && newChatMode === "file" && fileUploadProps ? (
        <FileUploadPanel {...fileUploadProps} disabled={fileUploadProps.disabled || starting} />
      ) : null}

      {!datasourceLocked && newChatMode === "datasource" ? (
        <div className="w-full max-w-md text-left">
          <div className="mb-1.5">
            <label className="text-[11px] font-medium text-inksoft">数据源</label>
          </div>
          {datasourcesError ? (
            <div className="rounded-lg border border-danger/20 bg-dangersoft px-4 py-3 text-left">
              <p className="text-xs font-medium text-danger">数据源加载失败</p>
              <p className="mt-1 text-[11px] leading-5 text-danger/80">{datasourcesError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 h-7"
                onClick={onRetryDatasources}
              >
                重试
              </Button>
            </div>
          ) : datasourcesLoading ? (
            <div className="flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在加载数据源…
            </div>
          ) : datasources.length > 0 ? (
            <Select
              value={selectedDatasourceId ?? ""}
              onValueChange={onSelectDatasource}
              disabled={starting}
            >
              <SelectTrigger aria-label="选择数据源" className="h-10 bg-surface">
                <SelectValue placeholder="选择一个数据源" />
              </SelectTrigger>
              <SelectContent>
                {datasources.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · {datasourceTypeLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="rounded-lg border border-dashed border-line bg-subtle/40 px-4 py-3 text-left">
              <p className="text-xs font-medium text-ink">还没有可用的数据源</p>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                请联系管理员完成数据库连接配置并授权给你。
              </p>
              {isAdmin ? (
                <Link
                  to="/admin/datasources"
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
                >
                  去添加数据源
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {datasourceLocked && isFileMode && onOpenFileTables ? (
        <button
          type="button"
          onClick={onOpenFileTables}
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-inksoft shadow-card transition-colors hover:border-brand/40 hover:text-ink"
        >
          <FileSpreadsheet className="h-4 w-4 text-brand" />
          <span>
            已载入 {conversationFiles.length} 个文件 · {conversationTables.length} 张表（点击查看结构或追加文件）
          </span>
        </button>
      ) : null}

      {modelsStatus !== "ready" || modelsCount === 0 ? (
        <div className="w-full max-w-md rounded-lg border border-line bg-subtle/40 px-4 py-3 text-left">
          {modelsStatus === "loading" ? (
            <p className="flex items-center gap-2 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在加载模型服务…
            </p>
          ) : modelsStatus === "error" ? (
            <>
              <p className="text-xs font-medium text-danger">模型列表加载失败</p>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                无法确认模型服务是否可用，请重试。
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 h-7"
                onClick={onRetryModels}
              >
                重试
              </Button>
            </>
          ) : (
            <>
              <p className="text-xs font-medium text-ink">尚未配置模型服务</p>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                {isAdmin
                  ? "请先在「设置 → 模型服务」添加一个可用的模型服务。"
                  : "请联系管理员配置模型服务后再开始提问。"}
              </p>
              {isAdmin ? (
                <Link
                  to="/admin/settings"
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
                >
                  去配置模型服务
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-3">
        {visibleExamples.map((example) => (
          <button
            key={example.title}
            type="button"
            disabled={!canStart || !onExample}
            onClick={() => onExample?.(example.body)}
            className="group rounded-xl border border-line bg-surface/70 p-3 text-left shadow-card transition-colors hover:border-brand/40 hover:bg-surface disabled:cursor-not-allowed disabled:opacity-55"
          >
            <p className="flex items-center justify-between gap-2 text-[12px] font-medium text-inksoft">
              {example.title}
              <ArrowUpRight className="h-3.5 w-3.5 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
            </p>
            <p className="mt-1 text-[11px] leading-5 text-muted">{example.body}</p>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted/80">
        {starting
          ? datasourceLocked
            ? "正在发送…"
            : "正在创建会话…"
          : "点击示例会直接开始对话，也可以在下方输入框提问"}
      </p>
    </div>
  );
}

export function MessageList({
  conversationId = null,
  messages,
  stream,
  showStream,
  optimisticText,
  optimisticSkill = null,
  loading = false,
  artifacts = [],
  onCreateReport,
  creatingReport = false,
  activeRunId = null,
  models = [],
  retryingRunId = null,
  onRetry,
  onEditResend,
  editDisabled = false,
  onPinChart,
  datasources = [],
  datasourcesLoading = false,
  datasourcesError = null,
  onRetryDatasources,
  modelsStatus = "ready",
  modelsCount = 0,
  onRetryModels,
  selectedDatasourceId = null,
  onSelectDatasource,
  newChatMode = "datasource",
  onNewChatModeChange,
  fileUploadProps,
  fileReady = false,
  conversationSourceKind = "datasource",
  conversationFiles = [],
  conversationTables = [],
  onOpenFileTables,
  datasourceLocked = false,
  boundDatasource = null,
  onExample,
  starting = false,
  isAdmin = false,
  canExport = true,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const scrollInitialized = useRef(false);
  const saveFrame = useRef<number | null>(null);
  const lastPosition = useRef<StoredScrollPosition>({ scrollTop: 0, atBottom: true });
  const [showJump, setShowJump] = useState(false);
  const [hasNewContent, setHasNewContent] = useState(false);
  // While a run is streaming, its persisted group can already be in the history
  // (the page fetched the conversation right after navigating from the empty
  // state). Render the live block instead of both it and the persisted copy.
  const visibleMessages =
    showStream && activeRunId
      ? messages.filter((message) => message.runId !== activeRunId)
      : messages;
  const hasContent = visibleMessages.length > 0 || showStream;
  const streamSegments = parseChatMarkdown(stream.text);
  const groupedStreamSegments = groupChatSegments(streamSegments);
  const disambiguateStreamResults =
    streamSegments.filter((segment) => segment.type === "result").length >= 2;
  const referencedCharts = new Set(
    streamSegments
      .filter((segment) => segment.type === "chart")
      .map((segment) => segment.artifactId),
  );
  const streamReportArtifacts = reportArtifactIdsFromTools(stream.tools);
  const standaloneCharts = stream.charts.filter(
    (chart) =>
      !referencedCharts.has(chart.chartArtifactId) &&
      !streamReportArtifacts.has(chart.chartArtifactId),
  );
  // Results already rendered inline at their `[[artifact:…]]` or chat-only
  // `[[result:…]]` placeholder must not show up a second time inside the trace.
  const inlineResults = new Set(
    streamSegments
      .filter((segment) => segment.type === "artifact" || segment.type === "result")
      .map((segment) => segment.artifactId),
  );
  const standaloneResults = stream.results.filter(
    (item) => !inlineResults.has(item.artifactId),
  );
  const { pairs: queryPairs, unmatched: unmatchedResults } = pairQueries(
    stream.sqls,
    standaloneResults,
  );
  const hasTrace =
    stream.thinkingSegments.some((segment) => segment.trim()) ||
    stream.memories.length > 0 ||
    stream.tools.length > 0 ||
    stream.sqls.length > 0;
  // Charts only settle into their final place once the run finishes. Rendering
  // them mid-stream makes them jump from the fallback slot into an inline
  // placeholder as soon as the model writes it.
  const chartsReady = stream.status === "ok" || stream.status === "error";

  // Reset the per-conversation scroll state. ChatPage remounts this component
  // on route changes, but keeping the reset here also makes a reused instance
  // safe when the conversation id changes.
  useEffect(() => {
    scrollInitialized.current = false;
    stickToBottom.current = true;
    setShowJump(false);
    setHasNewContent(false);
  }, [conversationId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let prevHeight = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = element.clientHeight;
      if (nextHeight !== prevHeight) {
        prevHeight = nextHeight;
        if (stickToBottom.current) {
          element.scrollTop = element.scrollHeight;
          setShowJump(false);
        }
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onScroll = () => {
      if (!scrollInitialized.current) return;
      const nearBottom = isNearBottom(element);
      stickToBottom.current = nearBottom;
      lastPosition.current = { scrollTop: element.scrollTop, atBottom: nearBottom };
      setShowJump(!nearBottom);
      if (nearBottom) setHasNewContent(false);
      if (!conversationId) return;
      if (saveFrame.current !== null) cancelAnimationFrame(saveFrame.current);
      saveFrame.current = requestAnimationFrame(() => {
        writeScrollPosition(conversationId, lastPosition.current);
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (saveFrame.current !== null) cancelAnimationFrame(saveFrame.current);
      if (conversationId && scrollInitialized.current) {
        writeScrollPosition(conversationId, lastPosition.current);
      }
    };
  }, [conversationId]);

  // Restore a reading position when coming back to a conversation. A position
  // that was at the bottom means the user was following live output, so stay
  // pinned after the history renders. A new chat always starts at the bottom.
  useEffect(() => {
    if (scrollInitialized.current || loading) return;
    const element = containerRef.current;
    if (!element) return;
    scrollInitialized.current = true;
    const saved = conversationId ? readScrollPosition(conversationId) : null;
    if (saved && !saved.atBottom) {
      element.scrollTop = saved.scrollTop;
      lastPosition.current = saved;
      stickToBottom.current = false;
      setShowJump(true);
      return;
    }
    element.scrollTop = element.scrollHeight;
    lastPosition.current = { scrollTop: element.scrollTop, atBottom: true };
    stickToBottom.current = true;
    setShowJump(false);
  }, [conversationId, loading, messages.length]);

  // Sending always brings the new question into view, even if the reader had
  // scrolled up in the previous turn.
  useEffect(() => {
    if (!optimisticText) return;
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    lastPosition.current = { scrollTop: element.scrollTop, atBottom: true };
    stickToBottom.current = true;
    setShowJump(false);
    setHasNewContent(false);
  }, [optimisticText]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let prevHeight = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = element.clientHeight;
      if (nextHeight !== prevHeight) {
        prevHeight = nextHeight;
        if (stickToBottom.current) {
          element.scrollTop = element.scrollHeight;
          setShowJump(false);
        }
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
      setShowJump(false);
      setHasNewContent(false);
      return;
    }
    // Only live output makes the off-screen button mean "new content";
    // refetches of history must not.
    if (stream.status === "running" || optimisticText) setHasNewContent(true);
  }, [
    messages.length,
    optimisticText,
    stream.text,
    stream.thinkingSegments,
    stream.status,
    stream.tools.length,
    stream.sqls.length,
    stream.results.length,
    stream.charts.length,
  ]);

  if (loading && !hasContent) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PageSpinner label="加载会话…" />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        data-testid="message-scroll"
        className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(ellipse_60%_40%_at_50%_0%,rgb(var(--brand)/0.06),transparent_70%)]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {!hasContent ? (
          <EmptyChat
            datasources={datasources}
            datasourcesLoading={datasourcesLoading}
            datasourcesError={datasourcesError}
            onRetryDatasources={onRetryDatasources}
            modelsStatus={modelsStatus}
            modelsCount={modelsCount}
            onRetryModels={onRetryModels}
            selectedDatasourceId={selectedDatasourceId}
            onSelectDatasource={onSelectDatasource}
            newChatMode={newChatMode}
            onNewChatModeChange={onNewChatModeChange}
            fileUploadProps={fileUploadProps}
            fileReady={fileReady}
            conversationSourceKind={conversationSourceKind}
            conversationFiles={conversationFiles}
            conversationTables={conversationTables}
            onOpenFileTables={onOpenFileTables}
            datasourceLocked={datasourceLocked}
            boundDatasource={boundDatasource}
            onExample={onExample}
            starting={starting}
            isAdmin={isAdmin}
          />
        ) : null}

        {visibleMessages.map((message) => (
          <div key={message.runId} id={`turn-${message.runId}`}>
            <MessageItem
              message={message}
              artifacts={artifacts}
              models={models}
              retrying={retryingRunId === message.runId}
              creatingReport={creatingReport}
              onCreateReport={onCreateReport}
              canExport={canExport}
              onRetry={onRetry}
              onEditResend={onEditResend}
              editDisabled={editDisabled}
              onPinChart={onPinChart}
            />
          </div>
        ))}

        {showStream ? (
          <div className="group/turn flex flex-col gap-3">
            {optimisticText ? (
              <UserBubble
                content={optimisticText}
                skill={optimisticSkill}
                pending={stream.status === "idle" || stream.status === "queued"}
              />
            ) : null}
            <div className="flex flex-col gap-2">
              <AssistantHeader />
              <TurnTrace
                status={stream.status}
                thinkingSegments={stream.thinkingSegments}
                tools={stream.tools}
                queries={queryPairs}
                durationMs={stream.durationMs}
                usage={stream.usage}
                memories={stream.memories}
                onCreateReport={onCreateReport}
                creatingReport={creatingReport}
                canExport={canExport}
              />
              {groupedStreamSegments.map((segment, index) => {
                if (segment.type === "markdown") {
                  const content = chartsReady
                    ? segment.content
                    : segment.content.replace(
                        /\[\[(?:(?:chart|artifact):[^\]\s]*|result:[^\]\r\n]*)$/,
                        "",
                      );
                  return content.trim() ? (
                    <MarkdownText key={`md-${index}`} content={content} />
                  ) : null;
                }
                if (segment.type === "artifact") {
                  const result = stream.results.find(
                    (item) => item.artifactId === segment.artifactId,
                  );
                  return result ? (
                    <ResultCard
                      key={`result-${index}`}
                      {...result}
                      onCreateReport={onCreateReport}
                      creatingReport={creatingReport}
                      canExport={canExport}
                    />
                  ) : null;
                }
                if (segment.type === "result_group") {
                  return (
                    <ResultLinkGroup
                      key={`result-group-${index}`}
                      items={segment.items}
                      results={stream.results}
                      disambiguate={disambiguateStreamResults}
                      canExport={canExport}
                      hideMissing
                    />
                  );
                }
                if (!chartsReady) return null;
                const chart = stream.charts.find(
                  (item) => item.chartArtifactId === segment.artifactId,
                );
                return chart ? (
                  <ChartCard
                    key={`chart-${index}`}
                    title={chart.title}
                    option={chartOptionFromSpec(chart.spec)}
                    points={chart.points}
                  />
                ) : null;
              })}
              {chartsReady && standaloneCharts.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {standaloneCharts.map((chart) => (
                    <ChartCard
                      key={chart.chartArtifactId}
                      title={chart.title}
                      option={chartOptionFromSpec(chart.spec)}
                      points={chart.points}
                    />
                  ))}
                </div>
              ) : null}
              {chartsReady && unmatchedResults.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {unmatchedResults.map((item, index) => (
                    <ResultCard
                      key={item.artifactId}
                      {...item}
                      index={unmatchedResults.length > 1 ? index + 1 : undefined}
                      onCreateReport={onCreateReport}
                      creatingReport={creatingReport}
                      canExport={canExport}
                    />
                  ))}
                </div>
              ) : null}
              {stream.notices.map((notice, index) => (
                <p key={`${notice.kind}-${index}`} className="text-[11px] text-warning">
                  {notice.message}
                </p>
              ))}
              {stream.connection === "reconnecting" ? (
                <p className="text-[11px] text-muted">连接中断，正在重连…</p>
              ) : null}
              {/* The trace is the live display while it has steps; the plain
                  status line only speaks when there is nothing else to watch. */}
              {hasTrace ? null : <RunStatus state={stream} />}
              <TurnFooter
                runId={activeRunId}
                status={stream.status}
                usage={hasTrace ? null : stream.usage}
                durationMs={hasTrace ? null : stream.durationMs}
                copyText={stream.text}
              />
            </div>
          </div>
        ) : null}

        </div>
      </div>
      <ConversationMinimap messages={messages} containerRef={containerRef} />
      {showJump || hasNewContent ? (
        <button
          type="button"
          aria-label="回到底部"
          onClick={() => {
            const el = containerRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            stickToBottom.current = true;
            setShowJump(false);
            setHasNewContent(false);
          }}
          className={cn(
            "absolute bottom-4 left-1/2 flex h-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-inksoft shadow-pop transition-colors hover:bg-subtle",
            hasNewContent ? "gap-1.5 px-3 text-[11px] font-medium" : "w-8",
          )}
        >
          {hasNewContent ? <span>有新内容</span> : null}
          <ArrowDown className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
