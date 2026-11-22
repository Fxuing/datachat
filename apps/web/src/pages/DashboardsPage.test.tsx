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
});
