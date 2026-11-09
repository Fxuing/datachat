import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AuditPage from "./AuditPage";
import type { AuditEntry, DatasourceSummary, SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

const alice: SessionUser = {
  id: "u-alice",
  username: "alice",
  displayName: "爱丽丝",
  role: "user",
  status: "active",
};

const datasource: DatasourceSummary = {
  id: "ds-1",
  name: "订单库",
  type: "mysql",
  host: "127.0.0.1",
  port: 3306,
  database: "orders",
  username: "reader",
  sslMode: "disable",
  status: "ok",
  readOnlyVerified: true,
  allowWriteAccount: false,
  lastCheckedAt: null,
};

const entries: AuditEntry[] = [
  {
    id: "audit-1",
    runId: "run-1",
    conversationId: "conv-1",
    userId: alice.id,
    datasourceId: datasource.id,
    action: "query",
    sqlText: "select id, amount from orders limit 10",
    status: "ok",
    rowCount: 10,
    durationMs: 42,
    errorMessage: null,
    detailJson: { ip: "10.0.0.7" },
    createdAt: Date.UTC(2026, 10, 5, 9, 30, 0),
  },
  {
    id: "audit-2",
    runId: null,
    conversationId: null,
    userId: null,
    datasourceId: null,
    action: "login_failed",
    sqlText: "",
    status: "rejected",
    rowCount: null,
    durationMs: null,
    errorMessage: "用户名或密码错误",
    detailJson: { ip: "10.0.0.9", username: "mallory" },
    createdAt: Date.UTC(2026, 10, 5, 9, 31, 0),
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Override = (url: string, method: string) => Response | undefined;

function stubApi(override?: Override) {
  const auditUrls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const custom = override?.(url, method);
    if (custom) return custom;

    if (url === "/api/auth/me") return jsonResponse({ user: admin });
    if (url === "/api/admin/users") return jsonResponse({ users: [admin, alice] });
    if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
    if (url.startsWith("/api/admin/audit")) {
      auditUrls.push(url);
      return jsonResponse({ items: entries, total: 2 });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, auditUrls };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/admin/audit"]}>
        <AuditPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuditPage", () => {
  it("renders audit rows with resolved user and datasource names", async () => {
    const { auditUrls } = stubApi();
    renderPage();

    const table = await screen.findByRole("table");
    expect(within(table).getByText("爱丽丝")).toBeDefined();
    expect(within(table).getByText("订单库")).toBeDefined();
    expect(within(table).getByText("10.0.0.7")).toBeDefined();
    expect(within(table).getByText("42 ms")).toBeDefined();
    expect(within(table).getByText("成功")).toBeDefined();
    expect(within(table).getByText("拒绝")).toBeDefined();
    expect(screen.getByText("共 2 条 · 第 1 / 1 页")).toBeDefined();
    expect(auditUrls[0]).toBe("/api/admin/audit?limit=50&offset=0");
  });

  it("sends the selected filters and resets to the first page", async () => {
    const { auditUrls } = stubApi();
    const user = userEvent.setup();
    renderPage();

    const table = await screen.findByRole("table");
    await within(table).findByText("爱丽丝");
    await user.selectOptions(screen.getByLabelText("动作"), "query");
    await user.selectOptions(screen.getByLabelText("状态"), "error");

    await waitFor(() => {
      expect(auditUrls.at(-1)).toBe(
        "/api/admin/audit?action=query&status=error&limit=50&offset=0",
      );
    });
  });

  it("paginates using limit and offset", async () => {
    stubApi((url) => {
      if (url.startsWith("/api/admin/audit")) {
        const offset = Number(new URL(url, "http://localhost").searchParams.get("offset"));
        return jsonResponse({ items: entries, total: 120, offset });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("共 120 条 · 第 1 / 3 页")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("共 120 条 · 第 2 / 3 页")).toBeDefined();
    const next = screen.getByRole("button", { name: "下一页" });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    const prev = screen.getByRole("button", { name: "上一页" });
    expect((prev as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the detail drawer with SQL, error and detail JSON", async () => {
    stubApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("row", { name: /查看审计记录 audit-1/ }));

    const drawer = await screen.findByRole("dialog", { name: "审计详情" });
    expect(drawer.textContent).toContain("select id, amount from orders limit 10");
    expect(drawer.textContent).toContain("42 ms");
    expect(drawer.textContent).toContain("10.0.0.7");

    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "审计详情" })).toBeNull();
    });

    await user.click(screen.getByRole("row", { name: /查看审计记录 audit-2/ }));
    const failedDrawer = await screen.findByRole("dialog", { name: "审计详情" });
    expect(failedDrawer.textContent).toContain("用户名或密码错误");
    expect(failedDrawer.textContent).toContain("mallory");
    expect(failedDrawer.textContent).toContain("无 SQL");
  });

  it("shows an error state with a retry action", async () => {
    stubApi((url) => {
      if (url.startsWith("/api/admin/audit")) {
        return jsonResponse({ error: { code: "BOOM", message: "审计服务不可用" } }, 500);
      }
      return undefined;
    });
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("审计服务不可用");
    expect(screen.getByRole("button", { name: "重试" })).toBeDefined();
  });
});
