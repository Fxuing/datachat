import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ScheduledTasksPage from "./ScheduledTasksPage";
import type { ScheduledTaskSummary } from "../lib/api";

const task: ScheduledTaskSummary = {
  id: "task-1",
  name: "每日订单",
  prompt: "统计昨天的订单量和金额",
  datasourceId: "ds-1",
  datasourceName: "示例商城",
  modelId: null,
  cronExpression: "0 9 * * *",
  timezone: "Asia/Shanghai",
  enabled: 1,
  nextRunAt: Date.now() + 3_600_000,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  consecutiveFailures: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastRun: null,
};

const mocks = vi.hoisted(() => ({
  listScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  runScheduledTask: vi.fn(),
  listScheduledTaskRuns: vi.fn(),
  listDatasources: vi.fn(),
  listModels: vi.fn(),
  fetchMe: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../lib/api", () => mocks);
vi.mock("../hooks/use-access", () => ({ useCan: () => true }));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/scheduled"]}>
        <ScheduledTasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchMe.mockResolvedValue({
    user: { id: "u1", username: "alice", displayName: "Alice", role: "user", status: "active" },
    permissions: ["chat.use", "report.create"],
    roles: [],
  });
  mocks.listScheduledTasks.mockResolvedValue({ tasks: [task] });
  mocks.listDatasources.mockResolvedValue({
    datasources: [
      {
        id: "ds-1",
        name: "示例商城",
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "shop",
        username: "readonly",
        sslMode: "disable",
        status: "ok",
        readOnlyVerified: 1,
        allowWriteAccount: 0,
        lastCheckedAt: Date.now(),
      },
    ],
  });
  mocks.listModels.mockResolvedValue({ configured: true, models: [], defaultId: "" });
  mocks.listScheduledTaskRuns.mockResolvedValue({ runs: [] });
  mocks.createScheduledTask.mockResolvedValue({ task });
  mocks.runScheduledTask.mockResolvedValue({ run: { id: "run-1" } });
  mocks.deleteScheduledTask.mockResolvedValue(undefined);
});

describe("ScheduledTasksPage", () => {
  it("lists tasks with their schedule", async () => {
    renderPage();
    expect(await screen.findByText("每日订单")).toBeInTheDocument();
    expect(screen.getByText("每天 09:00")).toBeInTheDocument();
    expect(screen.getByText("示例商城")).toBeInTheDocument();
  });

  it("creates a task from the dialog", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("每日订单");

    await user.click(screen.getByRole("button", { name: "新建任务" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("名称"), "每周汇总");
    await user.type(within(dialog).getByLabelText("问题"), "统计上周的销售额");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(mocks.createScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "每周汇总",
          prompt: "统计上周的销售额",
          datasourceId: "ds-1",
          cronExpression: "0 9 * * *",
          timezone: "Asia/Shanghai",
        }),
      ),
    );
  });

  it("runs a task immediately", async () => {
    renderPage();
    await screen.findByText("每日订单");
    const button = screen.getAllByRole("button", { name: "立即执行" })[0]!;
    await waitFor(() => expect(button).toBeEnabled());
    button.click();
    await waitFor(() => expect(mocks.runScheduledTask).toHaveBeenCalledWith("task-1"));
  });

  it("deletes a task after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByText("每日订单");
    const button = screen.getAllByRole("button", { name: "删除" })[0]!;
    await waitFor(() => expect(button).toBeEnabled());
    button.click();
    await waitFor(() => expect(mocks.deleteScheduledTask).toHaveBeenCalledWith("task-1"));
  });
});
