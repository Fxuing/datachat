import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./NotificationBell";

const mocks = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

vi.mock("../lib/api", () => mocks);

function renderBell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/chat"]}>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listNotifications.mockResolvedValue({
    unread: 1,
    notifications: [
      {
        id: "n1",
        type: "task_success",
        title: "每日订单已完成",
        body: "报告已生成",
        href: "/reports/report-1",
        readAt: null,
        createdAt: Date.now(),
      },
      {
        id: "n2",
        type: "task_failed",
        title: "每周汇总失败",
        body: "上游模型超时",
        href: null,
        readAt: Date.now(),
        createdAt: Date.now(),
      },
    ],
  });
  mocks.markNotificationRead.mockResolvedValue(undefined);
  mocks.markAllNotificationsRead.mockResolvedValue({ marked: 1 });
});

describe("NotificationBell", () => {
  it("shows the unread count and marks an item read on click", async () => {
    const user = userEvent.setup();
    renderBell();
    await screen.findByLabelText("通知");
    expect(await screen.findByText("1")).toBeInTheDocument();

    await user.click(screen.getByLabelText("通知"));
    await user.click(await screen.findByText("每日订单已完成"));

    await waitFor(() => expect(mocks.markNotificationRead).toHaveBeenCalledWith("n1"));
  });

  it("marks all notifications read", async () => {
    const user = userEvent.setup();
    renderBell();
    await screen.findByLabelText("通知");
    await user.click(screen.getByLabelText("通知"));
    await user.click(await screen.findByRole("button", { name: "全部已读" }));
    await waitFor(() => expect(mocks.markAllNotificationsRead).toHaveBeenCalled());
  });

  it("shows an error state and retries loading notifications", async () => {
    mocks.listNotifications
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ unread: 0, notifications: [] });
    const user = userEvent.setup();
    renderBell();

    await user.click(await screen.findByLabelText("通知"));
    expect(await screen.findByText("通知加载失败")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有通知")).toBeInTheDocument();
  });
});
