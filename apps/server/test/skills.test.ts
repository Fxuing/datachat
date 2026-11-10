import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { mcpServers, skills } from "../src/db/schema.js";
import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import { loadMcpFor } from "../src/agent/mcp.js";
import {
  composeSkillInstruction,
  findApplicableSkill,
  materializeSkills,
  seedSkills,
} from "../src/agent/skills.js";
import { createConversationResources } from "../src/agent/resources.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let handle: DbHandle;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-resources-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function insertSkill(overrides: {
  name: string;
  description?: string;
  content?: string;
  scope?: "global" | "datasource";
  datasourceId?: string | null;
  enabled?: number;
}) {
  const id = randomUUID();
  const now = Date.now();
  handle.db
    .insert(skills)
    .values({
      id,
      scope: overrides.scope ?? "global",
      datasourceId: overrides.datasourceId ?? null,
      name: overrides.name,
      description: overrides.description ?? `${overrides.name} description`,
      content: overrides.content ?? `# ${overrides.name}\n\nbody`,
      enabled: overrides.enabled ?? 1,
      updatedBy: "test",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function insertMcp(overrides: {
  name: string;
  transport: "stdio" | "http";
  command?: string | null;
  argsJson?: string | null;
  envCipher?: string | null;
  url?: string | null;
  headersCipher?: string | null;
  datasourceId?: string | null;
  enabled?: number;
}) {
  handle.db
    .insert(mcpServers)
    .values({
      id: randomUUID(),
      name: overrides.name,
      transport: overrides.transport,
      command: overrides.command ?? null,
      argsJson: overrides.argsJson ?? null,
      envCipher: overrides.envCipher ?? null,
      url: overrides.url ?? null,
      headersCipher: overrides.headersCipher ?? null,
      datasourceId: overrides.datasourceId ?? null,
      enabled: overrides.enabled ?? 1,
      createdBy: "u1",
      createdAt: Date.now(),
    })
    .run();
}

describe("materializeSkills", () => {
  it("writes global and datasource skills, with datasource scope winning by name", async () => {
    insertSkill({ name: "analysis-standards", content: "# global standards\n\nglobal body" });
    insertSkill({ name: "sql-dialect-mysql", content: "# global mysql\n\nglobal dialect" });
    insertSkill({
      name: "sql-dialect-mysql",
      scope: "datasource",
      datasourceId: "d1",
      content: "# datasource mysql\n\ndatasource dialect",
    });
    insertSkill({
      name: "other-datasource-only",
      scope: "datasource",
      datasourceId: "d2",
    });
    insertSkill({ name: "disabled-skill", enabled: 0 });

    const dataDir = path.join(root, "data");
    const skillsDir = await materializeSkills(handle.db, {
      conversationId: "c1",
      datasourceId: "d1",
      dataDir,
    });

    expect(skillsDir).toBe(path.join(dataDir, "skills", "c1"));
    const dirs = fs.readdirSync(skillsDir).sort();
    expect(dirs).toEqual(["analysis-standards", "sql-dialect-mysql"]);

    const override = fs.readFileSync(path.join(skillsDir, "sql-dialect-mysql", "SKILL.md"), "utf8");
    expect(override).toContain("datasource dialect");
    expect(override).not.toContain("global dialect");
    const parsed = parseFrontmatter<{ name: string; description: string }>(override);
    expect(parsed.frontmatter.name).toBe("sql-dialect-mysql");
    expect(parsed.frontmatter.description).toBe("sql-dialect-mysql description");
    expect(parsed.body).toBe("# datasource mysql\n\ndatasource dialect");
  });

  it("clears stale files before rewriting the conversation directory", async () => {
    insertSkill({ name: "analysis-standards" });
    const dataDir = path.join(root, "data");
    const stale = path.join(dataDir, "skills", "c1", "stale", "SKILL.md");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "old");

    await materializeSkills(handle.db, { conversationId: "c1", datasourceId: "d1", dataDir });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "skills", "c1", "analysis-standards", "SKILL.md"))).toBe(
      true,
    );
  });
});

describe("composeSkillInstruction", () => {
  it("embeds the skill body and the question, without frontmatter", () => {
    const skill = {
      name: "monthly-revenue",
      description: "月度收入口径",
      scope: "global" as const,
      content: `---
name: monthly-revenue
description: 月度收入口径
---

# 月度收入

使用 SUM(amount) 并排除退款。`,
    };
    const prompt = composeSkillInstruction(skill, "本月收入是多少？");

    expect(prompt).toContain("请使用技能「monthly-revenue」");
    expect(prompt).toContain("# 月度收入");
    expect(prompt).toContain("使用 SUM(amount) 并排除退款。");
    expect(prompt).not.toContain("description: 月度收入口径");
    expect(prompt).toContain(`用户问题：
本月收入是多少？`);
  });

  it("lets a datasource skill override a global skill with the same name", () => {
    insertSkill({ name: "churn", content: `# churn

global body` });
    insertSkill({
      name: "churn",
      scope: "datasource",
      datasourceId: "ds-1",
      content: `# churn

datasource body`,
    });

    expect(findApplicableSkill(handle.db, "ds-1", "churn")?.content).toContain(
      "datasource body",
    );
    expect(findApplicableSkill(handle.db, "ds-2", "churn")?.content).toContain("global body");
  });
});

describe("seedSkills", () => {
  it("imports built-in skills once and is idempotent by name", () => {
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(agentDir, "skills", "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "skills", "alpha", "SKILL.md"),
      "---\nname: alpha-skill\ndescription: Alpha description\n---\n\nAlpha body\n",
    );
    fs.mkdirSync(path.join(agentDir, "skills", "beta"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "skills", "beta", "SKILL.md"),
      "---\nname: beta-skill\ndescription: Beta description\n---\n\nBeta body\n",
    );

    seedSkills(handle.db, agentDir);
    const first = handle.db.select().from(skills).all();
    expect(first).toHaveLength(2);
    expect(first.every((row) => row.scope === "global" && row.enabled === 1)).toBe(true);
    expect(first.every((row) => row.updatedBy === "system")).toBe(true);
    const alpha = first.find((row) => row.name === "alpha-skill");
    expect(alpha?.description).toBe("Alpha description");
    expect(alpha?.content).toBe("Alpha body");

    seedSkills(handle.db, agentDir);
    const second = handle.db.select().from(skills).all();
    expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
  });
});

describe("loadMcpFor", () => {
  const key = deriveSecretKey(testConfig.appSecret);

  it("returns empty config when no servers exist", () => {
    const result = loadMcpFor({ db: handle.db, config: testConfig, datasourceId: "d1" });
    expect(result).toEqual({ servers: [], errors: [] });
  });

  it("maps enabled stdio and http servers scoped to global or the datasource", () => {
    insertMcp({
      name: "global-stdio",
      transport: "stdio",
      command: "npx",
      argsJson: JSON.stringify(["-y", "server"]),
      envCipher: encryptSecret(JSON.stringify({ API_KEY: "secret" }), key),
    });
    insertMcp({
      name: "datasource-http",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headersCipher: encryptSecret(JSON.stringify({ Authorization: "Bearer token" }), key),
      datasourceId: "d1",
    });
    insertMcp({ name: "disabled", transport: "stdio", command: "x", enabled: 0 });
    insertMcp({
      name: "other-datasource",
      transport: "stdio",
      command: "x",
      datasourceId: "d2",
    });

    const result = loadMcpFor({ db: handle.db, config: testConfig, datasourceId: "d1" });
    expect(result.errors).toEqual([]);
    expect(result.servers).toHaveLength(2);

    const stdio = result.servers.find((server) => server.name === "global-stdio");
    expect(stdio?.source).toBe("global");
    expect(stdio?.config).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { API_KEY: "secret" },
    });

    const http = result.servers.find((server) => server.name === "datasource-http");
    expect(http?.source).toBe("datasource");
    expect(http?.config).toMatchObject({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer token" },
    });
  });

  it("reports broken ciphertext in errors without throwing or dropping valid servers", () => {
    insertMcp({ name: "valid", transport: "stdio", command: "ok" });
    insertMcp({
      name: "broken",
      transport: "stdio",
      command: "npx",
      envCipher: "v1:not-a-real-ciphertext",
    });

    const result = loadMcpFor({ db: handle.db, config: testConfig, datasourceId: "d1" });
    expect(result.servers.map((server) => server.name)).toEqual(["valid"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken");
  });
});

describe("createConversationResources", () => {
  it("loads the materialized skills and system prompt for the conversation", async () => {
    seedSkills(handle.db, testConfig.agentDir);
    const dataDir = path.join(root, "data");
    const config = { ...testConfig, dataDir };
    const skillsDir = await materializeSkills(handle.db, {
      conversationId: "c1",
      datasourceId: "d1",
      dataDir,
    });

    const { loader, workspaceDir } = await createConversationResources({
      db: handle.db,
      config,
      conversationId: "c1",
      datasourceId: "d1",
      userId: "u1",
      skillsDir,
      datasourceName: "销售库",
      datasourceType: "mysql",
      database: "sales",
    });

    expect(workspaceDir).toBe(path.join(dataDir, "workspaces", "c1"));
    expect(fs.statSync(workspaceDir).isDirectory()).toBe(true);

    const materializedNames = loader
      .getSkills()
      .skills.filter((skill) => skill.filePath.startsWith(`${skillsDir}${path.sep}`))
      .map((skill) => skill.name)
      .sort();
    expect(materializedNames).toEqual([
      "analysis-standards",
      "sql-dialect-mysql",
      "sql-dialect-postgres",
    ]);

    const systemPrompt = await loader.getSystemPrompt();
    expect(systemPrompt).toContain("销售库");
    expect(systemPrompt).toContain("## 硬性规则");
    expect(systemPrompt).not.toMatch(/\{\{\w+\}\}/);
  });
});
