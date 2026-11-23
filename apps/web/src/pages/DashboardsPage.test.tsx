import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DashboardsPage from "./DashboardsPage";
import type { DashboardDetail, DashboardSummary, SessionUser } from "../lib/api";

const user: SessionUser = {
  id: "u-1",
  username: "alice",
  displayName: "Alice",
  role: "user",
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

describe("DashboardsPage", () => {
  it("renders a dashboard with pinned charts and refreshes a card", async () => {
    const summary: DashboardSummary = {
      id: "d-1",
      name: "经营日看板",
      description: "每日关注核心营收",
      cardCount: 1,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    };
    const detail: DashboardDetail = {
      ...summary,
      cards: [
        {
          id: "card-1",
          dashboardId: "d-1",
          title: "各区销售额",
          sourceConversationId: "c-1",
          sourceArtifactId: "art-1",
          datasourceId: "ds-1",
          datasourceName: "分析主库",
          refreshable: true,
          spec: {
            chart: { type: "bar", x: "region", y: "amount", title: "各区销售额" },
            option: {
              xAxis: { type: "category", data: ["华东", "华北"] },
              yAxis: { type: "value" },
              series: [{ type: "bar", name: "销售额", data: [100, 200] }],
            },
          },
          points: 2,
          width: 1,
          position: 0,
          lastRefreshedAt: 1_760_000_000_000,
          lastError: null,
          createdAt: 1_760_000_000_000,
          updatedAt: 1_760_000_000_000,
        },
      ],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") return jsonResponse({ user, permissions: ["chat.use"], roles: [] });
      if (url === "/api/notifications") return jsonResponse({ notifications: [], unread: 0 });
      if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/api/dashboards" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ dashboards: [summary] });
      }
      if (url === "/api/dashboards/d-1" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ dashboard: detail });
      }
      if (url === "/api/dashboards/d-1/cards/card-1/refresh" && init?.method === "POST") {
        return jsonResponse({
          card: {
            ...detail.cards[0]!,
            lastRefreshedAt: 1_760_000_120_000,
            lastError: null,
          },
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
        <MemoryRouter initialEntries={["/dashboards/d-1"]}>
          <Routes>
            <Route path="/dashboards" element={<DashboardsPage />} />
            <Route path="/dashboards/:dashboardId" element={<DashboardsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("各区销售额")).toBeInTheDocument();
    expect(screen.getByText("分析主库")).toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "刷新 各区销售额" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboards/d-1/cards/card-1/refresh",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("supports scheduled refresh config, card SQL editing, and dashboard sharing", async () => {
    const summary: DashboardSummary = {
      id: "d-1",
      name: "经营日看板",
      description: "每日关注核心营收",
      cardCount: 1,
      refreshCron: null,
      refreshTimezone: "Asia/Shanghai",
      nextRefreshAt: null,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    };
    const card = {
      id: "card-1",
      dashboardId: "d-1",
      title: "各区销售额",
      sourceConversationId: "c-1",
      sourceArtifactId: "art-1",
      datasourceId: "ds-1",
      datasourceName: "分析主库",
      refreshable: true,
      sqlText: "SELECT region, SUM(amount) AS amount FROM orders GROUP BY region",
      spec: {
        chart: { type: "bar", x: "region", y: "amount", title: "各区销售额" },
        option: {
          xAxis: { type: "category", data: ["华东", "华北"] },
          yAxis: { type: "value" },
          series: [{ type: "bar", name: "销售额", data: [100, 200] }],
        },
      },
      points: 2,
      width: 1 as const,
      position: 0,
      lastRefreshedAt: 1_760_000_000_000,
      lastError: null,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    };
    const detail: DashboardDetail = { ...summary, cards: [card] };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/auth/me") {
        return jsonResponse({ user, permissions: ["chat.use", "share.create"], roles: [] });
      }
      if (url === "/api/notifications") return jsonResponse({ notifications: [], unread: 0 });
      if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/api/dashboards" && method === "GET") {
        return jsonResponse({ dashboards: [summary] });
      }
      if (url === "/api/dashboards/d-1" && method === "GET") {
        return jsonResponse({ dashboard: detail });
      }
      if (url === "/api/dashboards/d-1" && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          refreshCron?: string | null;
          refreshTimezone?: string;
        };
        return jsonResponse({
          dashboard: {
            ...detail,
            refreshCron: body.refreshCron ?? null,
            refreshTimezone: body.refreshTimezone ?? "Asia/Shanghai",
            nextRefreshAt: body.refreshCron ? 1_760_086_400_000 : null,
          },
        });
      }
      if (url === "/api/dashboards/d-1/cards/card-1" && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { sqlText?: string };
        return jsonResponse({
          card: { ...card, sqlText: body.sqlText ?? card.sqlText, sourceArtifactId: null },
        });
      }
      if (url === "/api/dashboards/d-1/cards/card-1/refresh" && method === "POST") {
        return jsonResponse({
          card: {
            ...card,
            sqlText: "SELECT region, SUM(amount) AS amount FROM orders GROUP BY region LIMIT 10",
            lastRefreshedAt: 1_760_000_500_000,
          },
        });
      }
      if (url === "/api/shares" && method === "POST") {
        return jsonResponse(
          {
            share: {
              id: "sh-1",
              token: "tok-dash",
              url: "/s/tok-dash",
              expiresAt: 1_760_600_000_000,
            },
          },
          201,
        );
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
        <MemoryRouter initialEntries={["/dashboards/d-1"]}>
          <Routes>
            <Route path="/dashboards" element={<DashboardsPage />} />
            <Route path="/dashboards/:dashboardId" element={<DashboardsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("各区销售额")).toBeInTheDocument();

    // 1. Configure scheduled refresh
    await browser.click(screen.getByRole("button", { name: "定时刷新" }));
    await browser.click(screen.getByRole("button", { name: "每天 08:00" }));
    await browser.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboards/d-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ refreshCron: "0 8 * * *", refreshTimezone: "Asia/Shanghai" }),
        }),
      ),
    );
    expect(await screen.findByText("0 8 * * *")).toBeInTheDocument();

    // 2. Edit card SQL and save + refresh
    await browser.click(screen.getByRole("button", { name: "查看或编辑 各区销售额 SQL" }));
    const sqlInput = screen.getByLabelText(/SQL 语句/);
    await browser.clear(sqlInput);
    await browser.type(
      sqlInput,
      "SELECT region, SUM(amount) AS amount FROM orders GROUP BY region LIMIT 10",
    );
    await browser.click(screen.getByRole("button", { name: "保存并刷新" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboards/d-1/cards/card-1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/dashboards/d-1/cards/card-1/refresh",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    // 3. Share dashboard
    await browser.click(screen.getByRole("button", { name: "分享" }));
    await browser.click(screen.getByRole("button", { name: "创建分享链接" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shares",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ dashboardId: "d-1", expiresInDays: 7 }),
        }),
      ),
    );
    expect(await screen.findByLabelText("分享链接")).toHaveValue(
      `${window.location.origin}/s/tok-dash`,
    );
  });
});
