import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationSidebar } from "./ConversationSidebar";
import type { Conversation } from "../../lib/api";

const mocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  listDatasources: vi.fn(),
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  updateConversation: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/api", () => mocks);

const conversations: Conversation[] = [
  {
    id: "c1",
    datasourceId: "ds1",
    title: "订单分析",
    modelId: null,
    thinkingLevel: "medium",
    status: "active",
    createdAt: 2,
    updatedAt: 2,
    lastMessageAt: 2,
  },
  {
    id: "c2",
    datasourceId: "ds1",
    title: "用户留存",
    modelId: null,
    thinkingLevel: "medium",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    lastMessageAt: 1,
  },
];

function renderSidebar(initialEntry = "/chat/c1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/chat" element={<div><p>新对话页</p><ConversationSidebar /></div>} />
          <Route path="/chat/:id" element={<ConversationSidebar activeId="c1" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConversations.mockImplementation(async (params?: { q?: string }) => {
    const q = params?.q?.toLowerCase() ?? "";
    return {
      items: q
        ? conversations.filter((conversation) => conversation.title?.toLowerCase().includes(q))
        : conversations,
      nextCursor: null,
    };
  });
  mocks.listDatasources.mockResolvedValue({ datasources: [] });
});

describe("ConversationSidebar filter", () => {
  it("replaces the new-chat button with a title search and filters on Enter", async () => {
    renderSidebar();
    expect(await screen.findByText("订单分析")).toBeInTheDocument();
    expect(screen.getByText("用户留存")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "筛选对话" }));

    expect(screen.queryByRole("button", { name: "新建对话" })).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText("筛选对话…");
    await userEvent.type(input, "订单{enter}");

    await waitFor(() => expect(mocks.listConversations).toHaveBeenLastCalledWith({ q: "订单" }));
    expect(await screen.findByText("订单分析")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("用户留存")).not.toBeInTheDocument());
  });

  it("closes the filter and restores the new-chat button", async () => {
    renderSidebar();
    await screen.findByText("订单分析");

    await userEvent.click(screen.getByRole("button", { name: "筛选对话" }));
    await userEvent.type(screen.getByPlaceholderText("筛选对话…"), "订单{enter}");
    await waitFor(() => expect(screen.queryByText("用户留存")).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "关闭筛选" }));

    expect(await screen.findByRole("button", { name: "新建对话" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("筛选对话…")).not.toBeInTheDocument();
    expect(await screen.findByText("用户留存")).toBeInTheDocument();
  });

  it("collapses an empty filter when the input loses focus", async () => {
    renderSidebar();
    await screen.findByText("订单分析");

    await userEvent.click(screen.getByRole("button", { name: "筛选对话" }));
    expect(screen.getByPlaceholderText("筛选对话…")).toHaveFocus();

    await userEvent.click(screen.getByText("订单分析"));

    expect(await screen.findByRole("button", { name: "新建对话" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("筛选对话…")).not.toBeInTheDocument();
  });

  it("shows an empty state and can clear the filter", async () => {
    renderSidebar();
    await screen.findByText("订单分析");

    await userEvent.click(screen.getByRole("button", { name: "筛选对话" }));
    await userEvent.type(screen.getByPlaceholderText("筛选对话…"), "不存在{enter}");

    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));

    expect(await screen.findByRole("button", { name: "新建对话" })).toBeInTheDocument();
    expect(await screen.findByText("订单分析")).toBeInTheDocument();
  });
});

describe("ConversationSidebar pagination and actions", () => {
  it("loads the next cursor page on demand", async () => {
    mocks.listConversations
      .mockResolvedValueOnce({ items: conversations, nextCursor: "1:c2" })
      .mockResolvedValueOnce({
        items: [
          {
            id: "c3",
            datasourceId: "ds1",
            title: "历史会话3",
            modelId: null,
            thinkingLevel: "medium",
            status: "active",
            createdAt: 0,
            updatedAt: 0,
            lastMessageAt: 0,
          },
        ],
        nextCursor: null,
      });

    renderSidebar();
    expect(await screen.findByText("订单分析")).toBeInTheDocument();

    const loadMore = screen.getByRole("button", { name: "加载更多" });
    await userEvent.click(loadMore);

    await waitFor(() =>
      expect(mocks.listConversations).toHaveBeenLastCalledWith({ before: "1:c2" }),
    );
    expect(await screen.findByText("历史会话3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("filters conversations automatically after typing", async () => {
    renderSidebar();
    await screen.findByText("订单分析");

    await userEvent.click(screen.getByRole("button", { name: "筛选对话" }));
    await userEvent.type(screen.getByPlaceholderText("筛选对话…"), "订单");

    await waitFor(
      () => expect(mocks.listConversations).toHaveBeenLastCalledWith({ q: "订单" }),
      { timeout: 1_500 },
    );
  });

  it("keeps the rename draft open when update fails", async () => {
    mocks.updateConversation.mockRejectedValueOnce(new Error("boom"));
    renderSidebar();
    await screen.findByText("订单分析");

    await userEvent.click(screen.getAllByRole("button", { name: "重命名会话" })[0]!);
    const input = screen.getByLabelText("会话名称");
    await userEvent.clear(input);
    await userEvent.type(input, "保留草稿{enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("重命名失败");
    expect(screen.getByLabelText("会话名称")).toHaveValue("保留草稿");
  });

  it("navigates directly to /chat when clicking 新建对话", async () => {
    renderSidebar("/chat/c1");
    await screen.findByText("订单分析");

    await userEvent.click(screen.getByRole("button", { name: "新建对话" }));
    expect(await screen.findByText("新对话页")).toBeInTheDocument();
  });
});
