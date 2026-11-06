import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Db } from "../db/client.js";
import { datasources, skills } from "../db/schema.js";
import { seedSkills } from "../agent/skills.js";
import { safeRecordAuditEvent } from "../services/audit.js";

export interface AdminSkillRouteOptions {
  db: Db;
  /** Repo-level agent assets; the seed endpoint re-imports `<agentDir>/skills`. */
  agentDir: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CONTENT_LENGTH = 20_000;

const skillInputSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(NAME_PATTERN, "名称需为 2-64 位小写字母、数字或短横线，且以字母或数字开头"),
  description: z
    .string()
    .trim()
    .min(1, "描述不能为空")
    .max(MAX_DESCRIPTION_LENGTH, `描述最多 ${MAX_DESCRIPTION_LENGTH} 个字符`),
  content: z
    .string()
    .min(1, "内容不能为空")
    .max(MAX_CONTENT_LENGTH, `内容最多 ${MAX_CONTENT_LENGTH} 个字符`),
  scope: z.enum(["global", "datasource"]),
  datasourceId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});

const createSkillSchema = skillInputSchema;
const updateSkillSchema = skillInputSchema.partial();
const idParamsSchema = z.object({ id: z.string().min(1) });

class SkillContentError extends Error {}

/**
 * Skills are stored as full `SKILL.md` documents: validate/parse the incoming
 * frontmatter and rewrite it with the canonical name/description so renaming a
 * skill cannot leave a stale runtime name behind. Bare bodies are accepted and
 * get a frontmatter block prepended (seeded built-ins are stored as bodies).
 */
export function normalizeSkillContent(raw: string, name: string, description: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  let body = normalized;
  if (normalized.startsWith("---")) {
    if (!normalized.slice(3).includes("\n---")) {
      throw new SkillContentError("内容 frontmatter 缺少结束分隔符 ---");
    }
    try {
      body = parseFrontmatter(normalized).body;
    } catch {
      throw new SkillContentError("内容 frontmatter 不是合法 YAML");
    }
  }
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(
    description,
  )}\n---\n\n${body.trim()}\n`;
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new SkillContentError(`内容（含 frontmatter）最多 ${MAX_CONTENT_LENGTH} 个字符`);
  }
  return content;
}

type SkillRow = typeof skills.$inferSelect;

interface SkillView {
  id: string;
  name: string;
  description: string;
  scope: "global" | "datasource";
  datasourceId: string | null;
  enabled: boolean;
  updatedAt: number;
}

function toSkillView(row: SkillRow): SkillView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    datasourceId: row.datasourceId,
    enabled: row.enabled === 1,
    updatedAt: row.updatedAt,
  };
}

function toDetailView(
  row: SkillRow,
): SkillView & { content: string; createdAt: number; contentInvalid?: boolean } {
  try {
    return {
      ...toSkillView(row),
      content: normalizeSkillContent(row.content, row.name, row.description),
      createdAt: row.createdAt,
    };
  } catch (error) {
    if (!(error instanceof SkillContentError)) throw error;
    // Stored rows can predate validation (or be edited directly); keep the editor
    // usable by returning the raw document instead of failing the whole request.
    return {
      ...toSkillView(row),
      content: row.content,
      createdAt: row.createdAt,
      contentInvalid: true,
    };
  }
}

function findSkill(db: Db, id: string): SkillRow | undefined {
  return db.select().from(skills).where(eq(skills.id, id)).get();
}

function datasourceExists(db: Db, id: string): boolean {
  return Boolean(db.select({ id: datasources.id }).from(datasources).where(eq(datasources.id, id)).get());
}

/** `name` is unique within a scope+datasource pair; a datasource may override a global name. */
function findDuplicateSkill(
  db: Db,
  input: { name: string; scope: "global" | "datasource"; datasourceId: string | null },
  excludeId?: string,
): SkillRow | undefined {
  const rows = db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.name, input.name),
        eq(skills.scope, input.scope),
        input.scope === "global" ? isNull(skills.datasourceId) : eq(skills.datasourceId, input.datasourceId as string),
      ),
    )
    .all();
  return rows.find((row) => row.id !== excludeId);
}

function validationError(details: unknown): { error: { code: string; message: string; details: unknown } } {
  return { error: { code: "VALIDATION", message: "参数不合法", details } };
}

export async function adminSkillRoutes(
  app: FastifyInstance,
  opts: AdminSkillRouteOptions,
): Promise<void> {
  const { db, agentDir } = opts;

  const audit = (request: FastifyRequest, detail: Record<string, unknown>) => {
    safeRecordAuditEvent(db, {
      actorUserId: request.authUser?.id ?? request.user?.sub ?? null,
      action: "skill_change",
      ip: request.ip,
      detail,
    });
  };

  app.get("/api/admin/skills", { preHandler: app.requireAdmin }, async () => {
    const rows = db.select().from(skills).orderBy(asc(skills.name)).all();
    return { skills: rows.map((row) => toSkillView(row)) };
  });

  app.get("/api/admin/skills/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "技能不存在" } });
    const row = findSkill(db, params.data.id);
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "技能不存在" } });
    return { skill: toDetailView(row) };
  });

  app.post("/api/admin/skills", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = createSkillSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(validationError(parsed.error.flatten()));
    const input = parsed.data;
    const datasourceId = input.scope === "global" ? null : (input.datasourceId ?? null);

    if (input.scope === "global" && input.datasourceId != null) {
      return reply
        .code(400)
        .send(validationError({ fieldErrors: { datasourceId: ["全局技能不能指定数据源"] }, formErrors: [] }));
    }
    if (input.scope === "datasource" && !datasourceId) {
      return reply
        .code(400)
        .send(
          validationError({ fieldErrors: { datasourceId: ["数据源技能必须选择数据源"] }, formErrors: [] }),
        );
    }
    if (datasourceId && !datasourceExists(db, datasourceId)) {
      return reply
        .code(400)
        .send(validationError({ fieldErrors: { datasourceId: ["数据源不存在"] }, formErrors: [] }));
    }
    if (findDuplicateSkill(db, { name: input.name, scope: input.scope, datasourceId })) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: "同一范围内技能名称已存在" } });
    }

    let content: string;
    try {
      content = normalizeSkillContent(input.content, input.name, input.description);
    } catch (error) {
      if (error instanceof SkillContentError) {
        return reply
          .code(400)
          .send(validationError({ fieldErrors: { content: [error.message] }, formErrors: [] }));
      }
      throw error;
    }

    const now = Date.now();
    const row: SkillRow = {
      id: randomUUID(),
      scope: input.scope,
      datasourceId,
      name: input.name,
      description: input.description,
      content,
      enabled: input.enabled === false ? 0 : 1,
      updatedBy: request.user!.sub,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(skills).values(row).run();
    audit(request, { name: row.name, scope: row.scope, enabled: row.enabled === 1 });
    return reply.code(201).send({ skill: toDetailView(row) });
  });

  app.patch("/api/admin/skills/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const parsed = updateSkillSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply
        .code(400)
        .send(validationError(parsed.success ? {} : parsed.error.flatten()));
    }
    const row = findSkill(db, params.data.id);
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "技能不存在" } });

    const input = parsed.data;
    const nextScope = input.scope ?? row.scope;
    const nextName = input.name ?? row.name;
    const nextDescription = input.description ?? row.description;
    let nextDatasourceId =
      input.datasourceId !== undefined ? input.datasourceId : row.datasourceId;

    if (nextScope === "global") {
      if (nextDatasourceId != null) {
        return reply
          .code(400)
          .send(
            validationError({
              fieldErrors: { datasourceId: ["全局技能不能指定数据源"] },
              formErrors: [],
            }),
          );
      }
      nextDatasourceId = null;
    } else if (!nextDatasourceId) {
      return reply
        .code(400)
        .send(
          validationError({
            fieldErrors: { datasourceId: ["数据源技能必须选择数据源"] },
            formErrors: [],
          }),
        );
    } else if (!datasourceExists(db, nextDatasourceId)) {
      return reply
        .code(400)
        .send(validationError({ fieldErrors: { datasourceId: ["数据源不存在"] }, formErrors: [] }));
    }

    if (
      findDuplicateSkill(
        db,
        { name: nextName, scope: nextScope, datasourceId: nextDatasourceId },
        row.id,
      )
    ) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: "同一范围内技能名称已存在" } });
    }

    let content: string;
    try {
      content = normalizeSkillContent(input.content ?? row.content, nextName, nextDescription);
    } catch (error) {
      if (error instanceof SkillContentError) {
        return reply
          .code(400)
          .send(validationError({ fieldErrors: { content: [error.message] }, formErrors: [] }));
      }
      throw error;
    }

    const updated: SkillRow = {
      ...row,
      scope: nextScope,
      datasourceId: nextDatasourceId,
      name: nextName,
      description: nextDescription,
      content,
      enabled: input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
      updatedBy: request.user!.sub,
      updatedAt: Date.now(),
    };
    db.update(skills)
      .set({
        scope: updated.scope,
        datasourceId: updated.datasourceId,
        name: updated.name,
        description: updated.description,
        content: updated.content,
        enabled: updated.enabled,
        updatedBy: updated.updatedBy,
        updatedAt: updated.updatedAt,
      })
      .where(eq(skills.id, row.id))
      .run();
    audit(request, { name: updated.name, scope: updated.scope, enabled: updated.enabled === 1 });
    return { skill: toDetailView(updated) };
  });

  app.delete("/api/admin/skills/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "技能不存在" } });
    const row = findSkill(db, params.data.id);
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "技能不存在" } });
    db.delete(skills).where(eq(skills.id, row.id)).run();
    audit(request, { name: row.name, scope: row.scope, enabled: row.enabled === 1 });
    return { ok: true };
  });

  app.post("/api/admin/skills/seed", { preHandler: app.requireAdmin }, async (request) => {
    const result = seedSkills(db, agentDir);
    audit(request, { mode: "seed", imported: result.imported, skipped: result.skipped });
    return result;
  });
}
