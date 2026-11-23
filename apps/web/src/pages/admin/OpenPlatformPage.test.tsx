import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OpenPlatformPage from "./OpenPlatformPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenPlatformPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/open-platform"]}>
          <Routes>
            <Route path="/admin/open-platform" element={<OpenPlatformPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("renders apps, issues an API key with one-time display, runs playground, and replays webhook", async () => {
    const apps = [
      {
        id: "app-1",
        name: "经营驾驶舱",
        description: "为外部经营门户提供精准问数",
        status: "active",
        serviceUserId: "u-admin",
        serviceUsername: "admin",
        serviceUserDisplayName: "管理员",
        allowedDatasourceIds: ["ds-1"],
        scopes: ["ask", "report", "semantic", "mcp", "feedback"],
        allowEndUserOverride: true,
        exposeSql: true,
        defaultModelId: null,
        systemPromptExtra: null,
        rateLimitRpm: 60,
        maxRowsOverride: null,
        timeoutMsOverride: null,
        webhookUrl: "https://biz.example.com/hook",
        hasWebhookSecret: true,
        activeKeyCount: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ];

    const keys = [
      {
        id: "key-1",
        appId: "app-1",
        name: "默认密钥",
        keyPrefix: "dc_open_existing",
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdBy: "u-admin",
        createdAt: 1_700_000_000_000,
      },
    ];

    const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url === "/api/auth/me") {
        return jsonResponse({
          user: { id: "u-admin", username: "admin", displayName: "管理员", role: "admin", status: "active" },
          permissions: ["admin.open_platform"],
        });
      }
      if (url === "/api/notifications" || url.startsWith("/api/notifications?")) {
        return jsonResponse({ notifications: [], unread: 0 });
      }
      if (url === "/api/admin/open-platform/apps" && method === "GET") {
        return jsonResponse({ items: apps });
      }
      if (url === "/api/admin/users") {
        return jsonResponse({
          users: [{ id: "u-admin", username: "admin", displayName: "管理员", role: "admin", status: "active" }],
        });
      }
      if (url === "/api/datasources") {
        return jsonResponse({
          datasources: [{ id: "ds-1", name: "核心销售库", type: "mysql", status: "ok" }],
        });
      }
      if (url === "/api/admin/open-platform/apps/app-1/keys" && method === "GET") {
        return jsonResponse({ items: keys });
      }
      if (url === "/api/admin/open-platform/apps/app-1/keys" && method === "POST") {
        const created = {
          id: "key-2",
          appId: "app-1",
          name: "测试密钥",
          keyPrefix: "dc_open_new12345",
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          createdBy: "u-admin",
          createdAt: Date.now(),
        };
        keys.unshift(created);
        return jsonResponse({ key: created, rawKey: "dc_open_new12345_secret_token" }, 201);
      }
      if (url === "/api/admin/open-platform/apps/app-1/playground" && method === "POST") {
        return jsonResponse({
          action: "ask",
          result: {
            runId: "run-1",
            conversationId: "conv-1",
            externalSessionId: null,
            datasourceId: "ds-1",
            status: "ok",
            answer: "华东销售额为 12,500 元。",
            datasets: [],
            charts: [],
            lineage: {
              sqls: [{ sql: "SELECT SUM(amount) FROM orders LIMIT 10", auditId: "a-1", status: "ok" }],
              scope: { departments: ["上海分公司"] },
              semanticMetrics: [{ name: "销售额", formula: "SUM(amount)", unit: "元" }],
            },
            usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0 },
            durationMs: 320,
            error: null,
            createdAt: Date.now(),
          },
        });
      }
      if (url.startsWith("/api/admin/open-platform/audit")) {
        return jsonResponse({
          items: [
            {
              id: "aud-1",
              appId: "app-1",
              appName: "经营驾驶舱",
              keyId: "key-1",
              endpoint: "POST /api/open/v1/ask",
              datasourceId: "ds-1",
              conversationId: "conv-1",
              runId: "run-1",
              reportId: null,
              externalUserId: "ext-1",
              effectiveUserId: "u-admin",
              status: "ok",
              httpStatus: 200,
              errorCode: null,
              errorMessage: null,
              durationMs: 250,
              inputTokens: 100,
              outputTokens: 30,
              createdAt: Date.now(),
            },
          ],
          stats: {
            totalCalls: 12,
            okCalls: 11,
            errorCalls: 0,
            rejectedCalls: 1,
            rateLimitedCalls: 0,
            totalInputTokens: 1200,
            totalOutputTokens: 450,
            avgDurationMs: 280,
          },
        });
      }
      if (url.startsWith("/api/admin/open-platform/webhooks") && method === "GET") {
        return jsonResponse({
          items: [
            {
              id: "wh-1",
              appId: "app-1",
              event: "report.completed",
              targetUrl: "https://biz.example.com/hook",
              status: "failed",
              attempts: 1,
              httpStatus: 502,
              responseSnippet: "Bad Gateway",
              error: "HTTP 502",
              createdAt: Date.now(),
              lastAttemptAt: Date.now(),
            },
          ],
        });
      }
      if (url === "/api/admin/open-platform/webhooks/wh-1/replay" && method === "POST") {
        return jsonResponse({
          delivery: {
            id: "wh-1",
            appId: "app-1",
            event: "report.completed",
            targetUrl: "https://biz.example.com/hook",
            status: "ok",
            attempts: 2,
            httpStatus: 200,
            responseSnippet: "ok",
            error: null,
            createdAt: Date.now(),
            lastAttemptAt: Date.now(),
          },
        });
      }
      throw new Error(`Unexpected fetch URL: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("经营驾驶舱")).toBeInTheDocument();

    // Open Keys drawer and issue a new key
    await user.click(screen.getByRole("button", { name: /密钥与接入/ }));
    expect(await screen.findByText("默认密钥")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("密钥备注，例如：生产环境"), "测试密钥");
    await user.click(screen.getByRole("button", { name: "签发密钥" }));
    expect(await screen.findByText("dc_open_new12345_secret_token")).toBeInTheDocument();

    // Close drawer via Escape
    await user.keyboard("{Escape}");

    // Switch to Playground tab and run debug query
    await user.click(screen.getByRole("tab", { name: "在线调试台" }));
    await user.type(screen.getByPlaceholderText(/统计近 30 天/), "查询华东销售额");
    await user.click(screen.getByRole("button", { name: /运行调试/ }));
    expect(await screen.findByText("华东销售额为 12,500 元。")).toBeInTheDocument();
    expect(screen.getByText(/数据范围：上海分公司/)).toBeInTheDocument();

    // Switch to Audit tab
    await user.click(screen.getByRole("tab", { name: "调用审计与用量" }));
    expect(await screen.findByText("POST /api/open/v1/ask")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();

    // Switch to Webhooks tab and trigger replay
    await user.click(screen.getByRole("tab", { name: "Webhook 投递" }));
    expect(await screen.findByText("report.completed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /重放/ }));
    await waitFor(() => {
      expect(fetchStub).toHaveBeenCalledWith(
        "/api/admin/open-platform/webhooks/wh-1/replay",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
