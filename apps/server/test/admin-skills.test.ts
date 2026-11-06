import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { queryAudit, skills } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { testConfig } from "./helpers/config.js";

const config = testConfig;

let db: Db;
let adminId: string;
let adminCookie: string;
let userCookie: string;
let datasourceId: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  adminId = randomUUID();
  const userId = randomUUID();
  insertUser(db, {
    id: adminId,
    username: "root",
    passwordHash: await hashPassword("admin-pass"),
    role: "admin",
    createdAt: Date.now(),
  });
  insertUser(db, {
    id: userId,
    username: "bob",
    passwordHash: await hashPassword("user-pass"),
    role: "user",
    createdAt: Date.now(),
  });
  datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "demo",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "demo",
    username: "demo",
    passwordCipher: "cipher",
    createdBy: adminId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const signer = createSessionSigner(config.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  userCookie = await signer.sign({ sub: userId, username: "bob", role: "user" });
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

const validSkill = {
  name: "sales-rules",
  description: "销售口径",
  content: "---\nname: stale-name\ndescription: stale description\n---\n\n按月份统计订单金额。\n",
  scope: "global" as const,
};

describe("admin skills", () => {
  it("lists skills for admins only, without content", async () => {
    const a = await app();
    await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: validSkill,
    });

    const list = await a.inject({
      method: "GET",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const [skill] = list.json().skills;
    expect(skill).toMatchObject({
      name: "sales-rules",
      description: "销售口径",
      scope: "global",
      datasourceId: null,
      enabled: true,
    });
    expect(skill.content).toBeUndefined();
    expect(JSON.stringify(list.json())).not.toContain("按月份统计订单金额");

    const denied = await a.inject({
      method: "GET",
      url: "/api/admin/skills",
      cookies: { dc_session: userCookie },
    });
    expect(denied.statusCode).toBe(403);
    await a.close();
  });

  it("returns stored raw content when a skill row cannot be parsed", async () => {
    const a = await app();
    const id = randomUUID();
    const content = "---\nname: broken\nbody without terminator";
    db.insert(skills)
      .values({
        id,
        scope: "global",
        datasourceId: null,
        name: "broken",
        description: "损坏的技能",
        content,
        enabled: 1,
        updatedBy: adminId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();

    const response = await a.inject({
      method: "GET",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().skill).toMatchObject({
      id,
      name: "broken",
      content,
      contentInvalid: true,
    });
    await a.close();
  });

  it("validates the input matrix", async () => {
    const a = await app();
    const cases: Array<{ name: string; payload: Record<string, unknown> }> = [
      { name: "uppercase name", payload: { ...validSkill, name: "Sales-Rules" } },
      { name: "single char name", payload: { ...validSkill, name: "a" } },
      { name: "name with underscore", payload: { ...validSkill, name: "sales_rules" } },
      { name: "empty description", payload: { ...validSkill, description: "   " } },
      { name: "long description", payload: { ...validSkill, description: "d".repeat(501) } },
      { name: "empty content", payload: { ...validSkill, content: "" } },
      { name: "long content", payload: { ...validSkill, content: "c".repeat(20_001) } },
      { name: "invalid scope", payload: { ...validSkill, scope: "team" } },
      {
        name: "global with datasource",
        payload: { ...validSkill, datasourceId },
      },
      {
        name: "datasource without id",
        payload: { ...validSkill, scope: "datasource" },
      },
      {
        name: "datasource unknown id",
        payload: { ...validSkill, scope: "datasource", datasourceId: randomUUID() },
      },
      {
        name: "malformed frontmatter",
        payload: { ...validSkill, content: "---\nname: broken\n\nno closing fence" },
      },
    ];

    for (const testCase of cases) {
      const response = await a.inject({
        method: "POST",
        url: "/api/admin/skills",
        cookies: { dc_session: adminCookie },
        payload: testCase.payload,
      });
      expect(response.statusCode, testCase.name).toBe(400);
      expect(response.json().error.code, testCase.name).toBe("VALIDATION");
    }
    expect(db.select().from(skills).all()).toHaveLength(0);
    await a.close();
  });

  it("creates a skill and rewrites mismatched frontmatter", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: validSkill,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().skill.id;

    const detail = await a.inject({
      method: "GET",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    const content = detail.json().skill.content as string;
    const parsed = parseFrontmatter<{ name: string; description: string }>(content);
    expect(parsed.frontmatter.name).toBe("sales-rules");
    expect(parsed.frontmatter.description).toBe("销售口径");
    expect(parsed.body).toBe("按月份统计订单金额。");
    expect(content).not.toContain("stale-name");

    // Bare bodies are accepted and get a frontmatter block prepended.
    const bare = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: { ...validSkill, name: "bare-body", content: "只有正文" },
    });
    expect(bare.statusCode).toBe(201);
    expect(bare.json().skill.content).toContain('name: "bare-body"');
    expect(bare.json().skill.content).toContain("只有正文");
    await a.close();
  });

  it("enforces name uniqueness per scope and datasource", async () => {
    const a = await app();
    const first = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: validSkill,
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: validSkill,
    });
    expect(duplicate.statusCode).toBe(409);

    // A datasource-scoped skill may override a global name.
    const override = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: { ...validSkill, scope: "datasource", datasourceId },
    });
    expect(override.statusCode).toBe(201);

    const duplicateOverride = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: { ...validSkill, scope: "datasource", datasourceId },
    });
    expect(duplicateOverride.statusCode).toBe(409);
    await a.close();
  });

  it("updates a skill, rewrites frontmatter and supports scope switches", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: validSkill,
    });
    const id = created.json().skill.id;

    const renamed = await a.inject({
      method: "PATCH",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { name: "sales-rules-v2", description: "新口径", enabled: false },
    });
    expect(renamed.statusCode).toBe(200);
    const renamedSkill = renamed.json().skill;
    expect(renamedSkill.name).toBe("sales-rules-v2");
    expect(renamedSkill.enabled).toBe(false);
    const parsed = parseFrontmatter<{ name: string; description: string }>(
      renamedSkill.content as string,
    );
    expect(parsed.frontmatter.name).toBe("sales-rules-v2");
    expect(parsed.frontmatter.description).toBe("新口径");
    expect(parsed.body).toBe("按月份统计订单金额。");

    const scoped = await a.inject({
      method: "PATCH",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { scope: "datasource", datasourceId },
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().skill.datasourceId).toBe(datasourceId);

    const global = await a.inject({
      method: "PATCH",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { scope: "global", datasourceId: null },
    });
    expect(global.statusCode).toBe(200);
    expect(global.json().skill.datasourceId).toBeNull();

    const missing = await a.inject({
      method: "PATCH",
      url: `/api/admin/skills/${randomUUID()}`,
      cookies: { dc_session: adminCookie },
      payload: { description: "x" },
    });
    expect(missing.statusCode).toBe(404);

    const invalidSwitch = await a.inject({
      method: "PATCH",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { scope: "datasource" },
    });
    expect(invalidSwitch.statusCode).toBe(400);
    await a.close();
  });

  it("deletes a skill and reports unknown ids", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: validSkill,
    });
    const id = created.json().skill.id;

    const deleted = await a.inject({
      method: "DELETE",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(db.select().from(skills).all()).toHaveLength(0);

    const again = await a.inject({
      method: "DELETE",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(again.statusCode).toBe(404);
    await a.close();
  });

  it("seeds built-in skills idempotently and returns counts", async () => {
    const a = await app();
    const first = await a.inject({
      method: "POST",
      url: "/api/admin/skills/seed",
      cookies: { dc_session: adminCookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ imported: 3, skipped: 0 });
    expect(db.select().from(skills).all()).toHaveLength(3);

    const second = await a.inject({
      method: "POST",
      url: "/api/admin/skills/seed",
      cookies: { dc_session: adminCookie },
    });
    expect(second.json()).toEqual({ imported: 0, skipped: 3 });
    expect(db.select().from(skills).all()).toHaveLength(3);

    const denied = await a.inject({
      method: "POST",
      url: "/api/admin/skills/seed",
      cookies: { dc_session: userCookie },
    });
    expect(denied.statusCode).toBe(403);
    await a.close();
  });

  it("audits skill changes without storing content", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/skills",
      cookies: { dc_session: adminCookie },
      payload: validSkill,
    });
    const id = created.json().skill.id;
    await a.inject({
      method: "PATCH",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
      payload: { enabled: false },
    });
    await a.inject({
      method: "DELETE",
      url: `/api/admin/skills/${id}`,
      cookies: { dc_session: adminCookie },
    });

    const rows = db
      .select()
      .from(queryAudit)
      .all()
      .filter((row) => row.action === "skill_change");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const detail = JSON.parse(row.detailJson ?? "{}") as Record<string, unknown>;
      expect(detail).toMatchObject({ name: "sales-rules", scope: "global" });
      expect(detail).not.toHaveProperty("content");
      expect(row.sqlText).toBe("");
    }
    expect(JSON.parse(rows[0]!.detailJson!)).toEqual({
      name: "sales-rules",
      scope: "global",
      enabled: true,
      ip: expect.any(String),
    });
    await a.close();
  });
});
