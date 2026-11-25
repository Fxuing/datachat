import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExcelCard } from "./ExcelCard";
import type { ChatResult } from "../../lib/api";

const mocks = vi.hoisted(() => ({
  getArtifactRows: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    getArtifactRows: mocks.getArtifactRows,
  };
});

describe("ExcelCard", () => {
  beforeEach(() => {
    mocks.getArtifactRows.mockReset();
  });

  const sheets = [
    { name: "区域汇总", artifactId: "res-1", rowCount: 2 },
    { name: "订单明细", artifactId: "res-2", rowCount: 15 },
  ];

  const cachedResult: ChatResult = {
    artifactId: "res-1",
    columns: [
      { name: "region", type: "string" },
      { name: "amount", type: "number" },
    ],
    rows: [
      ["华东", 1200],
      ["华南", 800],
    ],
    rowCount: 2,
    truncated: false,
    sql: "SELECT region, SUM(amount) AS amount FROM orders GROUP BY region",
  };

  it("renders filename, sheet summary, download link and opens cached + lazy sheet previews", async () => {
    const user = userEvent.setup();
    mocks.getArtifactRows.mockResolvedValue({
      columns: [
        { name: "order_id", type: "number" },
        { name: "customer", type: "string" },
      ],
      rows: [[1001, "张三"]],
      total: 15,
    });

    render(
      <ExcelCard
        artifactId="xls-1"
        filename="2025年Q1销售分析"
        sheets={sheets}
        totalRows={17}
        allResults={[cachedResult]}
        canExport
      />,
    );

    expect(screen.getByText("2025年Q1销售分析.xlsx")).toBeInTheDocument();
    expect(screen.getByText("2 个工作表 · 共 17 行")).toBeInTheDocument();

    const download = screen.getByRole("link", { name: "下载 Excel" });
    expect(download).toHaveAttribute("href", "/api/artifacts/xls-1/download?format=xlsx");

    // Click cached sheet -> renders immediately without calling getArtifactRows
    await user.click(screen.getByRole("button", { name: /区域汇总/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("华东")).toBeInTheDocument();
    expect(mocks.getArtifactRows).not.toHaveBeenCalled();

    // Close and click second sheet -> fetches rows lazily via getArtifactRows
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /订单明细/ }));
    await waitFor(() => {
      expect(mocks.getArtifactRows).toHaveBeenCalledWith("res-2", { offset: 0, limit: 100 });
    });
    expect(await screen.findByText("张三")).toBeInTheDocument();
  });

  it("disables download when export.data permission is missing", () => {
    render(
      <ExcelCard
        artifactId="xls-1"
        filename="无权限工作簿"
        sheets={[sheets[0]!]}
        totalRows={2}
        canExport={false}
      />,
    );

    expect(screen.queryByRole("link", { name: "下载 Excel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 Excel" })).toBeDisabled();
  });
});
