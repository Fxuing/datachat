import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Db } from "../db/client.js";
import { skills } from "../db/schema.js";

export interface MaterializeSkillsInput {
  conversationId: string;
  datasourceId: string;
  dataDir: string;
}

interface ApplicableSkill {
  name: string;
  description: string;
  content: string;
}

/** Skills visible to a conversation: global first, then datasource-scoped by name override. */
function loadApplicableSkills(db: Db, datasourceId: string): ApplicableSkill[] {
  const rows = db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.enabled, 1),
        or(isNull(skills.datasourceId), eq(skills.datasourceId, datasourceId)),
      ),
    )
    .all();

  const byName = new Map<string, ApplicableSkill>();
  for (const row of rows) {
    if (row.scope !== "global") continue;
    byName.set(row.name, { name: row.name, description: row.description, content: row.content });
  }
  for (const row of rows) {
    if (row.scope !== "datasource") continue;
    byName.set(row.name, { name: row.name, description: row.description, content: row.content });
  }
  return [...byName.values()];
}

/** Safe single-segment directory name derived from a skill name. */
export function skillDirectoryName(name: string): string {
  const safe = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  if (!safe) {
    throw new Error(`无效的技能名: ${name}`);
  }
  return safe;
}

function composeSkillFile(skill: ApplicableSkill): string {
  const body = parseFrontmatter(skill.content).body.trim();
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${body}\n`;
}

/**
 * Clear the per-conversation skills directory and write every applicable skill as
 * `<name>/SKILL.md`. Returns the directory the sandboxed `read` tool is rooted at.
 */
export async function materializeSkills(db: Db, input: MaterializeSkillsInput): Promise<string> {
  const skillsDir = path.join(input.dataDir, "skills", input.conversationId);
  await fsp.rm(skillsDir, { recursive: true, force: true });
  await fsp.mkdir(skillsDir, { recursive: true });

  for (const skill of loadApplicableSkills(db, input.datasourceId)) {
    const dir = path.join(skillsDir, skillDirectoryName(skill.name));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "SKILL.md"), composeSkillFile(skill), "utf8");
  }
  return skillsDir;
}

/**
 * Import `agent/skills/<dir>/SKILL.md` into the global skills table. Idempotent by name:
 * existing names (including datasource-scoped overrides) are left untouched.
 */
export function seedSkills(db: Db, agentDir: string): void {
  const skillsRoot = path.join(agentDir, "skills");
  if (!fs.existsSync(skillsRoot)) return;

  const existing = new Set(db.select({ name: skills.name }).from(skills).all().map((row) => row.name));
  const now = Date.now();

  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!fs.existsSync(filePath)) continue;

    const raw = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown }>(raw);
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : entry.name;
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (existing.has(name)) continue;

    db.insert(skills)
      .values({
        id: randomUUID(),
        scope: "global",
        datasourceId: null,
        name,
        description,
        content: body,
        enabled: 1,
        updatedBy: "system",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    existing.add(name);
  }
}
