import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DatasourcesPage from "./DatasourcesPage";
import { pickSelectOption } from "../../test/select";
import type { DatasourceSchemaResponse, DatasourceSummary, SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

const healthy: DatasourceSummary = {
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

const broken: DatasourceSummary = {
  ...healthy,
  id: "ds-2",
  name: "warehouse",
  type: "postgres",
  port: 5432,
  status: "error",
  readOnlyVerified: false,
  allowWriteAccount: false,
  lastCheckedAt: null,
};

const schema: DatasourceSchemaResponse = {
  tables: [
    {
      schema: "public",
      name: "orders",
      comment: "订单",
      rowEstimate: 1200,
      columns: [
        {
          name: "id",
          type: "integer",
          nullable: false,
          defaultValue: null,
          comment: "主键",
        },
        {
          name: "user_id",
          type: "integer",
          nullable: false,
          defaultValue: null,
          comment: null,
        },
      ],
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [
        {
          name: "orders_user_id_fkey",
          columns: ["user_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
        },
      ],
    },
  ],
  refreshedAt: 1_760_000_000_000,
  stale: false,
  error: null,
  total: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Override = (url: string, method: string) => Response | undefined;

function stubApi(override?: Override) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const custom = override?.(url, method);
    if (custom) return custom;

    if (url === "/api/auth/me") return jsonResponse({ user: admin, permissions: [], roles: [] });
    if (url === "/api/datasources" && method === "GET") {
      return jsonResponse({ datasources: [healthy, broken] });
    }
    if (url === "/api/datasources/ds-1" && method === "PATCH") {
      return jsonResponse({ ok: true });
    }
    if (url === "/api/datasources" && method === "POST") {
      return jsonResponse({ id: "ds-new", warnings: [], readOnly: true }, 201);
    }
    if (url.startsWith("/api/datasources/ds-1/schema")) {
      return jsonResponse(schema);
    }
    if (url === "/api/admin/users") {
      return jsonResponse({
        users: [
          { ...admin, displayName: "Alice", departments: [] },
          {
            id: "u-bob",
            username: "bob",
            displayName: "Bob",
            role: "user",
            status: "active",
            departments: [{ id: "dept-east", name: "华东区", code: "east", isPrimary: true }],
          },
          { id: "u-old", username: "old", displayName: "Old", role: "user", status: "disabled" },
        ],
      });
    }
    if (url === "/api/admin/departments") {
      return jsonResponse({
        departments: [
          {
            id: "dept-sales",
            name: "销售部",
            code: "sales",
            parentId: null,
            sortOrder: 0,
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            memberCount: 0,
            datasourceIds: [],
            children: [
              {
                id: "dept-east",
                name: "华东区",
                code: "east",
                parentId: "dept-sales",
                sortOrder: 0,
                status: "active",
                createdAt: 1,
                updatedAt: 1,
                memberCount: 1,
                datasourceIds: [],
                children: [],
              },
            ],
          },
        ],
        flat: [],
      });
    }
    if (url === "/api/admin/datasources/ds-1/grants" && method === "GET") {
      return jsonResponse({ userIds: ["u-admin"], departmentIds: [], inheritedUsers: {} });
    }
    if (url === "/api/admin/datasources/ds-1/grants" && method === "PUT") {
      return jsonResponse({ ok: true });
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
      <MemoryRouter initialEntries={["/admin/datasources"]}>
        <Routes>
          <Route path="/admin/datasources" element={<DatasourcesPage />} />
          <Route path="/chat" element={<div>聊天页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function requestBody(fetchMock: ReturnType<typeof stubApi>, url: string, method: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => String(input) === url && init?.method === method,
  );
  expect(call).toBeTruthy();
  return JSON.parse(String(call![1]!.body));
}

async function openRowMenu(
  browser: ReturnType<typeof userEvent.setup>,
  index = 0,
): Promise<HTMLElement> {
  await browser.hover(screen.getAllByRole("button", { name: /更多操作/ })[index]!);
  return screen.findByRole("menu");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DatasourcesPage", () => {
  it("renders status, read-only verification, address and actions", async () => {
    const browser = userEvent.setup();
    stubApi();
    renderPage();

    expect(await screen.findByText("analytics")).toBeInTheDocument();
    expect(screen.getByText("正常")).toBeInTheDocument();
    expect(
      screen.getAllByText("只读已验证").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("127.0.0.1:3306/analytics")).toBeInTheDocument();
    expect(screen.getByText("warehouse")).toBeInTheDocument();
    expect(screen.getByText("异常")).toBeInTheDocument();
    await browser.hover(screen.getByText("异常"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "最近一次连接测试失败，请检查网络、账号或 SSL 配置。",
    );
    expect(screen.getAllByRole("button", { name: "测试连接" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "编辑" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "查看结构" })).not.toBeInTheDocument();

    const menu = await openRowMenu(browser);
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(5);
    expect(within(menu).getByRole("menuitem", { name: "查看结构" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "行级权限" })).toBeInTheDocument();
  });

  it("edits without sending a password when the field is blank", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await screen.findByText("analytics");
    await browser.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "编辑数据源" });
    expect(within(dialog).getByLabelText("密码")).toHaveValue("");
    expect(within(dialog).getByPlaceholderText("留空表示不修改")).toBeInTheDocument();

    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const body = requestBody(fetchMock, "/api/datasources/ds-1", "PATCH") as Record<
        string,
        unknown
      >;
      expect(body.name).toBe("analytics");
      expect(body).not.toHaveProperty("password");
      expect(body).not.toHaveProperty("type");
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "编辑数据源" })).not.toBeInTheDocument(),
    );
  });

  it("creates a datasource with a password and resets the port only while untouched", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "新建数据源" }));
    const dialog = await screen.findByRole("dialog", { name: "新建数据源" });

    expect(within(dialog).getByLabelText("端口")).toHaveValue(3306);
    await pickSelectOption(browser, within(dialog).getByLabelText("类型"), "PostgreSQL");
    expect(within(dialog).getByLabelText("端口")).toHaveValue(5432);

    await browser.clear(within(dialog).getByLabelText("端口"));
    await browser.type(within(dialog).getByLabelText("端口"), "6600");
    await pickSelectOption(browser, within(dialog).getByLabelText("类型"), "MySQL");
    expect(within(dialog).getByLabelText("端口")).toHaveValue(6600);
    await pickSelectOption(browser, within(dialog).getByLabelText("类型"), "PostgreSQL");
    expect(within(dialog).getByLabelText("端口")).toHaveValue(6600);

    await browser.type(within(dialog).getByLabelText("名称"), "events");
    await browser.type(within(dialog).getByLabelText("主机"), "db.internal");
    await browser.type(within(dialog).getByLabelText("数据库"), "events");
    await browser.type(within(dialog).getByLabelText("用户名"), "writer");
    await browser.type(within(dialog).getByLabelText("密码"), "s3cret");
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(requestBody(fetchMock, "/api/datasources", "POST")).toEqual({
        name: "events",
        type: "postgres",
        host: "db.internal",
        port: 6600,
        database: "events",
        username: "writer",
        password: "s3cret",
        sslMode: "disable",
        allowWriteAccount: false,
      });
    });
  });

  it("shows the 409 message inline when deleting a referenced datasource", async () => {
    stubApi((url, method) => {
      if (url === "/api/datasources/ds-1" && method === "DELETE") {
        return jsonResponse(
          {
            error: {
              code: "DS_IN_USE",
              message: "数据源已被会话引用，无法删除",
            },
          },
          409,
        );
      }
      return undefined;
    });
    const browser = userEvent.setup();
    renderPage();

    await screen.findByText("analytics");
    const menu = await openRowMenu(browser);
    await browser.click(within(menu).getByRole("menuitem", { name: "删除" }));
    const confirm = await screen.findByRole("dialog", { name: "删除数据源" });
    await browser.click(within(confirm).getByRole("button", { name: "确认删除" }));

    expect(await within(confirm).findByRole("alert")).toHaveTextContent(
      "该数据源已有会话，暂不能删除",
    );
    expect(screen.getByRole("dialog", { name: "删除数据源" })).toBeInTheDocument();
  });

  it("manages department grants and active-user exceptions in one dialog", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await screen.findByText("analytics");
    const menu = await openRowMenu(browser);
    await browser.click(within(menu).getByRole("menuitem", { name: "授权" }));
    const dialog = await screen.findByRole("dialog", { name: "analytics 的授权" });

    // Select parent department -> child immediately shows inherited badge.
    const salesCheckbox = await within(dialog).findByRole("checkbox", { name: /销售部/ });
    await browser.click(salesCheckbox);
    expect(within(dialog).getByText("已继承自 销售部")).toBeInTheDocument();

    // Switch to direct user exceptions tab: active users only, and Bob shows department grant source.
    await browser.click(within(dialog).getByRole("tab", { name: /个人特例直授/ }));
    expect(await within(dialog).findByText("Alice")).toBeInTheDocument();
    expect(within(dialog).getByText("Bob")).toBeInTheDocument();
    expect(within(dialog).getByText("部门已授权：销售部")).toBeInTheDocument();
    expect(within(dialog).queryByText("Old")).not.toBeInTheDocument();

    const alice = within(dialog).getByRole("checkbox", { name: /Alice/ });
    const bob = within(dialog).getByRole("checkbox", { name: /Bob/ });
    expect(alice).toBeChecked();
    expect(bob).not.toBeChecked();

    await browser.click(bob);
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const body = requestBody(
        fetchMock,
        "/api/admin/datasources/ds-1/grants",
        "PUT",
      ) as { userIds: string[]; departmentIds: string[] };
      expect([...body.userIds].sort()).toEqual(["u-admin", "u-bob"]);
      expect(body.departmentIds).toEqual(["dept-sales"]);
    });
  });

  it("debounces schema search and sends the search parameter", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await screen.findByText("analytics");
    const menu = await openRowMenu(browser);
    await browser.click(within(menu).getByRole("menuitem", { name: "查看结构" }));
    const drawer = await screen.findByRole("dialog", { name: "analytics 的表结构" });
    expect(await within(drawer).findByText("public.orders")).toBeInTheDocument();

    await browser.type(within(drawer).getByLabelText("搜索表"), "orders");
    const searchCalls = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/schema?search=orders"),
      );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(searchCalls()).toHaveLength(0);

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(String(searchCalls()[0]![0])).toBe("/api/datasources/ds-1/schema?search=orders");

    await browser.click(within(drawer).getByRole("button", { name: "展开表 public.orders" }));
    expect(within(drawer).getByText("user_id")).toBeInTheDocument();
    expect(within(drawer).getAllByText("主键").length).toBeGreaterThan(0);
  });
});
