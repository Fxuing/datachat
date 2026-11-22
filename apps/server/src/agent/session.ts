import path from "node:path";
import {
  SessionManager,
  createAgentSession,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { ConversationRow } from "../db/repositories/conversations.js";
import { listConversationFiles } from "../db/repositories/conversation-files.js";
import { updateConversation } from "../db/repositories/conversations.js";
import { findDatasource } from "../db/repositories/datasources.js";
import type { MemoryUsageItem } from "../memory/recall.js";
import type { ArtifactStore } from "../services/artifacts.js";
import { defaultDriverRegistry, type DriverRegistry } from "../drivers/registry.js";
import type { PoolRegistry } from "./datasource/pool.js";
import { resolveConversationModel } from "./model-runtime.js";

import { createConversationResources } from "./resources.js";
import type { QuestionBridge } from "./question-bridge.js";
import type { AgentToolContext } from "./tools/context.js";
import { buildAgentTools } from "./tools/index.js";
import { enabledProviderIds } from "../services/llm-catalog.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ConversationThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CreateConversationSessionInput {
  db: Db;
  config: AppConfig;
  runtime: ModelRuntime;
  conversation: ConversationRow;
  userId: string;
  skillsDir?: string;
  canUseSkills: boolean;
  canUseMcp: boolean;
  canUseMemory: boolean;
  /** Receives the memories injected into a turn, for the run's trace. */
  onMemoryUsed?: (items: MemoryUsageItem[]) => void;
  canCreateReports: boolean;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
  drivers?: DriverRegistry;
  questionBridge: QuestionBridge;
}

export interface ConversationSessionResult {
  session: AgentSession;
  piSessionFile: string;
  /**
   * Shared tool context closed over by the custom tools. The runtime mutates `runId`
   * before every prompt so artifacts and audit rows belong to the current run.
   */
  toolContext: AgentToolContext;
}

function toThinkingLevel(value: string): ConversationThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ConversationThinkingLevel)
    : "off";
}

/**
 * Create (or reopen) the single Pi session owned by a conversation. The session is
 * persisted under `data/pi-sessions/<userId>` and its path is written back to the
 * conversation so later process restarts resume the same transcript.
 */
export async function createConversationSession(
  input: CreateConversationSessionInput,
): Promise<ConversationSessionResult> {
  const { conversation } = input;
  const isFileSession = conversation.sourceKind === "file";
  const drivers = input.drivers ?? defaultDriverRegistry;
  let datasourceId: string | null = null;
  let datasourceName: string;
  let datasourceType: string;
  let datasourceTypeLabel: string | undefined;
  let dialectGuidance: string | undefined;
  let database: string;

  if (isFileSession) {
    const files = listConversationFiles(input.db, conversation.id);
    datasourceName =
      files.length === 1
        ? files[0]!.fileName
        : files.length > 1
          ? `上传文件（${files.length} 个）`
          : "上传文件";
    datasourceType = "sqlite";
    database = "uploaded_files";
  } else {
    const datasource = conversation.datasourceId
      ? findDatasource(input.db, conversation.datasourceId)
      : undefined;
    if (!datasource) throw new Error("会话绑定的数据源不存在");
    datasourceId = datasource.id;
    datasourceName = datasource.name;
    datasourceType = datasource.type;
    const driver = drivers.get(datasource.type);
    datasourceTypeLabel = driver?.manifest.label;
    dialectGuidance = driver?.dialect.promptGuidance;
    database = datasource.database;
  }

  const providerIds = enabledProviderIds(input.db);
  const model = resolveConversationModel(input.runtime, conversation.modelId, providerIds);

  const { loader, workspaceDir, eventBus } = await createConversationResources({
    db: input.db,
    config: input.config,
    conversationId: conversation.id,
    datasourceId,
    userId: input.userId,
    skillsDir: input.skillsDir,
    canUseSkills: input.canUseSkills,
    canUseMcp: input.canUseMcp,
    canUseMemory: input.canUseMemory,
    ...(input.onMemoryUsed ? { onMemoryUsed: input.onMemoryUsed } : {}),
    datasourceName,
    datasourceType,
    ...(datasourceTypeLabel ? { datasourceTypeLabel } : {}),
    ...(dialectGuidance ? { dialectGuidance } : {}),
    database,
  });

  const toolContext: AgentToolContext = {
    db: input.db,
    config: input.config,
    pools: input.pools,
    artifacts: input.artifacts,
    drivers,
    userId: input.userId,
    conversationId: conversation.id,
    datasourceId,
    sourceKind: isFileSession ? "file" : "datasource",
    runId: "",
    // Without skills the read tool stays inside the empty conversation workspace.
    skillsDir: input.skillsDir ?? workspaceDir,
  };

  const sessionManager = conversation.piSessionFile
    ? SessionManager.open(conversation.piSessionFile, undefined, workspaceDir)
    : SessionManager.create(
        input.config.dataDir,
        path.join(input.config.dataDir, "pi-sessions", input.userId),
      );

  const { session } = await createAgentSession({
    cwd: workspaceDir,
    agentDir: input.config.agentDir,
    sessionManager,
    resourceLoader: loader,
    modelRuntime: input.runtime,
    model,
    thinkingLevel: toThinkingLevel(conversation.thinkingLevel),
    noTools: "builtin",
    customTools: buildAgentTools(toolContext, {
      canCreateReports: input.canCreateReports,
    }),
  });
  input.questionBridge.bind(eventBus);
  await session.bindExtensions({ uiContext: input.questionBridge.uiContext });

  const piSessionFile = session.sessionFile ?? sessionManager.getSessionFile();
  if (!piSessionFile) throw new Error("无法确定 Pi 会话文件路径");
  if (piSessionFile !== conversation.piSessionFile) {
    updateConversation(input.db, conversation.id, { piSessionFile });
  }

  return { session, piSessionFile, toolContext };
}
