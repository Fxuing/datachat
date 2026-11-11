import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  insertLlmProvider,
  listLlmProviders,
} from "../src/db/repositories/llm-providers.js";
import {
  decryptProviderKey,
  seedLegacyLlmProvider,
  syncModelCatalog,
} from "../src/services/llm-catalog.js";
import { testConfig } from "./helpers/config.js";

const LEGACY_MODELS = {
  providers: {
    siliconflow: {
      name: "SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      api: "openai-completions",
      models: [{ id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek V3.2" }],
    },
  },
};

let root: string;
let db: Db;
let agentDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-legacy-"));
  agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(LEGACY_MODELS));
  db = createDb(":memory:").db;
  migrateDb(db);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...testConfig,
    dataDir: root,
    agentDir,
    agentAuthPath: path.join(root, "agent", "auth.json"),
    ...overrides,
  };
}

describe("seedLegacyLlmProvider", () => {
  it("does not create an empty provider when no API key is configured", () => {
    seedLegacyLlmProvider(db, config());

    expect(listLlmProviders(db)).toEqual([]);
  });

  it("adopts a key that was added after the empty provider was seeded", () => {
    const appConfig = config({ siliconflowApiKey: "sk-later" });
    insertLlmProvider(db, {
      id: "siliconflow",
      name: "SiliconFlow",
      protocol: "openai-completions",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKeyCipher: encryptSecret("", deriveSecretKey(appConfig.appSecret)),
      models: [{ id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek V3.2", contextWindow: 128000, maxTokens: 8192 }],
      enabled: true,
      now: Date.now(),
    });

    seedLegacyLlmProvider(db, appConfig);

    const providers = listLlmProviders(db);
    expect(providers).toHaveLength(1);
    expect(decryptProviderKey(providers[0]!, appConfig.appSecret)).toBe("sk-later");
  });

  it("omits providers without a key from the generated catalog", () => {
    const appConfig = config({ siliconflowApiKey: "sk-good" });
    const model = {
      id: "chat-1",
      name: "Chat 1",
      contextWindow: 128000,
      maxTokens: 8192,
    };
    insertLlmProvider(db, {
      id: "empty",
      name: "Empty",
      protocol: "openai-completions",
      baseUrl: "https://empty.example.com/v1",
      apiKeyCipher: encryptSecret("", deriveSecretKey(appConfig.appSecret)),
      models: [model],
      enabled: true,
      now: Date.now(),
    });
    insertLlmProvider(db, {
      id: "good",
      name: "Good",
      protocol: "openai-completions",
      baseUrl: "https://good.example.com/v1",
      apiKeyCipher: encryptSecret("sk-good", deriveSecretKey(appConfig.appSecret)),
      models: [model],
      enabled: true,
      now: Date.now(),
    });

    const catalog = syncModelCatalog(db, appConfig);
    const written = JSON.parse(fs.readFileSync(catalog.path, "utf8")) as {
      providers: Record<string, unknown>;
    };

    expect(Object.keys(written.providers)).toEqual(["good"]);
    expect(catalog.keys.has("empty")).toBe(false);
  });

  it("seeds the legacy provider when a key is present", () => {
    const appConfig = config({ siliconflowApiKey: "sk-first" });
    seedLegacyLlmProvider(db, appConfig);

    const providers = listLlmProviders(db);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "siliconflow", enabled: 1 });
    expect(decryptProviderKey(providers[0]!, appConfig.appSecret)).toBe("sk-first");
  });
});
