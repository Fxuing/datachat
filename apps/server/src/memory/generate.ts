import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ChatModel } from "../agent/model-runtime.js";
import { EXTRACTION_SYSTEM_PROMPT } from "./extraction.js";

export interface MemoryGeneratorOptions {
  config: AppConfig;
  runtime: ModelRuntime;
  model: ChatModel;
}

/**
 * A separate, tool-less session keeps extraction isolated from the conversation
 * transcript and from the user's workspace.
 */
export function createMemoryGenerator(
  options: MemoryGeneratorOptions,
): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const loader = new DefaultResourceLoader({
      cwd: options.config.dataDir,
      agentDir: options.config.agentDir,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    });
    const { session } = await createAgentSession({
      cwd: options.config.dataDir,
      agentDir: options.config.agentDir,
      modelRuntime: options.runtime,
      model: options.model,
      noTools: "all",
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    try {
      await session.prompt(prompt);
      return session.getLastAssistantText() ?? "";
    } finally {
      session.dispose();
    }
  };
}
