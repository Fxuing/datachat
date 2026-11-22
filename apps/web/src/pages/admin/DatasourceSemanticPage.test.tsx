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
});
