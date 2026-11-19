import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import UsersPage from "./UsersPage";
import type { AdminUser } from "../../lib/api";

const createdAt = 1_760_000_000_000;

const self: AdminUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
  createdAt,
  roleIds: ["role_member"],
  roles: [{ id: "role_member", name: "成员" }],
};

const bob: AdminUser = {
  id: "u-bob",
  username: "bob",
  displayName: "Bob",
  role: "user",
  status: "active",
  createdAt,
  roleIds: ["role_member", "role_analyst"],
  roles: [
    { id: "role_member", name: "成员" },
    { id: "role_analyst", name: "分析师" },
  ],
  departments: [{ id: "dept-sales", name: "销售部", code: "SALES", isPrimary: true }],
};

const member = {
  id: "role_member",
  name: "成员",
  description: "默认成员角色",
  builtin: true,
  permissionCount: 6,
  userCount: 2,
};

const analyst = {
  id: "role_analyst",
  name: "分析师",
  description: "查看报表",
  builtin: false,
  permissionCount: 1,
  userCount: 1,
};

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

    if (url === "/api/auth/me") {
      return jsonResponse({
        user: self,
        permissions: ["admin.users"],
        roles: [{ id: "role_member", name: "成员" }],
      });
    }
    if (url === "/api/admin/users" && method === "GET") {
      return jsonResponse({ users: [self, bob] });
    }
    if (url === "/api/admin/users" && method === "POST") {
      return jsonResponse(
        {
          user: {
            ...bob,
            id: "u-alice",
            username: "alice",
            displayName: "Alice",
            roleIds: ["role_member", "role_analyst"],
            roles: [
              { id: "role_member", name: "成员" },
              { id: "role_analyst", name: "分析师" },
            ],
          },
        },
        201,
      );
    }
    if (url === "/api/admin/users/u-bob" && method === "PATCH") {
      return jsonResponse({
        user: {
          ...bob,
          roleIds: ["role_analyst"],
          roles: [{ id: "role_analyst", name: "分析师" }],
        },
      });
    }
    if (url === "/api/admin/roles" && method === "GET") {
      return jsonResponse({ roles: [member, analyst] });
    }
    if (url === "/api/admin/departments" && method === "GET") {
      return jsonResponse({
        departments: [
          {
            id: "dept-sales",
            name: "销售部",
            code: "SALES",
            parentId: null,
            sortOrder: 0,
            status: "active",
            memberCount: 1,
            datasourceIds: [],
            children: [],
          },
        ],
        flat: [
          {
            id: "dept-sales",
            name: "销售部",
            code: "SALES",
            parentId: null,
            sortOrder: 0,
            status: "active",
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: "dept-east",
            name: "华东区",
            code: "EAST",
            parentId: "dept-sales",
            sortOrder: 0,
            status: "active",
            createdAt,
            updatedAt: createdAt,
          },
        ],
      });
    }
    if (
      url.startsWith("/api/admin/users/") &&
      url.endsWith("/departments") &&
      method === "PUT"
    ) {
      return jsonResponse({ departments: [] });
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
      <MemoryRouter initialEntries={["/admin/users"]}>
        <Routes>
          <Route path="/admin/users" element={<UsersPage />} />
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

describe("UsersPage", () => {
  it("renders users with role badges and status", async () => {
    stubApi();
    renderPage();

    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("@bob")).toBeInTheDocument();

    const bobRow = rowOf("Bob");
    expect(within(bobRow).getByText("成员")).toBeInTheDocument();
    expect(within(bobRow).getByText("分析师")).toBeInTheDocument();
    expect(within(bobRow).getByText("销售部")).toBeInTheDocument();
    expect(within(bobRow).getByText("启用")).toBeInTheDocument();

    const selfRow = rowOf("@root");
    expect(within(selfRow).getAllByText("管理员")).toHaveLength(2);
    expect(within(selfRow).getByText("成员")).toBeInTheDocument();

    const search = screen.getByLabelText("搜索用户");
    await userEvent.type(search, "销售");
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByText("@root")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByText("@root")).toBeInTheDocument();
  });

  it("creates a user with two roles and a display name", async () => {
    const browser = userEvent.setup();
    const fetchMock = stubApi();
    renderPage();

    await screen.findByText("Bob");
    await browser.click(screen.getByRole("button", { name: "新建用户" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("成员")).toBeChecked();

    await browser.type(within(dialog).getByLabelText("用户名"), "alice");
    await browser.type(within(dialog).getByLabelText("显示名称"), "Alice");
    await browser.type(within(dialog).getByLabelText("密码"), "alice-pass-123");
    await browser.click(within(dialog).getByLabelText("分析师"));
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(requestBody(fetchMock, "/api/admin/users", "POST")).toEqual({
        username: "alice",
        displayName: "Alice",
        password: "alice-pass-123",
        role: "user",
        roleIds: ["role_member", "role_analyst"],
      }),
    );
  });

  it("keeps department roots collapsed until expanded", async () => {
    const browser = userEvent.setup();
    stubApi();
    renderPage();

    await screen.findByText("Bob");
    await browser.click(screen.getByRole("button", { name: "新建用户" }));

    const dialog = await screen.findByRole("dialog");
    await browser.click(within(dialog).getByRole("combobox", { name: "选择部门" }));

    expect(await screen.findByRole("checkbox", { name: "选择 销售部" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "选择 销售部 / 华东区" })).not.toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "展开 销售部" }));
    expect(screen.getByRole("checkbox", { name: "选择 销售部 / 华东区" })).toBeInTheDocument();
  });

  it("filters departments and saves the selected primary department", async () => {
    const browser = userEvent.setup();
    const fetchMock = stubApi();
    renderPage();

    await screen.findByText("Bob");
    await browser.click(screen.getByRole("button", { name: "新建用户" }));

    const dialog = await screen.findByRole("dialog");
    await browser.type(within(dialog).getByLabelText("用户名"), "alice");
    await browser.type(within(dialog).getByLabelText("显示名称"), "Alice");
    await browser.type(within(dialog).getByLabelText("密码"), "alice-pass-123");

    await browser.click(within(dialog).getByRole("combobox", { name: "选择部门" }));
    await browser.type(await screen.findByLabelText("筛选部门"), "华东");
    // 父部门作为上下文保留，但不参与命中选择。
    expect(screen.getByRole("checkbox", { name: "选择 销售部" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择 销售部 / 华东区" })).toBeInTheDocument();
    await browser.click(screen.getByRole("checkbox", { name: "选择 销售部 / 华东区" }));
    await browser.click(screen.getByRole("button", { name: "设 销售部 / 华东区 为主部门" }));
    await browser.click(screen.getByRole("button", { name: "完成" }));

    expect(within(dialog).getByText("华东区")).toBeInTheDocument();
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(requestBody(fetchMock, "/api/admin/users/u-alice/departments", "PUT")).toEqual({
        departmentIds: ["dept-east"],
        primaryId: "dept-east",
      }),
    );
  });

  it("creates a system admin when the admin flag is checked", async () => {
    const browser = userEvent.setup();
    const fetchMock = stubApi();
    renderPage();

    await screen.findByText("Bob");
    await browser.click(screen.getByRole("button", { name: "新建用户" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("系统管理员")).not.toBeChecked();

    await browser.type(within(dialog).getByLabelText("用户名"), "alice");
    await browser.type(within(dialog).getByLabelText("密码"), "alice-pass-123");
    await browser.click(within(dialog).getByLabelText("系统管理员"));
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(requestBody(fetchMock, "/api/admin/users", "POST")).toEqual({
        username: "alice",
        password: "alice-pass-123",
        role: "admin",
        roleIds: ["role_member"],
      }),
    );
  });

  it("replaces the assigned roles when editing a user", async () => {
    const browser = userEvent.setup();
    const fetchMock = stubApi();
    renderPage();

    await screen.findByText("Bob");
    await browser.click(within(rowOf("Bob")).getByRole("button", { name: "编辑" }));

    const dialog = await screen.findByRole("dialog");
    expect(roleCheckbox(dialog, "成员")).toBeChecked();
    expect(roleCheckbox(dialog, "分析师")).toBeChecked();

    await browser.click(roleCheckbox(dialog, "成员"));
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(requestBody(fetchMock, "/api/admin/users/u-bob", "PATCH")).toEqual({
        displayName: "Bob",
        roleIds: ["role_analyst"],
        status: "active",
        role: "user",
      }),
    );
  });

  it("requires at least one role before saving", async () => {
    const browser = userEvent.setup();
    stubApi();
    renderPage();

    await screen.findByText("Bob");
    await browser.click(screen.getByRole("button", { name: "新建用户" }));

    const dialog = await screen.findByRole("dialog");
    await browser.click(roleCheckbox(dialog, "成员"));

    expect(within(dialog).getByText("至少选择一个角色。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("disables the status control when editing your own account", async () => {
    const browser = userEvent.setup();
    stubApi();
    renderPage();

    await screen.findByText("Bob");
    await browser.click(within(rowOf("@root")).getByRole("button", { name: "编辑" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "状态" })).toBeDisabled();
    expect(within(dialog).getByText("不能禁用自己的账号。")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("系统管理员")).toBeChecked();
    expect(within(dialog).getByLabelText("系统管理员")).toBeDisabled();
    expect(within(dialog).getByText("不能修改自己的管理员角色。")).toBeInTheDocument();
  });

  it("promotes a user to system admin from the edit dialog", async () => {
    const browser = userEvent.setup();
    const fetchMock = stubApi();
    renderPage();

    await screen.findByText("Bob");
    await browser.click(within(rowOf("Bob")).getByRole("button", { name: "编辑" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("系统管理员")).not.toBeChecked();

    await browser.click(within(dialog).getByLabelText("系统管理员"));
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(requestBody(fetchMock, "/api/admin/users/u-bob", "PATCH")).toEqual({
        displayName: "Bob",
        roleIds: ["role_member", "role_analyst"],
        status: "active",
        role: "admin",
      }),
    );
  });

  it("skips department requests when the viewer lacks admin.departments permission", async () => {
    const browser = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/auth/me") {
        return jsonResponse({
          user: { ...self, role: "user" },
          permissions: ["admin.users"],
          roles: [{ id: "role_member", name: "成员" }],
        });
      }
      if (url === "/api/admin/users" && method === "GET") return jsonResponse({ users: [self, bob] });
      if (url === "/api/admin/roles" && method === "GET") return jsonResponse({ roles: [member, analyst] });
      if (url === "/api/admin/users/u-bob" && method === "PATCH") return jsonResponse({ user: bob });
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Bob");
    await browser.click(within(rowOf("Bob")).getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("部门")).not.toBeInTheDocument();
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input) === "/api/admin/users/u-bob" && init?.method === "PATCH",
        ),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("departments")),
    ).toBe(false);
  });
});

function roleCheckbox(scope: HTMLElement, name: string): HTMLElement {
  return within(scope).getByLabelText(name);
}
