import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DatasourceScopePage from "./DatasourceScopePage";
import { pickSelectOption } from "../../test/select";
import type { DataScopeConfig, ScopeColumnTable, SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

const scope: DataScopeConfig = {
  datasourceId: "ds-1",
  mode: "off",
  policies: [
    {
      id: "p-1",
      datasourceId: "ds-1",
      tableName: "orders",
      mode: "scoped",
      enabled: true,
      rules: [
        {
          id: "r-1",
          columnName: "dept_id",
          operator: "in",
          valueMode: "department_id",
          literalValues: [],
          nullVisible: false,
        },
      ],
    },
  ],
  mappings: [],
  coverage: {
    policies: { total: 1, classified: 1, unclassified: [] },
    departments: { mapped: 0, unmapped: 0, unmappedIds: [] },
    schemaLoaded: true,
  },
};

const columns: {
  refreshedAt: number;
  tables: ScopeColumnTable[];
  candidates: { table: string; column: string }[];
  autoMatched: {
    tableName: string;
    mode: "scoped";
    rules: {
      columnName: string;
      operator: "in";
      valueMode: "department_id";
      nullVisible: boolean;
    }[];
  }[];
} = {
  refreshedAt: 1,
  tables: [
    {
      name: "orders",
      columns: [
        { name: "id", type: "int", comment: null },
        { name: "dept_id", type: "varchar", comment: null },
      ],
    },
  ],
  candidates: [{ table: "orders", column: "dept_id" }],
  autoMatched: [
    {
      tableName: "orders",
      mode: "scoped",
      rules: [
        {
          columnName: "dept_id",
          operator: "in",
          valueMode: "department_id",
          nullVisible: false,
        },
      ],
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
    if (url === "/api/admin/users") {
      return jsonResponse({ users: [{ ...admin, displayName: "Alice" }] });
    }
    if (url === "/api/admin/datasources/ds-1/scope") return jsonResponse(scope);
    if (url === "/api/admin/datasources/ds-1/scope/columns") return jsonResponse(columns);
    if (url.startsWith("/api/admin/datasources/ds-1/scope/diagnostics")) {
      return jsonResponse({
        datasourceId: "ds-1",
        mode: "off",
        userId: "u-admin",
        isAdmin: true,
        canAccessDatasource: true,
        departments: [],
        effectiveDepartmentIds: null,
        tables: [{ table: "orders", decision: "admin_all" }],
      });
    }
    if (url === "/api/admin/datasources/ds-1/scope/denials") {
      return jsonResponse({ denials: [] });
    }
    if (url === "/api/admin/datasources/ds-1/scope/policies" && method === "PUT") {
      return jsonResponse({ policies: scope.policies });
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
      <MemoryRouter initialEntries={["/admin/datasources/ds-1/scope"]}>
        <Routes>
          <Route path="/admin/datasources/:datasourceId/scope" element={<DatasourceScopePage />} />
          <Route path="/chat" element={<div>聊天页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DatasourceScopePage", () => {
  it("renders the classification table with the saved policy", async () => {
    stubApi();
    renderPage();
    expect(await screen.findByText(/行级数据权限 · analytics/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "orders 模式" })).toHaveTextContent("按条件过滤");
    expect(screen.getByText(/dept_id 属于（IN） 部门 ID/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑条件" })).toBeInTheDocument();
    expect(screen.getByText(/所有已缓存表均已分类/)).toBeInTheDocument();
  });

  it("saves edited policies and surfaces coverage errors on enable", async () => {
    const fetchMock = stubApi((url, method) => {
      if (url === "/api/admin/datasources/ds-1/scope/enable" && method === "POST") {
        return jsonResponse(
          { error: { code: "SCOPE_COVERAGE_INCOMPLETE", message: "仍有未分类的表，不能启用" } },
          409,
        );
      }
      return undefined;
    });
    const browser = userEvent.setup();
    renderPage();
    await screen.findByText(/行级数据权限 · analytics/);

    await browser.click(screen.getByRole("button", { name: "编辑条件" }));
    await pickSelectOption(browser, screen.getByRole("combobox", { name: "取值 1" }), "固定值");
    await browser.type(screen.getByLabelText("固定值 1"), "0");
    await browser.click(screen.getByRole("checkbox", { name: "允许空值 1" }));
    await browser.click(screen.getByRole("button", { name: "保存条件" }));
    await browser.click(screen.getByRole("button", { name: "保存分类" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/admin/datasources/ds-1/scope/policies" && init?.method === "PUT",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call![1]!.body)) as {
        policies: {
          tableName: string;
          mode: string;
          rules: {
            columnName: string;
            operator: string;
            valueMode: string;
            literalValues: string[];
            nullVisible: boolean;
          }[];
        }[];
      };
      expect(body.policies).toEqual([
        {
          tableName: "orders",
          mode: "scoped",
          rules: [
            {
              columnName: "dept_id",
              operator: "in",
              valueMode: "literal",
              literalValues: ["0"],
              nullVisible: true,
            },
          ],
        },
      ]);
    });

    await browser.click(screen.getByRole("button", { name: "启用" }));
    expect(await screen.findByText(/仍有未分类的表/)).toBeInTheDocument();
  });

  it("bulk-classifies remaining tables and filters the table list", async () => {
    const fetchMock = stubApi((url) => {
      if (url === "/api/admin/datasources/ds-1/scope/columns") {
        return jsonResponse({
          ...columns,
          tables: [
            ...columns.tables,
            { name: "users", columns: [{ name: "id", type: "int", comment: null }] },
          ],
        });
      }
      return undefined;
    });
    const browser = userEvent.setup();
    renderPage();
    await screen.findByText(/行级数据权限 · analytics/);

    await browser.click(screen.getByRole("button", { name: "拒绝" }));
    await browser.click(screen.getByRole("button", { name: "保存分类" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/admin/datasources/ds-1/scope/policies" && init?.method === "PUT",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call![1]!.body)) as {
        policies: { tableName: string; mode: string }[];
      };
      expect(body.policies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tableName: "orders", mode: "scoped" }),
          expect.objectContaining({ tableName: "users", mode: "denied" }),
        ]),
      );
    });

    await browser.type(screen.getByLabelText("筛选表"), "us");
    expect(screen.getByRole("combobox", { name: "users 模式" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "orders 模式" })).not.toBeInTheDocument();
  });

  it("previews the rewritten SQL for the selected user", async () => {
    stubApi((url, method) => {
      if (url === "/api/admin/datasources/ds-1/scope/preview" && method === "POST") {
        return jsonResponse({
          sql: "SELECT * FROM (SELECT * FROM `orders` WHERE `dept_id` IN (?)) AS `orders`",
          params: ["dept-1"],
          appliedTables: ["orders"],
        });
      }
      return undefined;
    });
    const browser = userEvent.setup();
    renderPage();
    await screen.findByText(/行级数据权限 · analytics/);
    await browser.clear(screen.getByLabelText("预览 SQL"));
    await browser.type(screen.getByLabelText("预览 SQL"), "select * from orders");
    await browser.click(screen.getByRole("button", { name: "预览改写" }));
    expect(await screen.findByText(/SELECT \* FROM \(SELECT \* FROM `orders`/)).toBeInTheDocument();
    expect(screen.getByText(/params: \["dept-1"\]/)).toBeInTheDocument();
    expect(await screen.findByText("管理员全量")).toBeInTheDocument();
  });
});
