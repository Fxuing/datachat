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
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { insertUser } from "../src/db/repositories/users.js";
import { upsertScopePolicy } from "../src/db/repositories/data-scope.js";
import { datasources } from "../src/db/schema.js";
import { buildSemanticBlock } from "../src/services/semantic-layer.js";
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
});
