import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentModelRuntime,
  DEFAULT_MODEL_CANDIDATE,
  listChatModels,
  resolveChatModel,
} from "../src/agent/model-runtime.js";
import { testConfig } from "./helpers/config.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-models-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function testRuntimeConfig() {
  return {
    ...testConfig,
    dataDir: root,
    agentAuthPath: path.join(root, "agent", "auth.json"),
  };
}

const PROVIDERS = ["siliconflow"] as const;

describe("agent model runtime", () => {
  it("parses agent/models.json and lists the four whitelisted models in order", async () => {
    const config = testRuntimeConfig();
    const runtime = await createAgentModelRuntime(config);

    // Pi expects a credential store to exist; first run seeds an empty one.
    expect(fs.readFileSync(config.agentAuthPath, "utf8").trim()).toBe("{}");

    const models = listChatModels(runtime, PROVIDERS);
    expect(models.map((model) => model.modelId)).toEqual([
      "deepseek-ai/DeepSeek-V3.2",
      "zai-org/GLM-5.3",
      "Qwen/Qwen3.8-27B",
      "moonshotai/Kimi-K2.7-Code",
    ]);
    expect(models[0]).toEqual({
      id: "siliconflow::deepseek-ai/DeepSeek-V3.2",
      modelId: "deepseek-ai/DeepSeek-V3.2",
      providerId: "siliconflow",
      providerName: "SiliconFlow",
      name: "DeepSeek V3.2",
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });

  it("resolves every catalog entry through getModel and defaults to DeepSeek V3.2", async () => {
    const runtime = await createAgentModelRuntime(testRuntimeConfig());

    for (const id of [
      "deepseek-ai/DeepSeek-V3.2",
      "zai-org/GLM-5.3",
      "Qwen/Qwen3.8-27B",
      "moonshotai/Kimi-K2.7-Code",
    ]) {
      expect(runtime.getModel("siliconflow", id)?.id).toBe(id);
      expect(resolveChatModel(runtime, id, PROVIDERS)?.id).toBe(id);
    }

    const preferred = resolveChatModel(runtime, DEFAULT_MODEL_CANDIDATE, PROVIDERS);
    expect(preferred?.provider).toBe("siliconflow");
    expect(preferred?.maxTokens).toBe(8_192);
  });

  it("never exposes providers outside the siliconflow whitelist", async () => {
    const runtime = await createAgentModelRuntime(testRuntimeConfig());

    const models = listChatModels(runtime, PROVIDERS);
    expect(models).toHaveLength(4);
    for (const info of models) {
      const model = resolveChatModel(runtime, info.id, PROVIDERS);
      expect(model?.provider).toBe("siliconflow");
    }
    // The runtime still knows about Pi's builtin providers; the catalog hides them.
    expect(runtime.getModels().length).toBeGreaterThan(models.length);
  });

  it("returns undefined for unknown model ids", async () => {
    const runtime = await createAgentModelRuntime(testRuntimeConfig());

    expect(resolveChatModel(runtime, "openai/gpt-4o", PROVIDERS)).toBeUndefined();
    expect(resolveChatModel(runtime, "")).toBeUndefined();
  });

  it("keeps an existing credential store untouched", async () => {
    const config = testRuntimeConfig();
    fs.mkdirSync(path.dirname(config.agentAuthPath), { recursive: true });
    fs.writeFileSync(config.agentAuthPath, '{"siliconflow":{"type":"api_key","key":"x"}}');

    await createAgentModelRuntime(config);

    expect(fs.readFileSync(config.agentAuthPath, "utf8")).toContain('"key":"x"');
  });
});
