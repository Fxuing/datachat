import fs from "node:fs/promises";
import path from "node:path";
import { DefaultResourceLoader, createMcpExtension } from "@earendil-works/pi-coding-agent";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import { loadMcpFor } from "./mcp.js";
import { renderSystemPrompt } from "./prompt.js";

export interface ConversationResourcesInput {
  db: Db;
  config: AppConfig;
  conversationId: string;
  datasourceId: string;
  userId: string;
  skillsDir: string;
  datasourceName: string;
  datasourceType: "mysql" | "postgres";
  database: string;
}

export interface ConversationResources {
  loader: DefaultResourceLoader;
  workspaceDir: string;
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

  const loader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: input.config.agentDir,
    additionalSkillPaths: [input.skillsDir],
    noExtensions: true,
    // Auto-discovered host/project skills would collide with the materialized ones by name and
    // shadow datasource overrides, so only the conversation skill directory is loaded.
    noSkills: true,
    noContextFiles: true,
    systemPrompt: renderSystemPrompt({
      datasourceName: input.datasourceName,
      datasourceType: input.datasourceType,
      database: input.database,
    }),
    extensionFactories: [
      createMcpExtension({
        loadConfig: () =>
          loadMcpFor({
            db: input.db,
            config: input.config,
            datasourceId: input.datasourceId,
          }),
      }),
    ],
  });

  await loader.reload();
  return { loader, workspaceDir };
}
