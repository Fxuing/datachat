import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { upsertRunFeedback } from "../src/db/repositories/run-feedback.js";
import { insertUser } from "../src/db/repositories/users.js";
import { upsertScopePolicy } from "../src/db/repositories/data-scope.js";
import { datasources, runEvents, runs } from "../src/db/schema.js";
import { recordAudit } from "../src/services/audit.js";
import { buildSemanticBlock, hasEnabledSemanticEntries } from "../src/services/semantic-layer.js";
import { testConfig } from "./helpers/config.js";

let tmpDir: string;
let db: Db;
let closeDb: () => void;
let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let datasourceId: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-semantic-test-"));
  const handle = createDb(path.join(tmpDir, "app.db"));
  db = handle.db;
  closeDb = () => handle.sqlite.close();
  migrateDb(db);

  const hash = await hashPassword("secret");
  const now = Date.now();
  const admin = insertUser(db, {
    id: randomUUID(),
    username: "root",
    passwordHash: hash,
    role: "admin",
    createdAt: now,
  });
  const member = insertUser(db, {
    id: randomUUID(),
    username: "alice",
    passwordHash: hash,
    role: "user",
    createdAt: now,
  });
  memberId = member.id;

  datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "电商主库",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "shop",
    username: "ro",
    passwordCipher: "enc",
    sslMode: "disable",
    readOnlyVerified: 1,
    createdBy: admin.id,
    createdAt: now,
    updatedAt: now,
  });

  const signer = createSessionSigner(testConfig.appSecret);
  adminCookie = await signer.sign({ sub: admin.id, username: admin.username, role: admin.role });
  memberCookie = await signer.sign({ sub: member.id, username: member.username, role: member.role });

  app = await buildApp({
    config: { ...testConfig, dataDir: tmpDir },
    db,
    enableRateLimit: false,
  });
});

afterEach(async () => {
  await app?.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("semantic layer admin api & recall", () => {
  it("manages metrics & relations, rejects duplicates and non-admins, and builds recall blocks", async () => {
    // Non-admin is forbidden.
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/admin/datasources/${datasourceId}/semantic`,
      cookies: { dc_session: memberCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    // Create metric.
    const metricRes = await app.inject({
      method: "POST",
      url: `/api/admin/datasources/${datasourceId}/semantic/metrics`,
      cookies: { dc_session: adminCookie },
      payload: {
        name: "GMV",
        synonyms: ["成交总额", "交易额"],
        sqlExpression: "SUM(orders.pay_amount)",
        tableName: "orders",
        defaultFilters: ["orders.status IN ('paid', 'completed')"],
        timeColumn: "orders.paid_at",
        unit: "元",
        description: "已支付订单总金额",
      },
    });
    expect(metricRes.statusCode).toBe(201);
    const metric = (metricRes.json() as { metric: { id: string; name: string } }).metric;

    // Duplicate metric name returns 409.
    const dupMetric = await app.inject({
      method: "POST",
      url: `/api/admin/datasources/${datasourceId}/semantic/metrics`,
      cookies: { dc_session: adminCookie },
      payload: {
        name: "GMV",
        sqlExpression: "SUM(orders.amount)",
      },
    });
    expect(dupMetric.statusCode).toBe(409);

    // Create relation.
    const relRes = await app.inject({
      method: "POST",
      url: `/api/admin/datasources/${datasourceId}/semantic/relations`,
      cookies: { dc_session: adminCookie },
      payload: {
        leftTable: "orders",
        leftColumn: "customer_id",
        rightTable: "customers",
        rightColumn: "id",
        joinType: "left",
        description: "订单关联下单客户",
      },
    });
    expect(relRes.statusCode).toBe(201);
    const relation = (relRes.json() as { relation: { id: string } }).relation;

    // Preview recall for a synonym query.
    const previewRes = await app.inject({
      method: "POST",
      url: `/api/admin/datasources/${datasourceId}/semantic/preview`,
      cookies: { dc_session: adminCookie },
      payload: { query: "统计上月各客户成交总额" },
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json() as { text: string; metricIds: string[]; relationIds: string[] };
    expect(preview.text).toContain("<semantic_layer>");
    expect(preview.text).toContain("SUM(orders.pay_amount)");
    expect(preview.text).toContain("orders.status IN ('paid', 'completed')");
    expect(preview.text).toContain("`orders.customer_id` LEFT JOIN `customers.id`");
    expect(preview.metricIds).toEqual([metric.id]);
    expect(preview.relationIds).toEqual([relation.id]);

    // Data-scope enabled: denied/unconfigured tables are hidden from non-admin semantic injection.
    db.update(datasources)
      .set({ dataScopeMode: "enabled" })
      .where(eq(datasources.id, datasourceId))
      .run();
    upsertScopePolicy(db, {
      datasourceId,
      tableName: "orders",
      mode: "public",
      enabled: true,
    });
    upsertScopePolicy(db, {
      datasourceId,
      tableName: "customers",
      mode: "denied",
      enabled: true,
    });

    const memberBlock = buildSemanticBlock({
      db,
      datasourceId,
      userId: memberId,
      query: "看成交总额",
    });
    expect(memberBlock.metrics).toHaveLength(1);
    expect(memberBlock.relations).toHaveLength(0);
    expect(memberBlock.text).not.toContain("customers");

    // Update & delete.
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/admin/datasources/${datasourceId}/semantic/metrics/${metric.id}`,
      cookies: { dc_session: adminCookie },
      payload: { enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { metric: { enabled: boolean } }).metric.enabled).toBe(false);

    const delRel = await app.inject({
      method: "DELETE",
      url: `/api/admin/datasources/${datasourceId}/semantic/relations/${relation.id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(delRel.statusCode).toBe(204);
  });

  it("validates Few-shot SQL examples, triages feedback into promoted examples, and filters by data scope", async () => {
    // Rejects non-read-only SQL via guardSql.
    const unsafe = await app.inject({
      method: "POST",
      url: `/api/admin/datasources/${datasourceId}/semantic/examples`,
      cookies: { dc_session: adminCookie },
      payload: {
        question: "删除测试订单",
        sqlText: "DELETE FROM orders WHERE id = 1",
      },
    });
    expect(unsafe.statusCode).toBe(400);
    expect((unsafe.json() as { error: { code: string } }).error.code).toBe("INVALID_SQL");

    // Seed a real conversation + run + executed SQL + negative user feedback.
    const conv = createConversation(db, {
      userId: memberId,
      datasourceId,
      title: "月度复购分析",
    });
    const runId = randomUUID();
    const now = Date.now();
    db.insert(runs)
      .values({
        id: runId,
        conversationId: conv.id,
        userId: memberId,
        status: "ok",
        createdAt: now,
        startedAt: now,
        endedAt: now + 50,
      })
      .run();
    db.insert(runEvents)
      .values({
        id: randomUUID(),
        runId,
        conversationId: conv.id,
        seq: 1,
        type: "user_message",
        payloadJson: JSON.stringify({ content: "按城市统计最近 30 天已支付订单的复购客户数" }),
        createdAt: now,
      })
      .run();
    recordAudit(db, {
      runId,
      conversationId: conv.id,
      userId: memberId,
      datasourceId,
      action: "query",
      sqlText: "SELECT city, COUNT(*) FROM orders GROUP BY city LIMIT 50",
      status: "ok",
      rowCount: 3,
    });
    const fb = upsertRunFeedback(db, {
      runId,
      userId: memberId,
      rating: -1,
      comment: "没有过滤 status = 'paid'，而且复购需要 HAVING COUNT(*) >= 2",
    });

    // Admin inspects pending negative feedback inbox.
    const fbRes = await app.inject({
      method: "GET",
      url: `/api/admin/datasources/${datasourceId}/semantic/feedback?rating=-1&status=pending`,
      cookies: { dc_session: adminCookie },
    });
    expect(fbRes.statusCode).toBe(200);
    const fbBody = fbRes.json() as {
      items: Array<{
        id: string;
        runId: string;
        prompt: string;
        rating: number;
        comment: string;
        reviewStatus: string;
        sqlQueries: Array<{ sql: string }>;
      }>;
      summary: { pendingNegative: number };
    };
    expect(fbBody.summary.pendingNegative).toBe(1);
    expect(fbBody.items).toHaveLength(1);
    expect(fbBody.items[0]?.id).toBe(fb.id);
    expect(fbBody.items[0]?.sqlQueries[0]?.sql).toContain("SELECT city");

    // Promote feedback into a verified corrected SQL example.
    const promoteRes = await app.inject({
      method: "POST",
      url: `/api/admin/datasources/${datasourceId}/semantic/examples`,
      cookies: { dc_session: adminCookie },
      payload: {
        question: "按城市统计最近 30 天已支付订单的复购客户数",
        sqlText:
          "SELECT c.city, COUNT(*) AS repeat_buyers FROM (SELECT customer_id FROM orders WHERE status = 'paid' GROUP BY customer_id HAVING COUNT(*) >= 2) r JOIN customers c ON r.customer_id = c.id GROUP BY c.city LIMIT 50",
        notes: "复购客户定义为已支付订单数 >= 2，需关联 customers 获取 city。",
        source: "feedback_fix",
        sourceRunId: runId,
      },
    });
    expect(promoteRes.statusCode).toBe(201);
    const createdEx = (
      promoteRes.json() as {
        example: { id: string; tables: string[]; source: string; sourceRunId: string };
      }
    ).example;
    expect(createdEx.source).toBe("feedback_fix");
    expect(createdEx.sourceRunId).toBe(runId);
    expect(createdEx.tables.sort()).toEqual(["customers", "orders"]);
    expect(hasEnabledSemanticEntries(db, datasourceId)).toBe(true);

    // Feedback item is automatically marked promoted.
    const pendingAfter = await app.inject({
      method: "GET",
      url: `/api/admin/datasources/${datasourceId}/semantic/feedback?status=pending`,
      cookies: { dc_session: adminCookie },
    });
    expect((pendingAfter.json() as { items: unknown[]; summary: { pendingNegative: number } })).toMatchObject({
      items: [],
      summary: { pendingNegative: 0 },
    });

    // Preview recalls the promoted Few-shot example.
    const preview = await app.inject({
      method: "POST",
      url: `/api/admin/datasources/${datasourceId}/semantic/preview`,
      cookies: { dc_session: adminCookie },
      payload: { query: "查一下各城市复购客户数" },
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json() as { text: string; exampleIds: string[] };
    expect(previewBody.exampleIds).toEqual([createdEx.id]);
    expect(previewBody.text).toContain("参考 SQL 示例（Few-Shot）");
    expect(previewBody.text).toContain("HAVING COUNT(*) >= 2");

    // Scope isolation: when `customers` is denied on a scoped datasource, non-admin never sees the example.
    db.update(datasources)
      .set({ dataScopeMode: "enabled" })
      .where(eq(datasources.id, datasourceId))
      .run();
    upsertScopePolicy(db, { datasourceId, tableName: "orders", mode: "public", enabled: true });
    upsertScopePolicy(db, { datasourceId, tableName: "customers", mode: "denied", enabled: true });

    const memberBlock = buildSemanticBlock({
      db,
      datasourceId,
      userId: memberId,
      query: "查一下各城市复购客户数",
    });
    expect(memberBlock.examples).toHaveLength(0);
    expect(memberBlock.text).not.toContain("customers");

    // Admin can dismiss/re-open feedback status and delete example.
    const dismissRes = await app.inject({
      method: "PATCH",
      url: `/api/admin/datasources/${datasourceId}/semantic/feedback/${fb.id}`,
      cookies: { dc_session: adminCookie },
      payload: { reviewStatus: "dismissed" },
    });
    expect(dismissRes.statusCode).toBe(200);

    const delEx = await app.inject({
      method: "DELETE",
      url: `/api/admin/datasources/${datasourceId}/semantic/examples/${createdEx.id}`,
      cookies: { dc_session: adminCookie },
    });
    expect(delEx.statusCode).toBe(204);
  });
});
