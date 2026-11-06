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
import {
  DEFAULT_MODEL_CANDIDATE,
  resolveChatModel,
} from "./model-runtime.js";
import { createConversationResources } from "./resources.js";
import type { AgentToolContext } from "./tools/context.js";
import { buildAgentTools } from "./tools/index.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ConversationThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CreateConversationSessionInput {
  db: Db;
  config: AppConfig;
  runtime: ModelRuntime;
  conversation: ConversationRow;
  userId: string;
  skillsDir: string;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
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

  const modelId = conversation.modelId ?? DEFAULT_MODEL_CANDIDATE;
  const model = resolveChatModel(input.runtime, modelId);
  if (!model) throw new Error(`模型不可用：${modelId}`);

  const toolContext: AgentToolContext = {
    db: input.db,
    config: input.config,
    pools: input.pools,
    artifacts: input.artifacts,
    userId: input.userId,
    conversationId: conversation.id,
    datasourceId: conversation.datasourceId,
    runId: "",
    skillsDir: input.skillsDir,
  };

  const { loader, workspaceDir } = await createConversationResources({
    db: input.db,
    config: input.config,
    conversationId: conversation.id,
    datasourceId: conversation.datasourceId,
    userId: input.userId,
    skillsDir: input.skillsDir,
    datasourceName: datasource.name,
    datasourceType: datasource.type,
    database: datasource.database,
  });

  const sessionManager = conversation.piSessionFile
    ? SessionManager.open(conversation.piSessionFile, undefined, workspaceDir)
    : SessionManager.create(
        input.config.dataDir,
        path.join(input.config.dataDir, "pi-sessions", input.userId),
      );

  const { session } = await createAgentSession({
    cwd: workspaceDir,
    sessionManager,
    resourceLoader: loader,
    modelRuntime: input.runtime,
    model,
    thinkingLevel: toThinkingLevel(conversation.thinkingLevel),
    noTools: "builtin",
    customTools: buildAgentTools(toolContext),
  });
  await session.bindExtensions({});

  const piSessionFile = session.sessionFile ?? sessionManager.getSessionFile();
  if (!piSessionFile) throw new Error("无法确定 Pi 会话文件路径");
  if (piSessionFile !== conversation.piSessionFile) {
    updateConversation(input.db, conversation.id, { piSessionFile });
  }

  return { session, piSessionFile, toolContext };
}
