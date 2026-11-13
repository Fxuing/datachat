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
import { updateConversation } from "../db/repositories/conversations.js";
import { findDatasource } from "../db/repositories/datasources.js";
import type { ArtifactStore } from "../services/artifacts.js";
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
  canCreateReports: boolean;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
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
  const datasource = findDatasource(input.db, conversation.datasourceId);
  if (!datasource) throw new Error("会话绑定的数据源不存在");

  const providerIds = enabledProviderIds(input.db);
  const model = resolveConversationModel(input.runtime, conversation.modelId, providerIds);

  const { loader, workspaceDir, eventBus } = await createConversationResources({
    db: input.db,
    config: input.config,
    conversationId: conversation.id,
    datasourceId: conversation.datasourceId,
    userId: input.userId,
    skillsDir: input.skillsDir,
    canUseSkills: input.canUseSkills,
    canUseMcp: input.canUseMcp,
    datasourceName: datasource.name,
    datasourceType: datasource.type,
    database: datasource.database,
  });

  const toolContext: AgentToolContext = {
    db: input.db,
    config: input.config,
    pools: input.pools,
    artifacts: input.artifacts,
    userId: input.userId,
    conversationId: conversation.id,
    datasourceId: conversation.datasourceId,
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
