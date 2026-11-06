import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Column } from "@datachat/shared";
import { ResultTable } from "./ResultTable";

const columns: Column[] = [
  { name: "name", type: "string" },
  { name: "amount", type: "number" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResultTable", () => {
  it("right-aligns numeric cells, renders nulls as ∅, and shows the row count", () => {
    render(
      <ResultTable
        artifactId="artifact-1"
        columns={columns}
        rows={[
          ["alice", 42],
          [null, null],
        ]}
        rowCount={2}
        truncated={false}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "amount" })).toHaveClass("text-right");
    expect(screen.getByRole("columnheader", { name: "name" })).toHaveClass("text-left");

    const numeric = screen.getByText("42");
    expect(numeric).toHaveAttribute("data-type", "number");
    expect(numeric).toHaveClass("text-right");

    expect(screen.getAllByLabelText("空值")).toHaveLength(2);
    expect(screen.getAllByText("∅")).toHaveLength(2);

    expect(screen.getByText("显示 2 / 2 行")).toBeInTheDocument();
    expect(screen.queryByText(/完整结果在导出中提供/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("caps the preview at 100 rows and notes when more rows exist", () => {
    const rows = Array.from({ length: 120 }, (_, index) => [index]);
    render(
      <ResultTable
        artifactId="artifact-1"
        columns={[{ name: "n", type: "number" }]}
        rows={rows}
        rowCount={150}
        truncated={false}
      />,
    );

    expect(screen.getByText("显示 100 / 150 行")).toBeInTheDocument();
    expect(
      screen.getByText("仅展示前 100 行（共 150 行），完整结果在导出中提供"),
    ).toBeInTheDocument();
    expect(screen.getByText("99")).toBeInTheDocument();
    expect(screen.queryByText("100")).not.toBeInTheDocument();

    expect(
      screen.getByRole("link", { name: "下载 CSV" }),
    ).toHaveAttribute("href", "/api/artifacts/artifact-1/download?format=csv");
    expect(
      screen.getByRole("link", { name: "下载 Excel" }),
    ).toHaveAttribute("href", "/api/artifacts/artifact-1/download?format=xlsx");
  });

  it("loads more rows from the artifact API and appends them up to rowCount", async () => {
    const preview = Array.from({ length: 100 }, (_, index) => [index]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset"));
      return jsonResponse({
        columns: [{ name: "n", type: "number" }],
        rows: [[offset], [offset + 1]],
        total: 104,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ResultTable
        artifactId="artifact-1"
        columns={[{ name: "n", type: "number" }]}
        rows={preview}
        rowCount={104}
        truncated={false}
      />,
    );

    expect(screen.getByText("显示 100 / 104 行")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));

    await waitFor(() => {
      expect(screen.getByText("显示 102 / 104 行")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/artifacts/artifact-1/rows?offset=100&limit=100",
      expect.objectContaining({ credentials: "include" }),
    );

    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));

    await waitFor(() => {
      expect(screen.getByText("显示 104 / 104 行")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/artifacts/artifact-1/rows?offset=102&limit=100",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(screen.getByRole("cell", { name: "103" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("offers report creation when a callback is provided", async () => {
    const onCreateReport = vi.fn();
    render(
      <ResultTable
        artifactId="artifact-1"
        columns={columns}
        rows={[["alice", 42]]}
        rowCount={1}
        truncated={false}
        onCreateReport={onCreateReport}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "生成报告" }));
    expect(onCreateReport).toHaveBeenCalledWith("artifact-1");
  });
});
