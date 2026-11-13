import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RolesPage from "./RolesPage";
import type { DatasourceSummary, SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

const analytics: DatasourceSummary = {
  id: "ds-1",
  name: "analytics",
  type: "mysql",
  host: "127.0.0.1",
  port: 3306,
  database: "analytics",
  username: "reader",
  sslMode: "disable",
  status: "ok",
  readOnlyVerified: true,
  allowWriteAccount: false,
  lastCheckedAt: 1_760_000_000_000,
};

const warehouse: DatasourceSummary = {
  ...analytics,
  id: "ds-2",
  name: "warehouse",
  type: "postgres",
  port: 5432,
};

const member = {
  id: "role-member",
  name: "成员",
  description: "默认成员角色",
  builtin: 1,
  isBuiltin: true,
  permissionCount: 2,
  datasourceCount: 1,
  userCount: 3,
  createdAt: 1,
  updatedAt: 2,
};

const analyst = {
  id: "role-analyst",
  name: "分析师",
  description: "查看报表",
  builtin: 0,
  isBuiltin: false,
  permissionCount: 1,
  datasourceCount: 0,
  userCount: 1,
  createdAt: 1,
  updatedAt: 2,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubApi() {
  const roles = [member, analyst];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url === "/api/auth/me") {
      return jsonResponse({
        user: admin,
        permissions: ["admin.roles"],
        roles: [{ id: "role-admin", name: "管理员" }],
      });
    }
    if (url === "/api/admin/roles" && method === "GET") {
      return jsonResponse({ roles });
    }
    if (url === "/api/admin/roles" && method === "POST") {
      return jsonResponse({ role: { ...analyst, id: "role-new", name: "只读访客" } }, 201);
    }
    if (url === "/api/admin/roles/role-member" && method === "GET") {
      return jsonResponse({
        role: {
          ...member,
          permissions: ["chat.use", "report.create"],
          datasourceIds: ["ds-1"],
        },
      });
    }
    if (url === "/api/admin/roles/role-analyst" && method === "GET") {
      return jsonResponse({
        role: { ...analyst, permissions: ["report.create"], datasourceIds: [] },
      });
    }
    if (url === "/api/admin/roles/role-analyst" && method === "DELETE") {
      const index = roles.findIndex((role) => role.id === "role-analyst");
      if (index >= 0) roles.splice(index, 1);
      return jsonResponse({ ok: true });
    }
    if (url === "/api/datasources" && method === "GET") {
      return jsonResponse({ datasources: [analytics, warehouse] });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/admin/roles"]}>
        <Routes>
          <Route path="/admin/roles" element={<RolesPage />} />
          <Route path="/chat" element={<div>聊天页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

function requestBody(
  fetchMock: ReturnType<typeof stubApi>,
  url: string,
  method: string,
): unknown {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => String(input) === url && init?.method === method,
  );
  expect(call).toBeTruthy();
  return JSON.parse(String(call![1]!.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RolesPage", () => {
  it("renders roles with counts and builtin badge", async () => {
    stubApi();
    renderPage();

    expect(await screen.findByText("成员")).toBeInTheDocument();
    expect(screen.getByText("分析师")).toBeInTheDocument();

    const memberRow = rowOf("成员");
    expect(within(memberRow).getByText("内置")).toBeInTheDocument();
    expect(within(memberRow).getByText("2")).toBeInTheDocument();
    expect(within(memberRow).getByText("3")).toBeInTheDocument();

    const analystRow = rowOf("分析师");
    expect(within(analystRow).queryByText("内置")).not.toBeInTheDocument();
    expect(within(analystRow).getByText("查看报表")).toBeInTheDocument();
  });

  it("creates a role with the selected permission and datasource", async () => {
    const browser = userEvent.setup();
    const fetchMock = stubApi();
    renderPage();

    await screen.findByText("成员");
    await browser.click(screen.getByRole("button", { name: "新建角色" }));

    await browser.type(await screen.findByLabelText("名称"), "只读访客");
    await browser.type(screen.getByLabelText("描述"), "仅能生成报告");
    await browser.click(screen.getByLabelText("生成报告"));
    await browser.click(await screen.findByRole("checkbox", { name: /warehouse/ }));
    await browser.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(requestBody(fetchMock, "/api/admin/roles", "POST")).toEqual({
        name: "只读访客",
        description: "仅能生成报告",
        permissions: ["report.create"],
        datasourceIds: ["ds-2"],
      }),
    );
  });

  it("does not allow renaming or deleting a builtin role", async () => {
    const browser = userEvent.setup();
    stubApi();
    renderPage();

    await screen.findByText("成员");
    expect(within(rowOf("成员")).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();

    await browser.click(within(rowOf("成员")).getByRole("button", { name: "编辑" }));

    expect(await screen.findByLabelText("名称")).toBeDisabled();
    expect(screen.getByLabelText("名称")).toHaveValue("成员");
    expect(
      within(screen.getByRole("dialog")).queryByRole("button", { name: "删除" }),
    ).not.toBeInTheDocument();
  });

  it("never offers system permissions", async () => {
    const browser = userEvent.setup();
    stubApi();
    renderPage();

    await screen.findByText("成员");
    await browser.click(screen.getByRole("button", { name: "新建角色" }));

    expect(await screen.findByLabelText("使用对话")).toBeInTheDocument();
    expect(screen.queryByText("系统权限（仅内置管理员）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("用户管理")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("角色管理")).not.toBeInTheDocument();
  });

  it("deletes a custom role after confirmation", async () => {
    const browser = userEvent.setup();
    const fetchMock = stubApi();
    renderPage();

    await screen.findByText("分析师");
    await browser.click(within(rowOf("分析师")).getByRole("button", { name: "删除" }));

    expect(await screen.findByText(/确定删除角色/)).toBeInTheDocument();
    await browser.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(screen.queryByText("分析师")).not.toBeInTheDocument(),
    );
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/admin/roles/role-analyst" && init?.method === "DELETE",
      ),
    ).toBe(true);
  });
});
