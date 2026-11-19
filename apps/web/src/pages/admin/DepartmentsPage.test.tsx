import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DepartmentsPage from "./DepartmentsPage";
import { pickSelectOption } from "../../test/select";
import type { DepartmentNode, SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

const sales: DepartmentNode = {
  id: "dept-sales",
  name: "销售部",
  code: "sales",
  parentId: null,
  sortOrder: 0,
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  memberCount: 1,
  datasourceIds: ["ds-1"],
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
      memberCount: 0,
      datasourceIds: [],
      children: [],
    },
  ],
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
    if (url === "/api/admin/departments" && method === "GET") {
      return jsonResponse({ departments: [sales], flat: [sales, sales.children[0]] });
    }
    if (url === "/api/admin/departments" && method === "POST") {
      return jsonResponse({ department: { ...sales, id: "dept-new", name: "华南区" } }, 201);
    }
    if (url === "/api/admin/departments/dept-sales/members") {
      return jsonResponse({
        members: [{ id: "u-bob", username: "bob", displayName: "Bob", isPrimary: true }],
      });
    }
    if (url === "/api/admin/departments/dept-sales/grants") {
      return jsonResponse({ datasourceIds: ["ds-1"] });
    }
    if (url.startsWith("/api/admin/departments/dept-sales/move")) {
      return jsonResponse({ department: sales });
    }
    if (url === "/api/datasources") {
      return jsonResponse({
        datasources: [
          {
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
            lastCheckedAt: 1,
          },
        ],
      });
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
      <MemoryRouter initialEntries={["/admin/departments"]}>
        <Routes>
          <Route path="/admin/departments" element={<DepartmentsPage />} />
          <Route path="/chat" element={<div>聊天页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DepartmentsPage", () => {
  it("renders the department tree with member counts", async () => {
    stubApi();
    renderPage();
    expect(await screen.findByText(/销售部/)).toBeInTheDocument();
    expect(screen.getByText(/1 人/)).toBeInTheDocument();
  });

  it("creates a child department under the selected node", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();
    await screen.findByText(/销售部/);
    await browser.click(screen.getByRole("button", { name: "在 销售部 下新建子部门" }));
    const dialog = await screen.findByRole("dialog", { name: "新建部门" });
    await browser.type(within(dialog).getByLabelText("名称"), "华南区");
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input) === "/api/admin/departments" && init?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ name: "华南区", parentId: "dept-sales" });
    });
  });

  it("shows members and read-only inherited datasource grants for a department", async () => {
    stubApi();
    const browser = userEvent.setup();
    renderPage();
    await browser.click(await screen.findByRole("button", { name: /^销售部/ }));
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("analytics")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /前往数据源管理配置授权/ })).toHaveAttribute(
      "href",
      "/admin/datasources",
    );
  });

  it("moves a department through the parent select", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();
    await browser.click(await screen.findByRole("button", { name: /^销售部/ }));
    await pickSelectOption(browser, screen.getByLabelText("上级部门"), "华东区");
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/admin/departments/dept-sales/move" && init?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ parentId: "dept-east" });
    });
  });
});
