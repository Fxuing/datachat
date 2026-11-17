import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunEventBus } from "../src/agent/event-bus.js";
import {
  buildResourceSettings,
  createConversationResources,
} from "../src/agent/resources.js";
import {
  ConversationRuntime,
  materializeSkillsForPermissions,
  resolveConversationPermissions,
} from "../src/agent/runtime.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildAgentTools } from "../src/agent/tools/index.js";
import type { AgentToolContext } from "../src/agent/tools/context.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { createRole, setUserRoles } from "../src/db/repositories/roles.js";
import { insertUser } from "../src/db/repositories/users.js";
import { testConfig } from "./helpers/config.js";

let root: string;
let handle: DbHandle;

const SKILL_MD = "---\nname: demo\ndescription: Demo skill\n---\n\nBody\n";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-agent-permissions-"));
  handle = createDb(path.join(root, "test.sqlite"));
  migrateDb(handle.db);
  fs.mkdirSync(path.join(root, "agent"), { recursive: true });
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function resourceConfig() {
  return {
    ...testConfig,
    dataDir: root,
    agentDir: path.join(root, "agent"),
    agentAuthPath: path.join(root, "agent", "auth.json"),
  };
}

function seedSkillDirectory(): string {
  const skillsDir = path.join(root, "skills");
  fs.mkdirSync(path.join(skillsDir, "demo"), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "demo", "SKILL.md"), SKILL_MD);
  return skillsDir;
}

describe("buildResourceSettings", () => {
  it("drops skills and mcp when permissions are absent", () => {
    expect(
      buildResourceSettings({ canUseSkills: false, canUseMcp: false, canUseMemory: false, skillsDir: "/tmp/skills" }),
    ).toEqual({ additionalSkillPaths: [], mcpEnabled: false, memoryEnabled: false });
  });

  it("keeps skills and mcp when permissions are present", () => {
    expect(
      buildResourceSettings({ canUseSkills: true, canUseMcp: true, canUseMemory: true, skillsDir: "/tmp/skills" }),
    ).toEqual({ additionalSkillPaths: ["/tmp/skills"], mcpEnabled: true, memoryEnabled: true });
  });

  it("skips the skill path when no directory was materialized", () => {
    expect(buildResourceSettings({ canUseSkills: true, canUseMcp: true, canUseMemory: true })).toEqual({
      additionalSkillPaths: [],
      mcpEnabled: true,
      memoryEnabled: true,
    });
  });
});

describe("createConversationResources permissions", () => {
  function resourceInput(conversationId: string, skillsDir: string, canUse: boolean) {
    return {
      db: handle.db,
      config: resourceConfig(),
      conversationId,
      datasourceId: "d1",
      userId: "u1",
      skillsDir,
      canUseSkills: canUse,
      canUseMcp: canUse,
      canUseMemory: false,
      datasourceName: "demo",
      datasourceType: "mysql" as const,
      database: "demo",
    };
  }

  it("skips the skill directory and mcp extension without permission", async () => {
    const skillsDir = seedSkillDirectory();
    const { loader } = await createConversationResources(
      resourceInput("no-permission", skillsDir, false),
    );

    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getExtensions().extensions.some((entry) => entry.path.startsWith("<inline:")))
      .toBe(false);
    expect(loader.getExtensions().errors).toEqual([]);
  });

  it("loads the skill directory and mcp extension with permission", async () => {
    const skillsDir = seedSkillDirectory();
    const { loader } = await createConversationResources(
      resourceInput("with-permission", skillsDir, true),
    );

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["demo"]);
    expect(loader.getExtensions().extensions.some((entry) => entry.path.startsWith("<inline:")))
      .toBe(true);
    expect(loader.getExtensions().errors).toEqual([]);
  });
});

describe("skill materialization permissions", () => {
  it("does not materialize a skill directory without skill.use", async () => {
    const skillsDir = await materializeSkillsForPermissions(
      handle.db,
      { conversationId: "c1", datasourceId: "d1", dataDir: root },
      { skills: false, mcp: true, reports: true, memory: false },
    );

    expect(skillsDir).toBeUndefined();
    expect(fs.existsSync(path.join(root, "skills", "c1"))).toBe(false);
  });

  it("materializes the skill directory with skill.use", async () => {
    const skillsDir = await materializeSkillsForPermissions(
      handle.db,
      { conversationId: "c1", datasourceId: "d1", dataDir: root },
      { skills: true, mcp: false, reports: true, memory: false },
    );

    expect(skillsDir).toBe(path.join(root, "skills", "c1"));
    expect(fs.existsSync(skillsDir!)).toBe(true);
  });
});

describe("agent tool permissions", () => {
  it("omits create_report without report.create", () => {
    const ctx = { skillsDir: root } as AgentToolContext;
    const withoutReports = buildAgentTools(ctx, { canCreateReports: false }).map(
      (tool) => tool.name,
    );
    const withReports = buildAgentTools(ctx, { canCreateReports: true }).map((tool) => tool.name);
    expect(withoutReports).not.toContain("create_report");
    expect(withReports).toContain("create_report");
  });
});

describe("ConversationRuntime permission resolution", () => {
  function userWithRole(role: "admin" | "user", rolePermissions?: string[]): string {
    const id = `user-${role}-${rolePermissions?.join("-") ?? "none"}`;
    insertUser(handle.db, {
      id,
      username: id,
      passwordHash: "hash",
      role,
      createdAt: Date.now(),
    });
    if (rolePermissions) {
      const role = createRole(handle.db, {
        name: `role-${id}`,
        permissions: rolePermissions,
        datasourceIds: [],
      });
      setUserRoles(handle.db, id, [role.id]);
    }
    return id;
  }

  function runtimeFor(userId: string): ConversationRuntime {
    return new ConversationRuntime({
      db: handle.db,
      conversation: createConversation(handle.db, { userId, datasourceId: "ds-1" }),
      userId,
      bus: new RunEventBus(),
      createSession: async () => {
        throw new Error("session creation is not part of this test");
      },
    });
  }

  it("disables skills and mcp for a role without those permissions", () => {
    const userId = userWithRole("user", ["chat.use"]);
    expect(resolveConversationPermissions(handle.db, userId)).toEqual({
      skills: false,
      mcp: false,
      reports: false,
      memory: true,
    });
    expect(runtimeFor(userId).permissions).toEqual({
      skills: false,
      mcp: false,
      reports: false,
      memory: true,
    });
  });

  it("keeps report creation only with report.create", () => {
    const withoutReport = userWithRole("user", ["chat.use", "skill.use", "mcp.use"]);
    const withReport = userWithRole("user", [
      "chat.use",
      "skill.use",
      "mcp.use",
      "report.create",
    ]);
    expect(resolveConversationPermissions(handle.db, withoutReport).reports).toBe(false);
    expect(resolveConversationPermissions(handle.db, withReport).reports).toBe(true);
  });

  it("keeps skills and mcp for the member preset", () => {
    const userId = userWithRole("user");
    expect(runtimeFor(userId).permissions).toEqual({ skills: true, mcp: true, reports: true, memory: true });
  });

  it("keeps skills and mcp for an admin", () => {
    const userId = userWithRole("admin");
    expect(runtimeFor(userId).permissions).toEqual({ skills: true, mcp: true, reports: true, memory: true });
  });

  it("fails closed for synthetic users without a database row", () => {
    const runtime = new ConversationRuntime({
      db: handle.db,
      conversation: createConversation(handle.db, { userId: "synthetic", datasourceId: "ds-1" }),
      userId: "synthetic",
      bus: new RunEventBus(),
      createSession: async () => {
        throw new Error("session creation is not part of this test");
      },
    });
    expect(runtime.permissions).toEqual({ skills: false, mcp: false, reports: false, memory: false });
  });
});
