import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  DefaultResourceLoader,
  createEventBus,
  createMcpExtension,
  type EventBusController,
} from "@earendil-works/pi-coding-agent";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import { loadMcpFor } from "./mcp.js";
import { createMemoryExtension, type MemoryUsageItem } from "../memory/recall.js";
import {
  createSemanticExtension,
  hasEnabledSemanticEntries,
} from "../services/semantic-layer.js";
import { renderSystemPrompt } from "./prompt.js";

/** Functional permissions that shape the agent's resource loader. */
export interface ConversationPermissions {
  skills: boolean;
  mcp: boolean;
  reports: boolean;
  memory: boolean;
}

export interface ConversationResourcesInput {
  db: Db;
  config: AppConfig;
  conversationId: string;
  datasourceId: string | null;
  userId: string;
  skillsDir?: string;
  canUseSkills: boolean;
  canUseMcp: boolean;
  canUseMemory: boolean;
  /** Receives the memories injected into a turn, for the run's trace. */
  onMemoryUsed?: (items: MemoryUsageItem[]) => void;
  datasourceName: string;
  datasourceType: string;
  datasourceTypeLabel?: string;
  dialectGuidance?: string;
  extraInstructions?: string;
  database: string;
}

export interface ResourceSettings {
  additionalSkillPaths: string[];
  mcpEnabled: boolean;
  memoryEnabled: boolean;
}

/**
 * Decide which optional resources a session may load. Kept pure so the permission
 * matrix can be tested without building a resource loader.
 */
export function buildResourceSettings(input: {
  canUseSkills: boolean;
  canUseMcp: boolean;
  canUseMemory: boolean;
  skillsDir?: string;
}): ResourceSettings {
  return {
    additionalSkillPaths:
      input.canUseSkills && input.skillsDir ? [input.skillsDir] : [],
    mcpEnabled: input.canUseMcp,
    memoryEnabled: input.canUseMemory,
  };
}

export interface ConversationResources {
  loader: DefaultResourceLoader;
  workspaceDir: string;
  eventBus: EventBusController;
}

const require = createRequire(import.meta.url);

/**
 * Resolve the installed questionnaire extension. Keeping it optional makes the server
 * start even when the package was removed; the model simply loses the tool.
 */
function askUserQuestionExtensionPath(): string | undefined {
  try {
    return require.resolve("@juicesharp/rpiv-ask-user-question");
  } catch {
    return undefined;
  }
}

/** Optional context-compression plugin; absent installs simply lose the acp tools. */
function billionContextExtensionPath(): string | undefined {
  try {
    const packageJson = require.resolve("billion-context/package.json");
    const entry = path.join(path.dirname(packageJson), "dist/agent/pi-native.js");
    return existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the Pi resource loader for one conversation: a per-conversation workspace, the
 * materialized skill directory, the rendered system prompt, and MCP servers scoped to the
 * conversation's datasource. Extensions and project context files are disabled.
 */
export async function createConversationResources(
  input: ConversationResourcesInput,
): Promise<ConversationResources> {
  const workspaceDir = path.join(input.config.dataDir, "workspaces", input.conversationId);
  await fs.mkdir(workspaceDir, { recursive: true });

  const askUserExtension = askUserQuestionExtensionPath();
  const billionContextExtension = billionContextExtensionPath();
  const extensionPaths = [askUserExtension, billionContextExtension].filter(
    (entry): entry is string => Boolean(entry),
  );
  const eventBus = createEventBus();
  const settings = buildResourceSettings(input);
  const extensionFactories = [];
  if (settings.mcpEnabled) {
    extensionFactories.push(
      createMcpExtension({
        loadConfig: () =>
          loadMcpFor({
            db: input.db,
            config: input.config,
            datasourceId: input.datasourceId,
          }),
      }),
    );
  }
  if (input.datasourceId && hasEnabledSemanticEntries(input.db, input.datasourceId)) {
    extensionFactories.push(
      createSemanticExtension({
        db: input.db,
        datasourceId: input.datasourceId,
        userId: input.userId,
      }),
    );
  }
  if (settings.memoryEnabled) {
    extensionFactories.push(
      createMemoryExtension({
        db: input.db,
        userId: input.userId,
        conversationId: input.conversationId,
        datasourceId: input.datasourceId,
        datasourceName: input.datasourceName,
        ...(input.onMemoryUsed ? { onMemoryUsed: input.onMemoryUsed } : {}),
      }),
    );
  }
  const loader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: input.config.agentDir,
    eventBus,
    additionalSkillPaths: settings.additionalSkillPaths,
    ...(extensionPaths.length > 0 ? { additionalExtensionPaths: extensionPaths } : {}),
    noExtensions: true,
    // Auto-discovered host/project skills would collide with the materialized ones by name and
    // shadow datasource overrides, so only the conversation skill directory is loaded.
    noSkills: true,
    noContextFiles: true,
    systemPrompt: renderSystemPrompt({
      datasourceName: input.datasourceName,
      datasourceType: input.datasourceType,
      ...(input.datasourceTypeLabel ? { datasourceTypeLabel: input.datasourceTypeLabel } : {}),
      ...(input.dialectGuidance ? { dialectGuidance: input.dialectGuidance } : {}),
      ...(input.extraInstructions ? { extraInstructions: input.extraInstructions } : {}),
      database: input.database,
    }),
    ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
  });

  await loader.reload();
  return { loader, workspaceDir, eventBus };
}
