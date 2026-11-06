import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Column } from "@datachat/shared";
import { ResultTable } from "./ResultTable";

const columns: Column[] = [
  { name: "name", type: "string" },
  { name: "amount", type: "number" },
];

describe("ResultTable", () => {
  it("right-aligns numeric cells, renders nulls as ∅, and shows the row count", () => {
    render(
      <ResultTable
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
  });

  it("caps the preview at 100 rows and notes when more rows exist", () => {
    const rows = Array.from({ length: 120 }, (_, index) => [index]);
    render(
      <ResultTable
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
  });
});
