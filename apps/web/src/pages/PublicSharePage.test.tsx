import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
          <Route path="/s/:token/reports/:reportId" element={<PublicSharePage />} />
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

  it("applies .markdown styling and scrollable table wrapper for shared markdown tables and charts", async () => {
    const shareWithMarkdownTable: PublicConversationShare = {
      type: "conversation",
      title: "月度经营分析",
      createdAt: 1_760_000_000_000,
      messages: [
        { role: "user", text: "看看 1 月类目结构" },
        {
          role: "assistant",
          text: "| 类目 | 订单数 |\n| --- | --- |\n| 服饰鞋包 | 168 |",
        },
        {
          role: "assistant",
          text: "",
          chart: {
            chart: { type: "bar", title: "TOP12 商品" },
            option: {
              xAxis: { type: "category", data: ["针织开衫"] },
              yAxis: { type: "value" },
              series: [{ type: "bar", data: [2.62] }],
            },
          },
        },
      ],
    };

    const { container } = (() => {
      stubPublicShare(shareWithMarkdownTable);
      return renderPage("tok-md-table");
    })();

    expect(await screen.findByRole("heading", { name: "月度经营分析" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "类目" })).toBeInTheDocument();
    expect(screen.getByText("TOP12 商品")).toBeInTheDocument();
    expect(container.querySelector(".markdown")).toBeInTheDocument();
    expect(container.querySelector(".prose-report")).not.toBeInTheDocument();
    expect(container.querySelector(".markdown .overflow-x-auto > table")).toBeInTheDocument();
  });

  it("rewrites in-conversation report links to public /s/:token/reports/:reportId and navigates without login", async () => {
    const repId = "55555555-5555-4555-8555-555555555555";
    const convWithReportLink: PublicConversationShare = {
      type: "conversation",
      title: "包含报告的分享会话",
      createdAt: 1_760_000_000_000,
      messages: [
        { role: "user", text: "生成月报" },
        {
          role: "assistant",
          text: `报告已生成：\n\n[查看完整报告](/reports/${repId})`,
        },
      ],
    };
    const nestedReportShare: PublicReportShare = {
      type: "report",
      title: "1月经营分析报告",
      markdown: "## 核心结论\n\n整体业绩稳健增长。",
      artifacts: [],
      createdAt: 1_760_000_000_000,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/public/shares/tok-rep") {
        return jsonResponse(convWithReportLink);
      }
      if (url === `/api/public/shares/tok-rep/reports/${repId}`) {
        return jsonResponse(nestedReportShare);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const browser = userEvent.setup();
    renderPage("tok-rep");

    const link = await screen.findByRole("link", { name: "查看完整报告" });
    expect(link).toHaveAttribute("href", `/s/tok-rep/reports/${repId}`);

    await browser.click(link);

    expect(await screen.findByRole("heading", { name: "1月经营分析报告" })).toBeInTheDocument();
    expect(screen.getByText("整体业绩稳健增长。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /返回对话/ })).toHaveAttribute("href", "/s/tok-rep");
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
  });

  it("renders ConversationMinimap for 3+ turn shared conversations and jumps on click", async () => {
    const multiTurnShare: PublicConversationShare = {
      type: "conversation",
      title: "多轮经营复盘",
      createdAt: 1_760_000_000_000,
      messages: [
        { role: "user", text: "第一轮提问：华北表现如何" },
        { role: "assistant", text: "第一轮回答" },
        { role: "user", text: "第二轮提问：商品 TOP10" },
        { role: "assistant", text: "第二轮回答" },
        { role: "user", text: "第三轮提问：后续风险提示" },
        { role: "assistant", text: "第三轮回答" },
      ],
    };
    stubPublicShare(multiTurnShare);
    renderPage("tok-multi");

    expect(await screen.findByRole("heading", { name: "多轮经营复盘" })).toBeInTheDocument();
    const minimap = screen.getByLabelText("会话导航");
    expect(minimap).toBeInTheDocument();

    const targetTurn = document.getElementById("turn-share-turn-2");
    expect(targetTurn).not.toBeNull();
    const scrollIntoView = vi.fn();
    targetTurn!.scrollIntoView = scrollIntoView;

    const tick2 = screen.getByRole("button", { name: "跳到第 2 轮" });
    fireEvent.mouseEnter(tick2);
    expect(within(minimap).getByText("3 轮对话")).toBeInTheDocument();
    expect(within(minimap).getByText("第二轮提问：商品 TOP10")).toBeInTheDocument();

    fireEvent.click(within(minimap).getByRole("button", { name: "跳到第 2 轮" }));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("renders ReportToc for shared reports with multiple markdown headings", async () => {
    const multiHeadingReport: PublicReportShare = {
      type: "report",
      title: "年度经营分析",
      markdown: "## 核心指标总结\n\n稳健增长。\n\n## 风险与建议\n\n关注库存周转。",
      artifacts: [],
      createdAt: 1_760_000_000_000,
    };
    stubPublicShare(multiHeadingReport);
    renderPage("tok-toc");

    expect(await screen.findByRole("heading", { name: "年度经营分析" })).toBeInTheDocument();
    const toc = screen.getByLabelText("目录");
    expect(toc).toBeInTheDocument();

    const secondHeading = screen.getByRole("heading", { name: "风险与建议" });
    expect(secondHeading).toHaveAttribute("id");
    const scrollIntoView = vi.fn();
    secondHeading.scrollIntoView = scrollIntoView;

    fireEvent.click(screen.getAllByRole("button", { name: "风险与建议" })[0]!);
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
