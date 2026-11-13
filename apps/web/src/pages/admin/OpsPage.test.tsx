import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OpsPage from "./OpsPage";
import type { AdminSettings, OpsMetrics, SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

const settings: AdminSettings = {
  defaultModelId: "siliconflow::deepseek-ai/DeepSeek-V3.2",
  queryMaxRows: 1_000,
  queryPreviewRows: 200,
  queryTimeoutMs: 5_000,
  shareMaxDays: 30,
  retentionConversationDays: 30,
  retentionAuditDays: 90,
};

function metrics(days: number): OpsMetrics {
  return {
    range: { days, from: Date.parse("2026-11-01T00:00:00.000Z"), to: Date.parse("2026-11-08T00:00:00.000Z") },
    totals: {
      runs: 12,
      ok: 10,
      error: 1,
      aborted: 1,
      queuedOrRunning: 0,
      successRate: 10 / 12,
      p50Ms: 4_000,
      p95Ms: 20_000,
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      activeUsers: 2,
    },
    daily: [
      { date: "2026-11-01", runs: 2, ok: 2, error: 0, aborted: 0, inputTokens: 100, outputTokens: 20 },
      { date: "2026-11-02", runs: 3, ok: 2, error: 1, aborted: 0, inputTokens: 100, outputTokens: 20 },
      { date: "2026-11-03", runs: 0, ok: 0, error: 0, aborted: 0, inputTokens: 0, outputTokens: 0 },
      { date: "2026-11-04", runs: 0, ok: 0, error: 0, aborted: 0, inputTokens: 0, outputTokens: 0 },
      { date: "2026-11-05", runs: 0, ok: 0, error: 0, aborted: 0, inputTokens: 0, outputTokens: 0 },
      { date: "2026-11-06", runs: 0, ok: 0, error: 0, aborted: 0, inputTokens: 0, outputTokens: 0 },
      { date: "2026-11-07", runs: 7, ok: 6, error: 0, aborted: 1, inputTokens: 300, outputTokens: 60 },
      { date: "2026-11-08", runs: 0, ok: 0, error: 0, aborted: 0, inputTokens: 0, outputTokens: 0 },
    ],
    datasources: [{ datasourceId: "ds-1", name: "业务库", runs: 9, failed: 1 }],
    queries: { total: 21, rejected: 3, error: 2, timeout: 1, averageRows: 42.6 },
  };
}

const preview = {
  conversationDays: 30,
  auditDays: 90,
  conversationCutoff: Date.parse("2026-10-09T00:00:00.000Z"),
  auditCutoff: Date.parse("2026-08-10T00:00:00.000Z"),
  conversations: {
    eligible: 4,
    willDelete: 3,
    skippedActiveShares: 1,
    skippedBusy: 0,
    runs: 8,
    events: 40,
    artifacts: 3,
    artifactBytes: 2_048,
    reports: 1,
    shares: 2,
  },
  auditRows: 12,
};

const backups = [
  {
    name: "backup-20261108-120000",
    createdAt: Date.parse("2026-11-08T12:00:00.000Z"),
    bytes: 4_096,
    files: 7,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === "/api/auth/me") return jsonResponse({ user: admin, permissions: [], roles: [] });
    if (url === "/api/admin/settings" && method === "GET") return jsonResponse({ settings });
    if (url.startsWith("/api/admin/ops/metrics")) {
      const days = Number(new URL(url, "http://localhost").searchParams.get("days") ?? 7);
      return jsonResponse(metrics(days));
    }
    if (url === "/api/admin/ops/backups") return jsonResponse(backups);
    if (url === "/api/admin/ops/retention" && method === "GET") return jsonResponse(preview);
    if (url === "/api/admin/ops/retention/run" && method === "POST") {
      return jsonResponse({
        deletedConversations: 3,
        deletedRuns: 8,
        deletedEvents: 40,
        deletedArtifacts: 3,
        deletedReports: 1,
        deletedShares: 2,
        deletedAuditRows: 12,
        skippedActiveShares: 1,
        skippedBusy: 0,
        errors: [],
        durationMs: 120,
      });
    }
    return jsonResponse({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OpsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpsPage", () => {
  it("renders metrics, retention and backups", async () => {
    stubApi();
    renderPage();

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("83.3%")).toBeInTheDocument();
    expect(screen.getByText("业务库")).toBeInTheDocument();
    expect(await screen.findByText("backup-20261108-120000")).toBeInTheDocument();
    expect(screen.queryByText("还没有备份")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("30")).toBeInTheDocument();
    expect(screen.getByDisplayValue("90")).toBeInTheDocument();
  });

  it("previews and runs retention after confirmation", async () => {
    const fetchMock = stubApi();
    renderPage();

    const user = userEvent.setup();
    await screen.findByText("12");
    await user.click(screen.getByRole("button", { name: "预览影响" }));
    expect(await screen.findByText(/到期会话：4/)).toBeInTheDocument();
    expect(screen.getByText(/将删除：3/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "执行清理" }));
    expect(await screen.findByText("确认执行清理？")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认清理" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            input === "/api/admin/ops/retention/run" &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
    expect(await screen.findByText(/上次清理：删除 3 个会话/)).toBeInTheDocument();
  });
});
