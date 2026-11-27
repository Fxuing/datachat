import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReportsPage from "./ReportsPage";
import { ToastProvider } from "../components/ui/toast";
import type { ReportListItem, ShareListItem } from "../lib/api";

const mocks = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  logout: vi.fn(),
  listConversations: vi.fn(),
  listNotifications: vi.fn(),
  listDatasources: vi.fn(),
  listReports: vi.fn(),
  deleteReport: vi.fn(),
  listShares: vi.fn(),
  revokeShare: vi.fn(),
  createShare: vi.fn(),
  exportReportById: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMe: mocks.fetchMe,
    logout: mocks.logout,
    listConversations: mocks.listConversations,
    listNotifications: mocks.listNotifications,
    listDatasources: mocks.listDatasources,
    listReports: mocks.listReports,
    deleteReport: mocks.deleteReport,
    listShares: mocks.listShares,
    revokeShare: mocks.revokeShare,
    createShare: mocks.createShare,
  };
});
vi.mock("../hooks/use-access", () => ({ useCan: () => true }));
vi.mock("../lib/report-offscreen-export", () => ({
  exportReportById: mocks.exportReportById,
}));

const reportsFixture: ReportListItem[] = [
  {
    id: "rep-1",
    conversationId: "conv-1",
    title: "2026年11月营收复盘",
    artifactIds: ["art-1", "art-2"],
    artifactCount: 2,
    source: "chat",
    sourceKind: "datasource",
    datasourceId: "ds-1",
    datasourceName: "电商库",
    conversationTitle: "11月营收提问",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  },
  {
    id: "rep-2",
    conversationId: "conv-2",
    title: "每日销售播报",
    artifactIds: ["art-3"],
    artifactCount: 1,
    source: "scheduled",
    sourceKind: "datasource",
    datasourceId: "ds-1",
    datasourceName: "电商库",
    conversationTitle: "定时任务：每日销售播报",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_200_000,
  },
];

const sharesFixture: ShareListItem[] = [
  {
    id: "share-1",
    targetType: "report",
    targetId: "rep-1",
    targetTitle: "2026年11月营收复盘",
    createdBy: "u-1",
    expiresAt: Date.now() + 86_400_000,
    revokedAt: null,
    status: "active",
    createdAt: Date.now() - 3_600_000,
  },
];

function renderPage(initialEntry = "/reports") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/reports/:id" element={<p>报告详情页</p>} />
            <Route path="/chat/:conversationId" element={<p>来源会话页</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchMe.mockResolvedValue({
    user: { id: "u-1", username: "alice", displayName: "Alice", role: "user", status: "active" },
    permissions: ["chat.use", "report.create", "share.create"],
    roles: [],
  });
  mocks.listConversations.mockResolvedValue({ items: [], nextCursor: null });
  mocks.listNotifications.mockResolvedValue({ notifications: [], unread: 0 });
  mocks.listDatasources.mockResolvedValue({
    datasources: [
      {
        id: "ds-1",
        name: "电商库",
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "shop",
        username: "reader",
        sslMode: "disable",
        status: "ok",
        readOnlyVerified: 1,
        allowWriteAccount: 0,
        lastCheckedAt: null,
      },
    ],
  });
  mocks.listReports.mockResolvedValue({ reports: reportsFixture, total: 2 });
  mocks.deleteReport.mockResolvedValue(undefined);
  mocks.listShares.mockResolvedValue({ shares: sharesFixture });
  mocks.revokeShare.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReportsPage", () => {
  it("lists reports, supports search/source filtering, and deletes a report", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("2026年11月营收复盘")).toBeInTheDocument();
    expect(screen.getByText("每日销售播报")).toBeInTheDocument();

    const searchInput = screen.getByLabelText("搜索报告标题");
    await user.type(searchInput, "营收");
    await waitFor(() =>
      expect(mocks.listReports).toHaveBeenCalledWith(
        expect.objectContaining({ q: "营收" }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "删除报告 2026年11月营收复盘" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("删除报告")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(mocks.deleteReport).toHaveBeenCalledWith("rep-1"));
    expect(await screen.findByText("报告已删除")).toBeInTheDocument();
  });

  it("switches to 我的分享 tab and revokes an active share", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("2026年11月营收复盘");

    await user.click(screen.getByRole("tab", { name: /我的分享/ }));
    expect(await screen.findByText("生效中")).toBeInTheDocument();
    expect(mocks.listShares).toHaveBeenCalledWith({ scope: "mine", status: "active" });

    await user.click(screen.getByRole("button", { name: "撤销" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("撤销分享链接")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "撤销" }));

    await waitFor(() => expect(mocks.revokeShare).toHaveBeenCalledWith("share-1"));
    expect(await screen.findByText("已撤销分享链接")).toBeInTheDocument();
  });
});
