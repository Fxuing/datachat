import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemoryPage from "./MemoryPage";
import type { MemoryItem } from "../lib/api";

const memory: MemoryItem = {
  id: "mem-1", kind: "preference", title: "金额单位", content: "金额按万元展示",
  scope: "global", datasourceId: null, core: false, enabled: true, confidence: 90,
  useCount: 0, lastUsedAt: null, createdAt: 1, updatedAt: Date.now(),
};

const mocks = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  logout: vi.fn(),
  listMemories: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  clearMemories: vi.fn(),
  getMemorySettings: vi.fn(),
  updateMemorySettings: vi.fn(),
  listDatasources: vi.fn(),
}));

vi.mock("../lib/api", () => mocks);
vi.mock("../hooks/use-access", () => ({ useCan: () => true }));
vi.mock("../components/NotificationBell", () => ({ NotificationBell: () => null }));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/memory"]}>
        <Routes>
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/chat" element={<p>会话页</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchMe.mockResolvedValue({
    user: { id: "u1", username: "alice", displayName: "Alice", role: "user", status: "active" },
    permissions: ["chat.use"], roles: [],
  });
  mocks.listMemories.mockResolvedValue({
    memories: [memory], settings: { enabled: true, globalEnabled: true }, globalEnabled: true,
  });
  mocks.getMemorySettings.mockResolvedValue({ enabled: true, globalEnabled: true });
  mocks.listDatasources.mockResolvedValue({ datasources: [] });
  mocks.createMemory.mockResolvedValue({ memory, merged: false });
  mocks.updateMemory.mockResolvedValue({ memory });
  mocks.updateMemorySettings.mockResolvedValue({ enabled: false });
});

describe("MemoryPage", () => {
  it("lists memories and toggles injection", async () => {
    renderPage();
    expect(await screen.findByText("金额单位")).toBeInTheDocument();
    expect(screen.getByText("金额按万元展示")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: "记忆注入" }));
    await waitFor(() =>
      expect(mocks.updateMemorySettings).toHaveBeenCalledWith(false, expect.anything()),
    );
  });

  it("creates a memory from the dialog", async () => {
    renderPage();
    await screen.findByText("金额单位");
    await userEvent.click(screen.getByRole("button", { name: "新增记忆" }));
    await userEvent.type(screen.getByPlaceholderText("例如：金额展示口径"), "订单口径");
    await userEvent.type(screen.getByPlaceholderText("例如：金额一律按万元展示，保留两位小数"), "只统计已支付订单");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mocks.createMemory).toHaveBeenCalledWith(
        expect.objectContaining({ title: "订单口径", content: "只统计已支付订单", scope: "global" }),
      ),
    );
  });

  it("returns to the conversation through the router, not a full page load", async () => {
    renderPage();
    await screen.findByText("金额单位");

    await userEvent.click(screen.getByRole("link", { name: /返回对话/ }));

    expect(await screen.findByText("会话页")).toBeInTheDocument();
  });

  it("asks before clearing all memories", async () => {
    renderPage();
    await screen.findByText("金额单位");
    await userEvent.click(screen.getByRole("button", { name: "清空全部" }));
    expect(screen.getByText("清空全部记忆？")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清空" }));
    await waitFor(() => expect(mocks.clearMemories).toHaveBeenCalled());
  });
});
