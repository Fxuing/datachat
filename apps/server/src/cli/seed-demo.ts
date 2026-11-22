/**
 * Idempotently seeds the DataChat demo sandbox:
 *  - Read-only PostgreSQL datasource (`demo_shop`)
 *  - Lightweight semantic layer (3 business metrics + 3 standard joins)
 *  - 1 personal sample dashboard with 2 live refreshable cards
 *
 * Usage:
 *   pnpm demo:seed
 *   node apps/server/dist/cli/seed-demo.js
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { migrateDb } from "../db/migrate.js";
import { deriveSecretKey, encryptSecret } from "../agent/datasource/crypto.js";
import { findDatasourceByName, insertDatasource } from "../db/repositories/datasources.js";
import { replaceGrants } from "../db/repositories/grants.js";
import {
  insertDashboard,
  insertDashboardCard,
  listDashboardsByUser,
} from "../db/repositories/dashboards.js";
import {
  insertSemanticMetric,
  insertSemanticRelation,
  listSemanticMetrics,
  listSemanticRelations,
} from "../db/repositories/semantic-layer.js";
import { insertSqlExample, listSqlExamples } from "../db/repositories/sql-examples.js";
import { users } from "../db/schema.js";

const DEMO_DS_NAME = "电商示例库（Demo）";
const DEMO_DASHBOARD_NAME = "电商经营示例看板";

function main(): void {
  const config = loadConfig();
  const handle = createDb(config.dbPath);
  try {
    migrateDb(handle.db);
    const admin = handle.db
      .select()
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1)
      .get();
    if (!admin) {
      throw new Error("未找到管理员账号，请先启动一次 DataChat 服务端完成初始化。");
    }

    const pgHost = process.env.DEMO_PG_HOST ?? "127.0.0.1";
    const pgPort = Number(process.env.DEMO_PG_PORT ?? "5432");
    const pgDatabase = process.env.DEMO_PG_DATABASE ?? "demo_shop";
    const pgUser = process.env.DEMO_PG_USER ?? "datachat_ro";
    const pgPassword = process.env.DEMO_PG_PASSWORD ?? "datachat_ro_demo";

    const key = deriveSecretKey(config.appSecret);
    const now = Date.now();

    const existingDs = findDatasourceByName(handle.db, DEMO_DS_NAME);
    let dsId: string;
    if (!existingDs) {
      dsId = randomUUID();
      insertDatasource(handle.db, {
        id: dsId,
        name: DEMO_DS_NAME,
        type: "postgres",
        host: pgHost,
        port: pgPort,
        database: pgDatabase,
        username: pgUser,
        passwordCipher: encryptSecret(pgPassword, key),
        sslMode: "disable",
        status: "ok",
        readOnlyVerified: 1,
        allowWriteAccount: 0,
        lastCheckedAt: now,
        createdBy: admin.id,
        createdAt: now,
        updatedAt: now,
      });
      replaceGrants(handle.db, dsId, [admin.id]);
      console.log(`✓ 已创建示例数据源：${DEMO_DS_NAME} (${pgHost}:${pgPort}/${pgDatabase})`);
    } else {
      dsId = existingDs.id;
      console.log(`• 示例数据源已存在：${DEMO_DS_NAME}`);
    }

    // Seed lightweight semantic layer metrics (idempotent by name).
    const existingMetricNames = new Set(
      listSemanticMetrics(handle.db, dsId).map((m) => m.name),
    );
    const demoMetrics = [
      {
        name: "有效 GMV",
        synonyms: ["成交额", "销售额", "营收", "GMV"],
        description: "已支付订单的总金额，排除取消与退款订单。",
        sqlExpression: "SUM(orders.total_amount)",
        tableName: "orders",
        defaultFilters: ["orders.status = 'paid'"],
        timeColumn: "orders.created_at",
        unit: "元",
      },
      {
        name: "下单客户数",
        synonyms: ["付费客户数", "活跃买家数"],
        description: "产生有效支付订单的去重客户数量。",
        sqlExpression: "COUNT(DISTINCT orders.customer_id)",
        tableName: "orders",
        defaultFilters: ["orders.status = 'paid'"],
        timeColumn: "orders.created_at",
        unit: "人",
      },
      {
        name: "客单价",
        synonyms: ["平均订单金额", "AOV"],
        description: "已支付订单的平均单笔成交金额。",
        sqlExpression: "ROUND(AVG(orders.total_amount), 2)",
        tableName: "orders",
        defaultFilters: ["orders.status = 'paid'"],
        timeColumn: "orders.created_at",
        unit: "元",
      },
    ];
    let addedMetrics = 0;
    for (const metric of demoMetrics) {
      if (existingMetricNames.has(metric.name)) continue;
      insertSemanticMetric(handle.db, {
        datasourceId: dsId,
        ...metric,
        enabled: true,
      });
      addedMetrics += 1;
    }

    // Seed standard joins (idempotent by left/right pair).
    const existingRels = new Set(
      listSemanticRelations(handle.db, dsId).map(
        (r) => `${r.leftTable}.${r.leftColumn}->${r.rightTable}.${r.rightColumn}`,
      ),
    );
    const demoRelations = [
      {
        leftTable: "orders",
        leftColumn: "customer_id",
        rightTable: "customers",
        rightColumn: "id",
        joinType: "left" as const,
        description: "订单关联下单客户信息（城市、客户分层）",
      },
      {
        leftTable: "order_items",
        leftColumn: "order_id",
        rightTable: "orders",
        rightColumn: "id",
        joinType: "inner" as const,
        description: "订单明细关联主订单状态与下单时间",
      },
      {
        leftTable: "order_items",
        leftColumn: "product_id",
        rightTable: "products",
        rightColumn: "id",
        joinType: "left" as const,
        description: "订单明细关联商品名称与品类",
      },
    ];
    let addedRels = 0;
    for (const rel of demoRelations) {
      const sig = `${rel.leftTable}.${rel.leftColumn}->${rel.rightTable}.${rel.rightColumn}`;
      if (existingRels.has(sig)) continue;
      insertSemanticRelation(handle.db, {
        datasourceId: dsId,
        ...rel,
        enabled: true,
      });
      addedRels += 1;
    }
    console.log(`✓ 语义层已就绪（本次新增指标 ${addedMetrics} 条，关联 ${addedRels} 条）`);

    // Seed verified Few-shot SQL examples (idempotent by question).
    const existingQuestions = new Set(listSqlExamples(handle.db, dsId).map((e) => e.question));
    const demoExamples = [
      {
        question: "按城市统计有效 GMV 和下单客户数排行",
        sqlText:
          "SELECT c.city, SUM(o.total_amount) AS gmv, COUNT(DISTINCT o.customer_id) AS buyer_count FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.status = 'paid' GROUP BY c.city ORDER BY gmv DESC LIMIT 20",
        notes: "有效 GMV 需过滤 status = 'paid'，按客户去重统计下单客户数。",
        tables: ["orders", "customers"],
      },
      {
        question: "统计各商品品类的销量和销售额占比",
        sqlText:
          "SELECT p.category, SUM(oi.quantity) AS total_qty, SUM(oi.quantity * oi.unit_price) AS revenue FROM order_items oi JOIN orders o ON oi.order_id = o.id JOIN products p ON oi.product_id = p.id WHERE o.status = 'paid' GROUP BY p.category ORDER BY revenue DESC LIMIT 20",
        notes: "订单明细需关联 orders 过滤已支付订单，并关联 products 获取品类。",
        tables: ["order_items", "orders", "products"],
      },
    ];
    let addedExamples = 0;
    for (const ex of demoExamples) {
      if (existingQuestions.has(ex.question)) continue;
      insertSqlExample(handle.db, {
        datasourceId: dsId,
        ...ex,
        source: "manual",
        createdBy: admin.id,
      });
      addedExamples += 1;
    }
    if (addedExamples > 0) {
      console.log(`✓ 示例 SQL 知识库已就绪（本次新增 ${addedExamples} 条 Few-shot 示例）`);
    }

    // Seed sample refreshable dashboard (idempotent by name).
    const existingDash = listDashboardsByUser(handle.db, admin.id).find(
      (d) => d.name === DEMO_DASHBOARD_NAME,
    );
    if (!existingDash) {
      const dash = insertDashboard(handle.db, {
        userId: admin.id,
        name: DEMO_DASHBOARD_NAME,
        description: "基于 Demo 电商库的实时看板，点击卡片右上角「刷新」可直接重跑只读 SQL。",
      });
      insertDashboardCard(handle.db, {
        dashboardId: dash.id,
        userId: admin.id,
        title: "各城市有效 GMV 排行",
        sourceConversationId: null,
        sourceArtifactId: null,
        datasourceId: dsId,
        sqlText:
          "SELECT c.city, SUM(o.total_amount) AS gmv FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.status = 'paid' GROUP BY c.city ORDER BY gmv DESC LIMIT 20",
        chartConfigJson: JSON.stringify({
          type: "bar",
          x: "city",
          y: "gmv",
          title: "各城市有效 GMV 排行",
        }),
        specJson: JSON.stringify({
          chart: { type: "bar", x: "city", y: "gmv", title: "各城市有效 GMV 排行" },
          option: {
            xAxis: { type: "category", data: ["Shanghai", "Beijing", "Shenzhen", "Hangzhou"] },
            yAxis: { type: "value" },
            series: [{ type: "bar", name: "gmv", data: [1480, 1220, 960, 540] }],
          },
        }),
        points: 4,
        width: 1,
        position: 0,
        lastRefreshedAt: null,
      });
      insertDashboardCard(handle.db, {
        dashboardId: dash.id,
        userId: admin.id,
        title: "各商品品类销售额占比",
        sourceConversationId: null,
        sourceArtifactId: null,
        datasourceId: dsId,
        sqlText:
          "SELECT p.category, SUM(oi.quantity * oi.unit_price) AS revenue FROM order_items oi JOIN orders o ON oi.order_id = o.id JOIN products p ON oi.product_id = p.id WHERE o.status = 'paid' GROUP BY p.category ORDER BY revenue DESC LIMIT 20",
        chartConfigJson: JSON.stringify({
          type: "pie",
          x: "category",
          y: "revenue",
          title: "各商品品类销售额占比",
        }),
        specJson: JSON.stringify({
          chart: { type: "pie", x: "category", y: "revenue", title: "各商品品类销售额占比" },
          option: {
            series: [
              {
                type: "pie",
                data: [
                  { name: "Electronics", value: 2100 },
                  { name: "Home", value: 1560 },
                  { name: "Office", value: 540 },
                ],
              },
            ],
          },
        }),
        points: 3,
        width: 1,
        position: 1,
        lastRefreshedAt: null,
      });
      console.log(`✓ 已创建示例看板：${DEMO_DASHBOARD_NAME}（2 张可实时刷新卡片）`);
    } else {
      console.log(`• 示例看板已存在：${DEMO_DASHBOARD_NAME}`);
    }
  } finally {
    handle.sqlite.close();
  }
}

main();
