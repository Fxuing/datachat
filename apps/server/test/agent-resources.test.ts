import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { createConversationResources } from "../src/agent/resources.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let handle: DbHandle;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-resources-"));
  handle = createDb(path.join(root, "test.sqlite"));
  migrateDb(handle.db);
  fs.mkdirSync(path.join(root, "agent"), { recursive: true });
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("conversation resources", () => {
  it("loads the questionnaire extension alongside the built-in tools", async () => {
    const resources = await createConversationResources({
      db: handle.db,
      config: {
        ...testConfig,
        dataDir: root,
        agentDir: path.join(root, "agent"),
        agentAuthPath: path.join(root, "agent", "auth.json"),
      },
      conversationId: randomUUID(),
      datasourceId: randomUUID(),
      userId: randomUUID(),
      skillsDir: path.join(root, "skills"),
      canUseSkills: true,
      canUseMcp: true,
      canUseMemory: false,
      datasourceName: "demo",
      datasourceType: "mysql",
      database: "demo",
    });

    const extensions = resources.loader.getExtensions();
    expect(extensions.errors).toEqual([]);
    const tools = extensions.extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(tools).toContain("ask_user_question");
    // billion-context registers its acp tools during session_start, so only its
    // extension entry is present at loader time.
    expect(extensions.extensions.some((entry) => entry.path.includes("billion-context"))).toBe(true);
  });
});
