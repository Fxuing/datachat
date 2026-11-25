import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { bootstrapAdmin } from "../src/auth/bootstrap.js";
import { hashPassword } from "../src/auth/password.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import { RuntimeManager } from "../src/agent/runtime.js";
import { PoolRegistry } from "../src/agent/datasource/pool.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { createDepartment, setUserDepartments } from "../src/db/repositories/departments.js";
import { importDepartmentMappings, upsertScopePolicy } from "../src/db/repositories/data-scope.js";
import { applyScopeToSql } from "../src/services/data-scope.js";
import { insertSemanticMetric } from "../src/db/repositories/semantic-layer.js";
import { insertSqlExample } from "../src/db/repositories/sql-examples.js";
import { signWebhookPayload } from "../src/services/open-platform-webhook.js";
import { openApiKeys, runFeedback, conversations as conversationsTable } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { insertLlmProvider } from "../src/db/repositories/llm-providers.js";
import { saveSettings } from "../src/services/app-settings.js";
import { createAgentModelRuntime, modelKey, resolveConversationModel } from "../src/agent/model-runtime.js";
import { enabledProviderIds } from "../src/services/llm-catalog.js";
import type { AppConfig } from "../src/config.js";
import { testConfig } from "./helpers/config.js";
import { FakeAgentSession, asAgentSession } from "./helpers/fake-agent-session.js";

describe("open platform", () => {
  let tmpDir: string;
  let config: AppConfig;
  let handle: DbHandle;
  let app: FastifyInstance;
  let adminCookie: string;
  let memberCookie: string;
  let adminId: string;
  let memberId: string;
  let datasourceId: string;
  let datasource2Id: string;
  let artifacts: ArtifactStore;
  let webhookCalls: Array<{ url: string; headers: Record<string, string>; body: string }>;
  let lastScopeOverride: unknown;
  let lastExtraInstructions: string | undefined;

  async function loginAs(username: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "dc_session");
    return `${cookie!.name}=${cookie!.value}`;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-open-platform-"));
    config = {
      ...testConfig,
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, "datachat.db"),
      adminUsername: "admin",
      adminPassword: "admin-password-123",
    };
    handle = createDb(":memory:");
    migrateDb(handle.db);
    await bootstrapAdmin(handle.db, config);

    const adminRow = handle.sqlite
      .prepare("SELECT id FROM users WHERE username = 'admin'")
      .get() as { id: string };
    adminId = adminRow.id;

    memberId = randomUUID();
    insertUser(handle.db, {
      id: memberId,
      username: "analyst",
      passwordHash: await hashPassword("member-password-123"),
      displayName: "分析师",
      role: "user",
      createdAt: Date.now(),
    });

    datasourceId = randomUUID();
    datasource2Id = randomUUID();
    const secretKey = deriveSecretKey(config.appSecret);
    const now = Date.now();
    insertDatasource(handle.db, {
      id: datasourceId,
      name: "核心销售库",
      type: "mysql",
      host: "127.0.0.1",
      port: 3306,
      database: "sales",
      username: "ro_user",
      passwordCipher: encryptSecret("ro_secret", secretKey),
      sslMode: "disable",
      readOnlyVerified: 1,
      status: "ok",
      createdBy: adminId,
      createdAt: now,
      updatedAt: now,
    });
    insertDatasource(handle.db, {
      id: datasource2Id,
      name: "财务库",
      type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      database: "finance",
      username: "ro_fin",
      passwordCipher: encryptSecret("fin_secret", secretKey),
      sslMode: "disable",
      readOnlyVerified: 1,
      status: "ok",
      createdBy: adminId,
      createdAt: now,
      updatedAt: now,
    });

    insertSemanticMetric(handle.db, {
      datasourceId,
      name: "销售额",
      synonyms: ["GMV", "营收"],
      description: "已完成订单金额汇总",
      sqlExpression: "SUM(amount)",
      tableName: "orders",
      unit: "元",
    });
    insertSqlExample(handle.db, {
      datasourceId,
      question: "统计本月销售额",
      sqlText: "SELECT SUM(amount) AS total FROM orders LIMIT 10",
      tables: ["orders"],
      createdBy: adminId,
    });

    artifacts = new ArtifactStore(handle.db, path.join(tmpDir, "artifacts"));
    await artifacts.init();
    const pools = new PoolRegistry();
    webhookCalls = [];
    lastScopeOverride = undefined;
    lastExtraInstructions = undefined;

    const runtime = new RuntimeManager({
      config,
      db: handle.db,
      pools,
      artifacts,
      sweepIntervalMs: 0,
      createSession: async ({ conversation, userId, extraInstructions }) => {
        lastExtraInstructions = extraInstructions;
        const fake = new FakeAgentSession();
        const toolContext = {
          db: handle.db,
          config,
          pools,
          artifacts,
          userId,
          conversationId: conversation.id,
          datasourceId: conversation.datasourceId,
          runId: "",
          skillsDir: tmpDir,
        };
        fake.prompt.mockImplementation(async (promptText: string) => {
          lastScopeOverride = (toolContext as { scopeDepartmentOverride?: unknown }).scopeDepartmentOverride;
          // Simulate a guarded query writing a real result artifact + chart artifact
          const writer = artifacts.openResult({
            userId,
            conversationId: conversation.id,
            runId: toolContext.runId,
          });
          await writer.write(["华东", 12500]);
          await writer.write(["华南", 9800]);
          await writer.write(["华北", 7600]);
          const resMeta = await writer.finish({
            columns: [
              { name: "region", type: "string" },
              { name: "sales", type: "number" },
            ],
            rowCount: 3,
            truncated: false,
          });
          const chartMeta = artifacts.createChart({
            conversationId: conversation.id,
            userId,
            runId: toolContext.runId,
            columns: [
              { name: "region", type: "string" },
              { name: "sales", type: "number" },
            ],
            spec: { type: "bar", xField: "region", yField: "sales" },
            rowCount: 3,
          });

          fake.emit({
            type: "tool_execution_end",
            toolCallId: "tc-1",
            toolName: "db_query",
            isError: false,
            result: {
              content: [{ type: "text", text: "{}" }],
              details: {
                artifactId: resMeta.id,
                columns: [
                  { name: "region", type: "string" },
                  { name: "sales", type: "number" },
                ],
                rowCount: 3,
                truncated: false,
                auditId: "audit-1",
                sql: "SELECT region, SUM(amount) AS sales FROM orders GROUP BY region LIMIT 100",
                guard: "ok",
              },
            },
          } as never);

          const text = `根据真实数据查询（针对「${promptText.slice(0, 20)}」），华东销售额最高（12,500 元）。\n\n[[artifact:${resMeta.id}]]\n[[chart:${chartMeta.id}]]`;
          fake.emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: text },
          } as never);
          fake.emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              usage: { input: 120, output: 45, cacheRead: 10, cacheWrite: 0 },
            },
          } as never);
        });
        return { session: asAgentSession(fake), toolContext };
      },
    });

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      webhookCalls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    });

    app = await buildApp({
      config,
      db: handle.db,
      enableRateLimit: false,
      agentRuntime: runtime,
      artifacts,
      pools,
      openWebhookFetch: mockFetch as unknown as typeof fetch,
      openSyncTimeoutMs: 5_000,
    });

    adminCookie = await loginAs("admin", "admin-password-123");
    memberCookie = await loginAs("analyst", "member-password-123");
  });

  afterEach(async () => {
    if (app) await app.close();
    handle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createAppAndKey(overrides: Record<string, unknown> = {}) {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/admin/open-platform/apps",
      headers: { cookie: adminCookie },
      payload: {
        name: `CRM 业务助手-${randomUUID().slice(0, 6)}`,
        description: "为 CRM 提供精准问数与经营报告",
        serviceUserId: adminId,
        allowedDatasourceIds: [datasourceId],
        scopes: ["ask", "report", "semantic", "mcp", "feedback"],
        allowEndUserOverride: true,
        exposeSql: true,
        systemPromptExtra: "金额统一保留两位小数。",
        rateLimitRpm: 60,
        ...overrides,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdApp = (createRes.json() as { app: { id: string; name: string } }).app;

    const keyRes = await app.inject({
      method: "POST",
      url: `/api/admin/open-platform/apps/${createdApp.id}/keys`,
      headers: { cookie: adminCookie },
      payload: { name: "生产密钥" },
    });
    expect(keyRes.statusCode).toBe(201);
    const { key, rawKey } = keyRes.json() as { key: { id: string; keyPrefix: string }; rawKey: string };
    return { openApp: createdApp, key, rawKey };
  }

  it("serves public OpenAPI 3.1 spec without auth and without exposing tenant data or secrets", async () => {
    const { openApp, rawKey } = await createAppAndKey({
      name: "SecretInternalApp",
      webhookSecret: "top-secret-webhook-signing-key",
    });
    const res = await app.inject({ method: "GET", url: "/api/open/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/api/open/v1/ask"]).toBeDefined();
    expect(spec.paths["/api/open/v1/reports/generate"]).toBeDefined();
    expect(spec.paths["/api/open/v1/mcp"]).toBeDefined();
    expect(spec.paths["/api/open/v1/feedback"]).toBeDefined();
    // Never expose tenant names, datasource ids, raw keys, or secrets
    expect(res.body).not.toContain(openApp.name);
    expect(res.body).not.toContain(rawKey);
    expect(res.body).not.toContain(datasourceId);
    expect(res.body).not.toContain("top-secret-webhook-signing-key");
  });

  it("enforces admin RBAC, supports app CRUD, and returns raw API key only once", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/api/admin/open-platform/apps",
      headers: { cookie: memberCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("PERMISSION_DENIED");

    const { openApp, key, rawKey } = await createAppAndKey({ name: "BI 门户" });
    expect(rawKey.startsWith("dc_open_")).toBe(true);
    expect(key.keyPrefix).toBe(rawKey.slice(0, 16));

    // Duplicate app name rejected
    const dup = await app.inject({
      method: "POST",
      url: "/api/admin/open-platform/apps",
      headers: { cookie: adminCookie },
      payload: { name: "bi 门户", serviceUserId: adminId },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("DUPLICATE_NAME");

    // Listing keys must never expose rawKey or keyHash
    const listKeysRes = await app.inject({
      method: "GET",
      url: `/api/admin/open-platform/apps/${openApp.id}/keys`,
      headers: { cookie: adminCookie },
    });
    expect(listKeysRes.statusCode).toBe(200);
    const bodyText = listKeysRes.body;
    expect(bodyText).not.toContain(rawKey);
    expect(bodyText).not.toContain("keyHash");

    // Revoking key immediately rejects subsequent API calls
    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/admin/open-platform/apps/${openApp.id}/keys/${key.id}/revoke`,
      headers: { cookie: adminCookie },
    });
    expect(revokeRes.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/open/v1/datasources",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json().error.code).toBe("API_KEY_REVOKED");
  });

  it("rejects missing, invalid, expired keys, disabled apps, missing scopes, and enforces rate limits", async () => {
    const noKey = await app.inject({ method: "GET", url: "/api/open/v1/datasources" });
    expect(noKey.statusCode).toBe(401);
    expect(noKey.json().error.code).toBe("API_KEY_REQUIRED");

    const badKey = await app.inject({
      method: "GET",
      url: "/api/open/v1/datasources",
      headers: { "x-api-key": "dc_open_nonexistent" },
    });
    expect(badKey.statusCode).toBe(401);
    expect(badKey.json().error.code).toBe("API_KEY_INVALID");

    const { openApp, key, rawKey } = await createAppAndKey({
      scopes: ["ask"],
      rateLimitRpm: 2,
    });

    // Missing semantic scope
    const noScope = await app.inject({
      method: "GET",
      url: `/api/open/v1/datasources/${datasourceId}/semantic`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().error.code).toBe("SCOPE_DENIED");

    // Consume 2 RPM quota then hit 429
    const r1 = await app.inject({
      method: "GET",
      url: "/api/open/v1/datasources",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "GET",
      url: "/api/open/v1/datasources",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(r2.statusCode).toBe(200);
    const r3 = await app.inject({
      method: "GET",
      url: "/api/open/v1/datasources",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error.code).toBe("RATE_LIMITED");
    expect(r3.headers["retry-after"]).toBeDefined();

    // Expired key rejected immediately
    handle.db
      .update(openApiKeys)
      .set({ expiresAt: Date.now() - 1_000 })
      .where(eq(openApiKeys.id, key.id))
      .run();
    const expiredRes = await app.inject({
      method: "GET",
      url: "/api/open/v1/datasources",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(expiredRes.statusCode).toBe(401);
    expect(expiredRes.json().error.code).toBe("API_KEY_EXPIRED");

    // Disabled app rejected
    handle.db.update(openApiKeys).set({ expiresAt: null }).where(eq(openApiKeys.id, key.id)).run();
    await app.inject({
      method: "PATCH",
      url: `/api/admin/open-platform/apps/${openApp.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "disabled" },
    });
    const disabledRes = await app.inject({
      method: "GET",
      url: "/api/open/v1/datasources",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(disabledRes.statusCode).toBe(403);
    expect(disabledRes.json().error.code).toBe("APP_DISABLED");
  });

  it("executes structured ask (sync, async, stream), strips internal placeholders, paginates rows, and isolates cross-app access", async () => {
    const { rawKey } = await createAppAndKey({ exposeSql: true });
    const { rawKey: otherKey } = await createAppAndKey({ exposeSql: false });

    // Cross-origin POST with Bearer API Key must not be blocked by cookie-CSRF hook
    const askRes = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: {
        authorization: `Bearer ${rawKey}`,
        origin: "https://external-crm.example.com",
      },
      payload: {
        datasourceId,
        question: "各区域销售额是多少",
        mode: "sync",
        externalSessionId: "crm-session-100",
      },
    });
    expect(askRes.statusCode).toBe(200);
    const askBody = askRes.json();
    expect(askBody.status).toBe("ok");
    expect(askBody.externalSessionId).toBe("crm-session-100");
    // Internal UI markers stripped from clean answer
    expect(askBody.answer).toContain("华东销售额最高");
    expect(askBody.answer).not.toContain("[[artifact:");
    expect(askBody.answer).not.toContain("[[chart:");
    expect(askBody.datasets).toHaveLength(1);
    expect(askBody.datasets[0].rowCount).toBe(3);
    expect(askBody.charts).toHaveLength(1);
    expect(askBody.lineage.sqls).toHaveLength(1);
    expect(askBody.lineage.semanticMetrics.some((m: { name: string }) => m.name === "销售额")).toBe(true);
    expect(lastExtraInstructions).toBe("金额统一保留两位小数。");

    // Multi-turn reuse via externalSessionId keeps the same conversationId
    const turn2 = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        datasourceId,
        question: "继续看华南明细",
        mode: "sync",
        externalSessionId: "crm-session-100",
      },
    });
    expect(turn2.statusCode).toBe(200);
    expect(turn2.json().conversationId).toBe(askBody.conversationId);

    // Paginate dataset rows
    const artifactId = askBody.datasets[0].artifactId as string;
    const rowsRes = await app.inject({
      method: "GET",
      url: `/api/open/v1/artifacts/${artifactId}/rows?offset=1&limit=1`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(rowsRes.statusCode).toBe(200);
    expect(rowsRes.json().rows).toEqual([["华南", 9800]]);

    // Cross-app isolation: App B cannot read App A's run or artifact
    const crossRun = await app.inject({
      method: "GET",
      url: `/api/open/v1/runs/${askBody.runId}`,
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(crossRun.statusCode).toBe(404);
    const crossRows = await app.inject({
      method: "GET",
      url: `/api/open/v1/artifacts/${artifactId}/rows`,
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(crossRows.statusCode).toBe(404);

    // App with exposeSql=false omits sqls in ask lineage and semantic examples
    const hiddenSqlAsk = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: { authorization: `Bearer ${otherKey}` },
      payload: { datasourceId, question: "查销售额", mode: "sync" },
    });
    expect(hiddenSqlAsk.statusCode).toBe(200);
    expect(hiddenSqlAsk.json().lineage.sqls).toBeUndefined();

    const semanticRes = await app.inject({
      method: "GET",
      url: `/api/open/v1/datasources/${datasourceId}/semantic`,
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(semanticRes.statusCode).toBe(200);
    expect(semanticRes.json().examples[0].sqlText).toBeUndefined();

    // SSE stream mode delivers events and final open_result
    const streamRes = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { datasourceId, question: "流式问答测试", mode: "stream" },
    });
    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers["content-type"]).toContain("text/event-stream");
    expect(streamRes.body).toContain("event: run_end");
    expect(streamRes.body).toContain("event: open_result");
  });

  it("enforces fail-closed endUser and department/externalOrgCode RLS overrides", async () => {
    const rootDept = createDepartment(handle.db, { name: "华东大区", code: "EAST" });
    const childDept = createDepartment(handle.db, {
      name: "上海分公司",
      code: "SHANGHAI",
      parentId: rootDept.id,
    });
    const westDept = createDepartment(handle.db, { name: "华西大区", code: "WEST" });

    importDepartmentMappings(handle.db, datasourceId, [
      {
        departmentId: childDept.id,
        externalOrgCode: "ORG_SH_001",
      },
    ]);
    upsertScopePolicy(handle.db, {
      datasourceId,
      tableName: "orders",
      mode: "scoped",
      rules: [{ columnName: "org_code", operator: "in", valueMode: "external_org_code" }],
    });

    // 1. App with allowEndUserOverride=false rejects endUser context
    const { rawKey: lockedKey } = await createAppAndKey({ allowEndUserOverride: false });
    const lockedRes = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: { authorization: `Bearer ${lockedKey}` },
      payload: {
        datasourceId,
        question: "查订单",
        endUser: { departmentCodes: ["SHANGHAI"] },
      },
    });
    expect(lockedRes.statusCode).toBe(403);
    expect(lockedRes.json().error.code).toBe("END_USER_OVERRIDE_DISABLED");

    // 2. Unknown department code or unmapped externalOrgCode fails closed
    const { rawKey: overrideKey } = await createAppAndKey({ allowEndUserOverride: true });
    const badDept = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: { authorization: `Bearer ${overrideKey}` },
      payload: {
        datasourceId,
        question: "查订单",
        endUser: { departmentCodes: ["NON_EXISTENT"] },
      },
    });
    expect(badDept.statusCode).toBe(403);
    expect(badDept.json().error.code).toBe("DATA_SCOPE_INVALID_DEPARTMENT");

    const badOrg = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: { authorization: `Bearer ${overrideKey}` },
      payload: {
        datasourceId,
        question: "查订单",
        endUser: { externalOrgCodes: ["UNKNOWN_ORG"] },
      },
    });
    expect(badOrg.statusCode).toBe(403);
    expect(badOrg.json().error.code).toBe("DATA_SCOPE_MAPPING_MISSING");

    // 3. Valid externalOrgCode resolves override and forces scoped SQL rewrite even for admin service user
    const okRes = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: { authorization: `Bearer ${overrideKey}` },
      payload: {
        datasourceId,
        question: "查上海订单",
        endUser: { externalUserId: "ext-u-1", externalOrgCodes: ["ORG_SH_001"] },
      },
    });
    expect(okRes.statusCode).toBe(200);
    expect(lastScopeOverride).toEqual({
      rootIds: [childDept.id],
      effectiveIds: [childDept.id],
    });

    const rewritten = applyScopeToSql({
      db: handle.db,
      datasourceId,
      mode: "enabled",
      userId: adminId,
      sql: "SELECT id, amount FROM orders LIMIT 10",
      dialect: "mysql",
      departmentOverride: { rootIds: [childDept.id], effectiveIds: [childDept.id] },
    });
    expect(rewritten.sql).toContain("org_code");
    expect(rewritten.params).toEqual(["ORG_SH_001"]);
    expect(rewritten.snapshot.departments).toEqual([childDept.id]);

    // 4. Non-admin service user cannot escalate to another branch department
    setUserDepartments(handle.db, memberId, [rootDept.id], rootDept.id);
    handle.sqlite
      .prepare("INSERT INTO datasource_grants (id, datasource_id, user_id, created_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), datasourceId, memberId, Date.now());
    const { rawKey: memberAppKey } = await createAppAndKey({
      serviceUserId: memberId,
      allowEndUserOverride: true,
    });
    const outOfBounds = await app.inject({
      method: "POST",
      url: "/api/open/v1/ask",
      headers: { authorization: `Bearer ${memberAppKey}` },
      payload: {
        datasourceId,
        question: "越权查华西",
        endUser: { departmentCodes: [westDept.code] },
      },
    });
    expect(outOfBounds.statusCode).toBe(403);
    expect(outOfBounds.json().error.code).toBe("DATA_SCOPE_OUT_OF_BOUNDS");
  });

  it("generates reports with HMAC-signed webhooks, supports replay, feedback loop, MCP Server, and admin playground", async () => {
    const webhookSecret = "super-secret-hmac-key-123";
    const { openApp, rawKey } = await createAppAndKey({
      webhookUrl: "https://biz.example.com/hooks/datachat",
      webhookSecret,
    });

    // 1. Report generation + webhook dispatch
    const reportRes = await app.inject({
      method: "POST",
      url: "/api/open/v1/reports/generate",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        datasourceId,
        title: "月度经营分析报告",
        prompt: "总结各区域销售额表现",
        sections: ["核心指标概览", "区域对比", "建议"],
        parameters: { period: "2026-10" },
        mode: "sync",
      },
    });
    expect(reportRes.statusCode).toBe(200);
    const reportBody = reportRes.json();
    expect(reportBody.status).toBe("ok");
    expect(reportBody.reportId).toBeTruthy();
    expect(reportBody.title).toBe("月度经营分析报告");
    expect(reportBody.markdown).toContain("华东销售额最高");

    // Fetch report via Open API
    const getReportRes = await app.inject({
      method: "GET",
      url: `/api/open/v1/reports/${reportBody.reportId}`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(getReportRes.statusCode).toBe(200);
    expect(getReportRes.json().title).toBe("月度经营分析报告");

    // Verify HMAC-SHA256 webhook signature
    await vi.waitFor(() => {
      expect(webhookCalls.length).toBeGreaterThanOrEqual(1);
    });
    const wh = webhookCalls[0]!;
    expect(wh.url).toBe("https://biz.example.com/hooks/datachat");
    expect(wh.headers["X-DataChat-Event"]).toBe("report.completed");
    const ts = Number(wh.headers["X-DataChat-Timestamp"]);
    expect(wh.headers["X-DataChat-Signature"]).toBe(signWebhookPayload(webhookSecret, ts, wh.body));

    // Admin webhook list & replay
    const whList = await app.inject({
      method: "GET",
      url: `/api/admin/open-platform/webhooks?appId=${openApp.id}`,
      headers: { cookie: adminCookie },
    });
    expect(whList.statusCode).toBe(200);
    const deliveryId = whList.json().items[0].id as string;
    const replayRes = await app.inject({
      method: "POST",
      url: `/api/admin/open-platform/webhooks/${deliveryId}/replay`,
      headers: { cookie: adminCookie },
    });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json().delivery.attempts).toBe(2);

    // 2. Feedback loop writes into run_feedback
    const fbRes = await app.inject({
      method: "POST",
      url: "/api/open/v1/feedback",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        runId: reportBody.runId,
        rating: 1,
        comment: "口径非常准确",
        externalUserId: "crm-user-88",
      },
    });
    expect(fbRes.statusCode).toBe(200);
    const storedFb = handle.db
      .select()
      .from(runFeedback)
      .where(eq(runFeedback.runId, reportBody.runId))
      .get();
    expect(storedFb?.rating).toBe(1);
    expect(storedFb?.comment).toContain("crm-user-88");
    expect(storedFb?.comment).toContain("口径非常准确");

    // 3. Remote MCP Server JSON-RPC 2.0
    const mcpInit = await app.inject({
      method: "POST",
      url: "/api/open/v1/mcp",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(mcpInit.statusCode).toBe(200);
    expect(mcpInit.json().result.serverInfo.name).toBe("datachat-open-platform");

    const mcpTools = await app.inject({
      method: "POST",
      url: "/api/open/v1/mcp",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(mcpTools.statusCode).toBe(200);
    const toolNames = (mcpTools.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toEqual(["list_datasources", "get_semantic_layer", "ask_data", "generate_report"]);

    const mcpAsk = await app.inject({
      method: "POST",
      url: "/api/open/v1/mcp",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "ask_data",
          arguments: { datasourceId, question: "MCP 问数测试" },
        },
      },
    });
    expect(mcpAsk.statusCode).toBe(200);
    expect(mcpAsk.json().result.isError).toBe(false);
    expect(mcpAsk.json().result.structuredContent.status).toBe("ok");

    // 4. Admin Playground & Audit stats
    const pgRes = await app.inject({
      method: "POST",
      url: `/api/admin/open-platform/apps/${openApp.id}/playground`,
      headers: { cookie: adminCookie },
      payload: {
        action: "ask",
        datasourceId,
        prompt: "调试台测试销售额",
      },
    });
    expect(pgRes.statusCode).toBe(200);
    expect(pgRes.json().result.status).toBe("ok");

    const auditRes = await app.inject({
      method: "GET",
      url: `/api/admin/open-platform/audit?appId=${openApp.id}`,
      headers: { cookie: adminCookie },
    });
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.json().stats.totalCalls).toBeGreaterThanOrEqual(4);
    expect(auditRes.json().stats.okCalls).toBeGreaterThanOrEqual(4);
  });

  it("stores canonical provider::model key (not provider/model) when resolving default model for MCP and Ask", async () => {
    const providerId = randomUUID();
    const secretKey = deriveSecretKey(config.appSecret);
    insertLlmProvider(handle.db, {
      id: providerId,
      name: "TestOpenAI",
      protocol: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      apiKeyCipher: encryptSecret("sk-test-key-1234", secretKey),
      models: [
        { id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek V3.2", contextWindow: 64000, maxTokens: 4096 },
      ],
      enabled: true,
      now: Date.now(),
    });
    const canonicalDefault = `${providerId}::deepseek-ai/DeepSeek-V3.2`;
    saveSettings(handle.db, { defaultModelId: canonicalDefault });

    const { rawKey } = await createAppAndKey();
    const mcpAsk = await app.inject({
      method: "POST",
      url: "/api/open/v1/mcp",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "ask_data",
          arguments: { datasourceId, question: "测试默认模型键解析" },
        },
      },
    });
    expect(mcpAsk.statusCode).toBe(200);
    const convId = mcpAsk.json().result.structuredContent.conversationId as string;
    const conv = handle.db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, convId))
      .get();
    expect(conv?.modelId).toBe(canonicalDefault);

    // Must resolve cleanly via resolveConversationModel (the exact path createConversationSession uses)
    const modelRuntime = await createAgentModelRuntime(config, handle.db);
    const resolved = resolveConversationModel(modelRuntime, conv?.modelId ?? null, enabledProviderIds(handle.db));
    expect(modelKey(resolved)).toBe(canonicalDefault);
  });

  it("strips internal UI placeholders including excel and labelled result markers", async () => {
    const { stripInternalPlaceholders } = await import("../src/services/open-platform-execution.js");
    const u1 = randomUUID();
    const u2 = randomUUID();
    const u3 = randomUUID();
    const u4 = randomUUID();
    const cleaned = stripInternalPlaceholders(
      `总计 100 单。\n\n[[artifact:${u1}]]\n[[chart:${u2}]]\n[[result:${u3}|区域明细]]\n[[excel:${u4}]]\n\n完成。`,
    );
    expect(cleaned).toBe("总计 100 单。\n\n完成。");
  });
});
