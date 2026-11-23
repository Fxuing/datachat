import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PublicSharePage from "./PublicSharePage";
import type {
  PublicConversationShare,
  PublicDashboardShare,
  PublicReportShare,
} from "../lib/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const conversationShare: PublicConversationShare = {
  type: "conversation",
  title: "销售分析",
  createdAt: 1_760_000_000_000,
  messages: [
    { role: "user", text: "有多少客户？" },
    {
      role: "assistant",
      text: "",
      columns: [
        { name: "name", type: "string" },
        { name: "amount", type: "number" },
      ],
      rows: [["alice", 42]],
    },
    {
      role: "assistant",
      text: "共 1 位客户。",
      sql: "select name, amount from customers",
    },
  ],
};

const reportShare: PublicReportShare = {
  type: "report",
  title: "周报",
  markdown: "## 概览\n\n[[artifact:a-1]]\n\n本周数据稳定。",
  artifacts: [
    {
      id: "a-1",
      kind: "result",
      columns: [
        { name: "name", type: "string" },
        { name: "amount", type: "number" },
      ],
      rows: [["alpha", 7]],
    },
  ],
  createdAt: 1_760_000_000_000,
};

const dashboardShare: PublicDashboardShare = {
  type: "dashboard",
  title: "经营日看板",
  description: "每日关注核心营收",
  cards: [
    {
      title: "各区销售额",
      width: 2,
      points: 2,
      spec: {
        chart: { type: "bar", x: "region", y: "amount", title: "各区销售额" },
        option: {
          xAxis: { type: "category", data: ["华东", "华北"] },
          yAxis: { type: "value" },
          series: [{ type: "bar", name: "销售额", data: [100, 200] }],
        },
      },
      lastRefreshedAt: 1_760_000_000_000,
    },
  ],
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_100_000,
};

function renderPage(token = "tok-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/s/${token}`]}>
        <Routes>
          <Route path="/s/:token" element={<PublicSharePage />} />
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubPublicShare(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => jsonResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PublicSharePage", () => {
  it("renders a shared conversation without any authenticated request", async () => {
    const fetchMock = stubPublicShare(conversationShare);
    renderPage();

    expect(await screen.findByRole("heading", { name: "销售分析" })).toBeInTheDocument();
    expect(screen.getByText("有多少客户？")).toBeInTheDocument();
    expect(screen.getByText("select name, amount from customers")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("共 1 位客户。")).toBeInTheDocument();
    expect(screen.getByText("只读分享")).toBeInTheDocument();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual(["/api/public/shares/tok-1"]);
    expect(urls).not.toContain("/api/auth/me");
  });

  it("renders a shared report with markdown and artifact tables", async () => {
    stubPublicShare(reportShare);
    renderPage();

    expect(await screen.findByRole("heading", { name: "周报" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "概览" })).toBeInTheDocument();
    expect(screen.getByText("本周数据稳定。")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "amount" })).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("renders a shared dashboard with read-only charts", async () => {
    const fetchMock = stubPublicShare(dashboardShare);
    renderPage("tok-dash");

    expect(await screen.findByRole("heading", { name: "经营日看板" })).toBeInTheDocument();
    expect(screen.getByText("每日关注核心营收")).toBeInTheDocument();
    expect(screen.getByText("各区销售额")).toBeInTheDocument();
    expect(screen.getByText("只读分享")).toBeInTheDocument();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual(["/api/public/shares/tok-dash"]);
  });

  it("shows the expired state for a 410 response", async () => {
    stubPublicShare(
      { error: { code: "SHARE_GONE", message: "分享链接已过期或已撤销" } },
      410,
    );
    renderPage();

    expect(await screen.findByText("链接已过期或已撤销")).toBeInTheDocument();
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
  });

  it("does not redirect to login when the public endpoint returns 401", async () => {
    stubPublicShare({ error: { code: "AUTH_REQUIRED", message: "请先登录" } }, 401);
    renderPage();

    expect(await screen.findByText("分享内容加载失败，请稍后重试。")).toBeInTheDocument();
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
  });
});
