import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DatasourceSemanticPage from "./DatasourceSemanticPage";
import type { SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DatasourceSemanticPage", () => {
  it("creates a metric and previews recall block", async () => {
    const metrics: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") return jsonResponse({ user: admin, permissions: [], roles: [] });
      if (url === "/api/notifications") return jsonResponse({ notifications: [], unread: 0 });
      if (url === "/api/admin/datasources/ds-1/semantic" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          datasource: { id: "ds-1", name: "电商主库", type: "mysql" },
          metrics,
          relations: [],
          tables: [{ name: "orders", comment: "订单表", columns: ["id", "pay_amount", "paid_at"] }],
        });
      }
      if (url === "/api/admin/datasources/ds-1/semantic/metrics" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        const created = {
          id: "m-1",
          datasourceId: "ds-1",
          name: payload.name,
          synonyms: payload.synonyms ?? [],
          description: payload.description ?? null,
          sqlExpression: payload.sqlExpression,
          tableName: payload.tableName ?? null,
          defaultFilters: payload.defaultFilters ?? [],
          timeColumn: payload.timeColumn ?? null,
          unit: payload.unit ?? null,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        };
        metrics.push(created);
        return jsonResponse({ metric: created }, 201);
      }
      if (url === "/api/admin/datasources/ds-1/semantic/preview" && init?.method === "POST") {
        return jsonResponse({
          text: "<semantic_layer>\n- GMV｜公式：`SUM(orders.pay_amount)`\n</semantic_layer>",
          metricIds: ["m-1"],
          relationIds: [],
        });
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const browser = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/datasources/ds-1/semantic"]}>
          <Routes>
            <Route
              path="/admin/datasources/:datasourceId/semantic"
              element={<DatasourceSemanticPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/指标与语义层 · 电商主库/)).toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "新建指标" }));
    await browser.type(screen.getByLabelText("指标名称 *"), "GMV");
    await browser.type(screen.getByLabelText("SQL 计算表达式 *"), "SUM(orders.pay_amount)");
    await browser.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("GMV")).toBeInTheDocument();

    await browser.type(screen.getByLabelText("测试提问"), "统计上月 GMV");
    await browser.click(screen.getByRole("button", { name: "测试召回" }));

    await waitFor(() =>
      expect(screen.getByText(/<semantic_layer>/)).toBeInTheDocument(),
    );
  });

  it("promotes negative user feedback into a verified Few-Shot SQL example", async () => {
    const examples: Array<Record<string, unknown>> = [];
    let postedPayload: Record<string, unknown> | null = null;
    const feedbackItems = [
      {
        id: "fb-1",
        runId: "run-bad-1",
        conversationId: "conv-1",
        conversationTitle: "复购统计",
        username: "alice",
        displayName: "Alice",
        rating: -1,
        comment: "忘记加 status = 'paid' 条件",
        reviewStatus: "pending",
        reviewedAt: null,
        prompt: "统计各城市复购客户数",
        runStatus: "ok",
        sqlQueries: [
          {
            sql: "SELECT city, COUNT(*) FROM orders GROUP BY city LIMIT 50",
            status: "ok",
            rowCount: 3,
            errorMessage: null,
          },
        ],
        promotedExampleId: null,
        createdAt: 1_760_000_000_000,
        updatedAt: 1_760_000_000_000,
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/auth/me") return jsonResponse({ user: admin, permissions: [], roles: [] });
      if (url === "/api/notifications") return jsonResponse({ notifications: [], unread: 0 });
      if (url === "/api/admin/datasources/ds-1/semantic" && method === "GET") {
        return jsonResponse({
          datasource: { id: "ds-1", name: "电商主库", type: "mysql" },
          metrics: [],
          relations: [],
          examples,
          feedbackSummary: {
            pendingNegative: feedbackItems.filter((i) => i.reviewStatus === "pending").length,
            pendingPositive: 0,
            totalExamples: examples.length,
            enabledExamples: examples.length,
          },
          tables: [],
        });
      }
      if (url.startsWith("/api/admin/datasources/ds-1/semantic/feedback") && method === "GET") {
        return jsonResponse({
          items: feedbackItems.filter((i) => i.reviewStatus === "pending"),
          summary: {
            pendingNegative: feedbackItems.filter((i) => i.reviewStatus === "pending").length,
            pendingPositive: 0,
            totalExamples: examples.length,
            enabledExamples: examples.length,
          },
        });
      }
      if (url === "/api/admin/datasources/ds-1/semantic/examples" && method === "POST") {
        postedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const created = {
          id: "ex-1",
          datasourceId: "ds-1",
          question: postedPayload.question,
          sqlText: postedPayload.sqlText,
          notes: postedPayload.notes ?? null,
          tables: ["orders"],
          source: postedPayload.source ?? "manual",
          sourceRunId: postedPayload.sourceRunId ?? null,
          enabled: true,
          useCount: 0,
          lastUsedAt: null,
          createdAt: 1,
          updatedAt: 1,
        };
        examples.push(created);
        feedbackItems[0]!.reviewStatus = "promoted";
        return jsonResponse({ example: created }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const browser = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/datasources/ds-1/semantic"]}>
          <Routes>
            <Route
              path="/admin/datasources/:datasourceId/semantic"
              element={<DatasourceSemanticPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText(/指标与语义层 · 电商主库/);
    await browser.click(screen.getByRole("tab", { name: /问答反馈沉淀/ }));

    expect(await screen.findByText(/忘记加 status = 'paid' 条件/)).toBeInTheDocument();
    await browser.click(screen.getByRole("button", { name: "纠错并沉淀 SQL" }));

    const sqlInput = await screen.findByLabelText("标准只读 SQL *");
    expect(sqlInput).toHaveValue("SELECT city, COUNT(*) FROM orders GROUP BY city LIMIT 50");
    await browser.clear(sqlInput);
    await browser.type(
      sqlInput,
      "SELECT city, COUNT(*) FROM orders WHERE status = 'paid' GROUP BY city LIMIT 50",
    );
    await browser.click(screen.getByRole("button", { name: "校验并保存" }));

    await waitFor(() => {
      expect(postedPayload).toMatchObject({
        question: "统计各城市复购客户数",
        sqlText:
          "SELECT city, COUNT(*) FROM orders WHERE status = 'paid' GROUP BY city LIMIT 50",
        source: "feedback_fix",
        sourceRunId: "run-bad-1",
      });
    });

    // Switch to SQL Examples tab and verify the promoted item is visible.
    await browser.click(screen.getByRole("tab", { name: /SQL 示例库/ }));
    expect(await screen.findByText("纠错沉淀")).toBeInTheDocument();
    expect(screen.getByText("统计各城市复购客户数")).toBeInTheDocument();
  });
});
