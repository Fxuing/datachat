import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { eq } from "drizzle-orm";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { insertUser } from "../src/db/repositories/users.js";
import { createDepartment, setUserDepartments } from "../src/db/repositories/departments.js";
import { replaceScopePolicies } from "../src/db/repositories/data-scope.js";
import { createRun, saveRunScopeSnapshot } from "../src/db/repositories/runs.js";
import { datasources, shares } from "../src/db/schema.js";
import { createShare } from "../src/services/shares.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { buildAgentTools } from "../src/agent/tools/index.js";
import type { AgentToolContext } from "../src/agent/tools/context.js";
import { recordAudit } from "../src/services/audit.js";
import { ArtifactStore, type ColumnInfo } from "../src/services/artifacts.js";
import {
  buildReportMarkdown,
  createReport,
  formatReportTitle,
} from "../src/services/reports.js";
import { testConfig } from "./helpers/config.js";

const columns: ColumnInfo[] = [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
];

let root: string;
let db: Db;
let store: ArtifactStore;
let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let otherUserId: string;
let adminId: string;
let cookie: string;
let otherCookie: string;
let adminCookie: string;
let datasourceId: string;
let conversationId: string;
let otherConversationId: string;

const fakeRuntime = {
  bus: new RunEventBus(),
  abort: vi.fn(() => true),
  remove: vi.fn(async () => undefined),
  isBusy: vi.fn(() => false),
  shutdown: vi.fn(async () => undefined),
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-reports-"));
  db = createDb(":memory:").db;
  migrateDb(db);

  const signer = createSessionSigner(testConfig.appSecret);
  userId = randomUUID();
  otherUserId = randomUUID();
  adminId = randomUUID();
  for (const [id, username, role] of [
    [userId, "alice", "user"],
    [otherUserId, "bob", "user"],
    [adminId, "root", "admin"],
  ] as const) {
    insertUser(db, {
      id,
      username,
      passwordHash: await hashPassword(`${username}-pass-123`),
      role,
      createdAt: Date.now(),
    });
  }
  cookie = await signer.sign({ sub: userId, username: "alice", role: "user" });
  otherCookie = await signer.sign({ sub: otherUserId, username: "bob", role: "user" });
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });

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
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  conversationId = createConversation(db, { userId, datasourceId, title: "chat" }).id;
  otherConversationId = createConversation(db, {
    userId,
    datasourceId,
    title: "other chat",
  }).id;

  store = new ArtifactStore(db, path.join(root, "artifacts"));
  await store.init();
  app = await buildApp({
    config: {
      ...testConfig,
      dataDir: root,
      agentAuthPath: path.join(root, "agent", "auth.json"),
    },
    db,
    enableRateLimit: false,
    agentRuntime: fakeRuntime as unknown as RuntimeManager,
    artifacts: store,
  });
});

afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedResult(
  options: {
    userId?: string;
    conversationId?: string;
    runId?: string;
    rows?: unknown[][];
    truncated?: boolean;
  } = {},
): Promise<string> {
  const rows = options.rows ?? [
    [1, "alpha"],
    [2, "beta"],
  ];
  const writer = store.openResult({
    userId: options.userId ?? userId,
    conversationId: options.conversationId ?? conversationId,
    runId: options.runId ?? "run-1",
  });
  for (const row of rows) await writer.write(row);
  const meta = await writer.finish({
    columns,
    rowCount: rows.length,
    truncated: options.truncated ?? false,
  });
  return meta.id;
}

function toolContext(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    db,
    config: { ...testConfig, dataDir: root },
    pools: {} as AgentToolContext["pools"],
    artifacts: store,
    userId,
    conversationId,
    datasourceId,
    runId: "run-tool",
    skillsDir: path.join(root, "skills"),
    ...overrides,
  };
}

function createReportThroughService(
  artifactIds: string[],
  opts: { userId?: string; conversationId?: string; title?: string; markdown?: string } = {},
) {
  return createReport({
    db,
    artifacts: store,
    userId: opts.userId ?? userId,
    conversationId: opts.conversationId ?? conversationId,
    artifactIds,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.markdown !== undefined ? { markdown: opts.markdown } : {}),
  });
}

async function postReport(
  body: unknown,
  sessionCookie = cookie,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/reports",
    cookies: { dc_session: sessionCookie },
    payload: body as Record<string, unknown>,
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe("reports service", () => {
  it("creates a report with the default title, markdown placeholder and SQL", async () => {
    const artifactId = await seedResult({ runId: "run-sql" });
    recordAudit(db, {
      runId: "run-sql",
      conversationId,
      userId,
      datasourceId,
      action: "query",
      sqlText: "select id, name from users",
      status: "ok",
    });

    const result = createReportThroughService([artifactId]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.title).toMatch(/^分析报告 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(result.report.artifactIds).toEqual([artifactId]);
    expect(result.report.markdown).toContain(`[[artifact:${artifactId}]]`);
    expect(result.report.markdown).toContain("select id, name from users");
    expect(result.report.markdown).toContain("行数：2");
  });

  it("formats the default title from the supplied time", () => {
    expect(formatReportTitle(new Date(2026, 10, 6, 9, 5))).toBe("分析报告 2026-11-06 09:05");
  });

  it("keeps a supplied title and model-authored markdown", async () => {
    const artifactId = await seedResult();

    const result = createReportThroughService([artifactId], {
      title: "本周概览",
      markdown: `# 本周概览\n\n[[artifact:${artifactId}]]`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.title).toBe("本周概览");
    expect(result.report.markdown).toBe(`# 本周概览\n\n[[artifact:${artifactId}]]`);
  });

  it("describes chart artifacts by their spec title", async () => {
    const chart = store.createChart({
      userId,
      conversationId,
      runId: "run-1",
      columns,
      rowCount: 2,
      spec: { chart: { title: "月度趋势" }, option: {} },
    });

    const markdown = buildReportMarkdown(db, [store.get(chart.id)!]);
    expect(markdown).toContain("图表：月度趋势");
    expect(markdown).toContain(`[[artifact:${chart.id}]]`);
  });

  it("rejects empty and oversized artifact lists", async () => {
    expect(createReportThroughService([])).toMatchObject({ ok: false, code: "EMPTY_ARTIFACTS" });
    expect(
      createReportThroughService(Array.from({ length: 21 }, () => randomUUID())),
    ).toMatchObject({ ok: false, code: "TOO_MANY_ARTIFACTS" });
  });

  it("rejects a conversation owned by another user", async () => {
    expect(
      createReportThroughService([randomUUID()], { userId: otherUserId }),
    ).toMatchObject({ ok: false, code: "CONVERSATION_NOT_FOUND" });
  });

  it("rejects an artifact from another conversation", async () => {
    const artifactId = await seedResult({ conversationId: otherConversationId });
    expect(createReportThroughService([artifactId])).toMatchObject({
      ok: false,
      code: "ARTIFACT_CONVERSATION_MISMATCH",
    });
  });

  it("rejects an artifact owned by another user", async () => {
    const artifactId = await seedResult({ userId: otherUserId });
    expect(createReportThroughService([artifactId])).toMatchObject({
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
    });
  });
});

describe("reports api", () => {
  it("creates a report and returns it to the owner", async () => {
    const artifactId = await seedResult();
    const created = await postReport({ conversationId, artifactIds: [artifactId] });
    expect(created.statusCode).toBe(201);

    const report = created.body.report as { id: string; title: string; markdown: string };
    expect(report.title).toMatch(/^分析报告 /);
    expect(report.markdown).toContain(`[[artifact:${artifactId}]]`);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      report: {
        id: report.id,
        conversationId,
        artifactIds: [artifactId],
      },
    });
  });

  it("returns 404 to other users and 200 to admins", async () => {
    const artifactId = await seedResult();
    const created = await postReport({ conversationId, artifactIds: [artifactId] });
    const report = created.body.report as { id: string };

    const denied = await app.inject({
      method: "GET",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: otherCookie },
    });
    expect(denied.statusCode).toBe(404);

    const allowed = await app.inject({
      method: "GET",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("rejects a cross-conversation artifact and an empty list", async () => {
    const artifactId = await seedResult({ conversationId: otherConversationId });
    const mismatch = await postReport({ conversationId, artifactIds: [artifactId] });
    expect(mismatch.statusCode).toBe(400);

    const empty = await postReport({ conversationId, artifactIds: [] });
    expect(empty.statusCode).toBe(400);
  });

  it("deletes for the owner only, then reports 404", async () => {
    const artifactId = await seedResult();
    const created = await postReport({ conversationId, artifactIds: [artifactId] });
    const report = created.body.report as { id: string };

    const denied = await app.inject({
      method: "DELETE",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: otherCookie },
    });
    expect(denied.statusCode).toBe(404);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: cookie },
    });
    expect(removed.statusCode).toBe(204);

    const missing = await app.inject({
      method: "GET",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("updates title and markdown for the owner, rejects foreign users and invalid payloads", async () => {
    const artifactId = await seedResult();
    const created = await postReport({
      conversationId,
      title: "初版报告",
      markdown: `## 初版\n\n[[artifact:${artifactId}]]`,
      artifactIds: [artifactId],
    });
    const report = created.body.report as { id: string; updatedAt: number };

    const denied = await app.inject({
      method: "PATCH",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: otherCookie },
      payload: { title: "篡改标题" },
    });
    expect(denied.statusCode).toBe(404);

    const invalidEmpty = await app.inject({
      method: "PATCH",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: cookie },
      payload: {},
    });
    expect(invalidEmpty.statusCode).toBe(400);

    const invalidBlankMarkdown = await app.inject({
      method: "PATCH",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: cookie },
      payload: { markdown: "   " },
    });
    expect(invalidBlankMarkdown.statusCode).toBe(400);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: cookie },
      payload: {
        title: "终版经营报告",
        markdown: `## 终版结论\n\n[[artifact:${artifactId}]]`,
      },
    });
    expect(updated.statusCode).toBe(200);
    const body = updated.json() as {
      report: { id: string; title: string; markdown: string; artifactIds: string[]; updatedAt: number };
    };
    expect(body.report.title).toBe("终版经营报告");
    expect(body.report.markdown).toBe(`## 终版结论\n\n[[artifact:${artifactId}]]`);
    expect(body.report.artifactIds).toEqual([artifactId]);
    expect(body.report.updatedAt).toBeGreaterThanOrEqual(report.updatedAt);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/reports/${report.id}`,
      cookies: { dc_session: cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      report: {
        title: "终版经营报告",
        markdown: `## 终版结论\n\n[[artifact:${artifactId}]]`,
      },
    });
  });
});

describe("create_report tool", () => {
  it("is registered in buildAgentTools and documents report page export formats", () => {
    const tools = buildAgentTools(toolContext(), { canCreateReports: true });
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("create_report");
    const reportTool = tools.find((item) => item.name === "create_report")!;
    expect(reportTool.description).toContain("Word .docx");
    expect(reportTool.description).toContain("Markdown");
    expect(reportTool.description).toContain("HTML");
  });

  it("creates a report from model-authored markdown", async () => {
    const artifactId = await seedResult();
    const tool = buildAgentTools(toolContext(), { canCreateReports: true }).find((item) => item.name === "create_report")!;

    const result = await tool.execute(
      "call-1",
      {
        title: "销售分析",
        markdown: `## 结论\n\n[[artifact:${artifactId}]]`,
        artifactIds: [artifactId],
      } as never,
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.isError).toBeFalsy();
    const details = result.details as { reportId: string; title: string; url: string };
    expect(details.title).toBe("销售分析");
    expect(details.url).toBe(`/reports/${details.reportId}`);
    const textContent = result.content.find((item) => item.type === "text");
    expect(textContent?.text).toContain(`[查看完整报告](/reports/${details.reportId})`);
    expect(textContent?.text).toContain("Word（.docx）");

    const fetched = await app.inject({
      method: "GET",
      url: `/api/reports/${details.reportId}`,
      cookies: { dc_session: cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      report: {
        title: "销售分析",
        markdown: `## 结论\n\n[[artifact:${artifactId}]]`,
        artifactIds: [artifactId],
      },
    });
  });

  it("returns an error result for a foreign artifact", async () => {
    const artifactId = await seedResult({ userId: otherUserId });
    const tool = buildAgentTools(toolContext(), { canCreateReports: true }).find((item) => item.name === "create_report")!;

    const result = await tool.execute(
      "call-1",
      { markdown: `[[artifact:${artifactId}]]`, artifactIds: [artifactId] } as never,
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.isError).toBe(true);
    expect((result.details as { code: string }).code).toBe("ARTIFACT_NOT_FOUND");
  });

  it("rejects excel artifacts in createReport service and HTTP route", async () => {
    const resultId = await seedResult();
    const excel = store.createExcel({
      conversationId,
      userId,
      runId: null,
      spec: {
        filename: "销售汇总",
        sheets: [{ name: "汇总", artifactId: resultId, rowCount: 2 }],
        totalRows: 2,
      },
      rowCount: 2,
    });

    const created = createReport({
      db,
      artifacts: store,
      userId,
      conversationId,
      artifactIds: [excel.id],
    });
    expect(created).toMatchObject({ ok: false, code: "INVALID_ARTIFACT_KIND" });

    const response = await app.inject({
      method: "POST",
      url: "/api/reports",
      cookies: { dc_session: cookie },
      payload: {
        conversationId,
        artifactIds: [excel.id],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.message).toContain("Excel");
  });
});

describe("reports list and delete share cleanup", () => {
  it("lists own reports with q/source/datasource filters, pagination, and data-scope filtering", async () => {
    const art1 = await seedResult({ runId: "run-a" });
    const art2 = await seedResult({
      conversationId: otherConversationId,
      runId: "run-b",
    });
    const scheduledConv = createConversation(db, {
      userId,
      datasourceId,
      kind: "scheduled",
      title: "每日任务",
    });
    const artSched = await seedResult({
      conversationId: scheduledConv.id,
      runId: "run-s",
    });
    const otherUserConv = createConversation(db, {
      userId: otherUserId,
      datasourceId,
      title: "他人会话",
    });
    const foreignArt = await seedResult({
      userId: otherUserId,
      conversationId: otherUserConv.id,
      runId: "run-f",
    });

    createReport({
      db,
      artifacts: store,
      userId,
      conversationId,
      artifactIds: [art1],
      title: "100%_营收分析",
    });
    createReport({
      db,
      artifacts: store,
      userId,
      conversationId: otherConversationId,
      artifactIds: [art2],
      title: "用户留存周报",
    });
    createReport({
      db,
      artifacts: store,
      userId,
      conversationId: scheduledConv.id,
      artifactIds: [artSched],
      title: "每日自动日报",
    });
    createReport({
      db,
      artifacts: store,
      userId: otherUserId,
      conversationId: otherUserConv.id,
      artifactIds: [foreignArt],
      title: "他人报告",
    });

    const all = await app.inject({
      method: "GET",
      url: "/api/reports",
      cookies: { dc_session: cookie },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(3);
    expect(all.json().reports.map((r: { title: string }) => r.title)).not.toContain("他人报告");

    // Literal % and _ in q must not match arbitrary rows.
    const literalSearch = await app.inject({
      method: "GET",
      url: `/api/reports?q=${encodeURIComponent("100%_")}`,
      cookies: { dc_session: cookie },
    });
    expect(literalSearch.statusCode).toBe(200);
    expect(literalSearch.json().reports.map((r: { title: string }) => r.title)).toEqual([
      "100%_营收分析",
    ]);

    const scheduledOnly = await app.inject({
      method: "GET",
      url: "/api/reports?source=scheduled",
      cookies: { dc_session: cookie },
    });
    expect(scheduledOnly.statusCode).toBe(200);
    expect(scheduledOnly.json().reports.map((r: { title: string }) => r.title)).toEqual([
      "每日自动日报",
    ]);

    const paged = await app.inject({
      method: "GET",
      url: "/api/reports?limit=2&offset=1",
      cookies: { dc_session: cookie },
    });
    expect(paged.statusCode).toBe(200);
    expect(paged.json().total).toBe(3);
    expect(paged.json().reports).toHaveLength(2);

    // Enable data scope: reports pointing at runs outside the viewer's current scope are hidden.
    const deptA = createDepartment(db, { name: "华东区", code: "east" });
    const deptB = createDepartment(db, { name: "华南区", code: "south" });
    setUserDepartments(db, userId, [deptA.id]);
    db.update(datasources)
      .set({ dataScopeMode: "enabled" })
      .where(eq(datasources.id, datasourceId))
      .run();
    replaceScopePolicies(db, datasourceId, [{ tableName: "orders", mode: "public", rules: [] }]);

    const scopedConv = createConversation(db, { userId, datasourceId, title: "受控会话" });
    const inScopeRun = createRun(db, {
      conversationId: scopedConv.id,
      userId,
    });
    saveRunScopeSnapshot(
      db,
      inScopeRun.id,
      JSON.stringify({
        v: 1,
        datasourceId,
        departments: [deptA.id],
        policyHash: "h1",
      }),
    );
    const outScopeRun = createRun(db, {
      conversationId: scopedConv.id,
      userId,
    });
    saveRunScopeSnapshot(
      db,
      outScopeRun.id,
      JSON.stringify({
        v: 1,
        datasourceId,
        departments: [deptB.id],
        policyHash: "h1",
      }),
    );
    const inArt = await seedResult({ conversationId: scopedConv.id, runId: inScopeRun.id });
    const outArt = await seedResult({ conversationId: scopedConv.id, runId: outScopeRun.id });
    createReport({
      db,
      artifacts: store,
      userId,
      conversationId: scopedConv.id,
      artifactIds: [inArt],
      title: "范围内报告",
    });
    createReport({
      db,
      artifacts: store,
      userId,
      conversationId: scopedConv.id,
      artifactIds: [outArt],
      title: "越权历史报告",
    });

    const afterScope = await app.inject({
      method: "GET",
      url: "/api/reports",
      cookies: { dc_session: cookie },
    });
    expect(afterScope.statusCode).toBe(200);
    const titles = afterScope.json().reports.map((r: { title: string }) => r.title);
    expect(titles).toContain("范围内报告");
    expect(titles).not.toContain("越权历史报告");
  });

  it("revokes active shares when deleting a report", async () => {
    const artifactId = await seedResult();
    const created = createReport({
      db,
      artifacts: store,
      userId,
      conversationId,
      artifactIds: [artifactId],
      title: "待删除报告",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const share = createShare({ db, userId, reportId: created.report.id });
    expect(share.ok).toBe(true);
    if (!share.ok) return;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/reports/${created.report.id}`,
      cookies: { dc_session: cookie },
    });
    expect(del.statusCode).toBe(204);

    const row = db.select().from(shares).where(eq(shares.id, share.share.id)).get();
    expect(row?.revokedAt).not.toBeNull();

    const pub = await app.inject({
      method: "GET",
      url: `/api/public/shares/${share.share.token}`,
    });
    expect(pub.statusCode).toBe(410);
  });
});
