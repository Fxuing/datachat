import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataCatalogDrawer } from "./DataCatalogDrawer";
import type { DatasourceCatalogResponse, DatasourceSummary } from "../../lib/api";

const datasource: DatasourceSummary = {
  id: "ds-1",
  name: "电商库",
  type: "mysql",
  host: "127.0.0.1",
  port: 3306,
  database: "shop",
  username: "reader",
  sslMode: "disable",
  status: "ok",
  readOnlyVerified: true,
  allowWriteAccount: false,
  lastCheckedAt: null,
};

const catalog: DatasourceCatalogResponse = {
  datasourceId: "ds-1",
  refreshedAt: 1_700_000_000_000,
  stale: false,
  tableCount: 1,
  scopeNotice: null,
  metrics: [
    {
      id: "m-1",
      name: "GMV",
      synonyms: ["成交总额"],
      description: "已支付订单总金额",
      tableName: "orders",
      timeColumn: "paid_at",
      unit: "元",
    },
  ],
  relations: [
    {
      id: "r-1",
      leftTable: "orders",
      leftColumn: "user_id",
      rightTable: "users",
      rightColumn: "id",
      joinType: "left",
      description: "订单关联用户",
    },
  ],
  starterQuestions: [],
};

function renderDrawer(
  overrides: {
    schemaResponse?: () => Response;
    onInsertPrompt?: (text: string) => void;
    onClose?: () => void;
    customCatalog?: DatasourceCatalogResponse | null;
  } = {},
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/datasources/ds-1/schema")) {
      if (overrides.schemaResponse) return overrides.schemaResponse();
      return new Response(
        JSON.stringify({
          tables: [
            {
              schema: "shop",
              name: "orders",
              comment: "订单主表",
              rowEstimate: 1200,
              columns: [
                { name: "id", type: "bigint", nullable: false, comment: "主键" },
                { name: "amount", type: "decimal", nullable: false, comment: "金额" },
              ],
              primaryKey: ["id"],
              foreignKeys: [],
              indexes: [],
            },
          ],
          refreshedAt: 1_700_000_000_000,
          stale: false,
          error: null,
          total: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = overrides.onClose ?? vi.fn();
  const onInsertPrompt = overrides.onInsertPrompt ?? vi.fn();

  render(
    <QueryClientProvider client={client}>
      <DataCatalogDrawer
        datasource={datasource}
        catalog={overrides.customCatalog === undefined ? catalog : overrides.customCatalog}
        onInsertPrompt={onInsertPrompt}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );

  return { fetchMock, onClose, onInsertPrompt };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DataCatalogDrawer", () => {
  it("lists tables, expands columns, and inserts table prompt", async () => {
    const browser = userEvent.setup();
    const { onClose, onInsertPrompt } = renderDrawer();

    expect(await screen.findByText("shop.orders")).toBeInTheDocument();
    await browser.click(screen.getByRole("button", { name: "展开表 shop.orders" }));
    expect(await screen.findByText("amount")).toBeInTheDocument();
    expect(screen.getByText("PK")).toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "插入提问" }));
    expect(onInsertPrompt).toHaveBeenCalledWith("请分析 orders 表的数据情况：");
    expect(onClose).toHaveBeenCalled();
  });

  it("filters metrics and inserts metric prompt", async () => {
    const browser = userEvent.setup();
    const { onClose, onInsertPrompt } = renderDrawer();

    await browser.click(screen.getByRole("tab", { name: /业务指标/ }));
    expect(await screen.findByText("GMV")).toBeInTheDocument();
    expect(screen.getByText("成交总额")).toBeInTheDocument();

    await browser.type(screen.getByLabelText("搜索业务指标"), "GMV");
    await browser.click(screen.getByRole("button", { name: "去提问" }));
    expect(onInsertPrompt).toHaveBeenCalledWith("请分析「GMV」的近期趋势和核心构成");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows friendly notice when user lacks department under data scope", async () => {
    renderDrawer({
      schemaResponse: () =>
        new Response(
          JSON.stringify({
            error: {
              code: "DATA_SCOPE_NO_DEPARTMENT",
              message: "当前数据源已启用部门数据权限，但你还没有加入任何部门",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      customCatalog: { ...catalog, tableCount: 0, metrics: [], relations: [], scopeNotice: "缺少部门" },
    });

    await waitFor(() =>
      expect(screen.getByText(/还没有加入任何部门/)).toBeInTheDocument(),
    );
  });
});
