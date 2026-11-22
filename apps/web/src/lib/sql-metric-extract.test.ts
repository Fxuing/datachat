import { describe, expect, it } from "vitest";
import { extractMetricDraftFromSql } from "./sql-metric-extract";

describe("extractMetricDraftFromSql", () => {
  it("extracts aggregate metrics, expands aliases, separates date filters into timeColumn, and keeps business filters", () => {
    const draft = extractMetricDraftFromSql({
      sql: `
        SELECT
          c.city,
          SUM(o.total_amount) AS gmv,
          COUNT(DISTINCT o.customer_id) AS paid_buyers
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        WHERE o.status = 'paid' AND o.created_at >= '2026-01-01'
        GROUP BY c.city
        ORDER BY gmv DESC
        LIMIT 20
      `,
      prompt: "各城市今年的有效 GMV 和付费买家数",
      sourceRunId: "run-1",
    });

    expect(draft.tableName).toBe("orders");
    expect(draft.name).toBe("GMV");
    expect(draft.sqlExpression).toBe("SUM(orders.total_amount)");
    expect(draft.defaultFilters).toEqual(["orders.status = 'paid'"]);
    expect(draft.timeColumn).toBe("orders.created_at");
    expect(draft.sourceRunId).toBe("run-1");
    expect(draft.candidates).toEqual([
      { name: "GMV", sqlExpression: "SUM(orders.total_amount)", alias: "gmv" },
      {
        name: "paid_buyers",
        sqlExpression: "COUNT(DISTINCT orders.customer_id)",
        alias: "paid_buyers",
      },
    ]);
  });

  it("handles bare SQL without aggregates gracefully", () => {
    const draft = extractMetricDraftFromSql({
      sql: "SELECT id, name FROM customers LIMIT 10",
      prompt: "查看客户列表",
    });
    expect(draft.tableName).toBe("customers");
    expect(draft.candidates).toEqual([]);
    expect(draft.name).toBe("");
    expect(draft.description).toBe("查看客户列表");
  });
});
