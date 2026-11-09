import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ChatResult, ChatSql } from "../../lib/api";
import { QueryPairList } from "./QueryPairList";

const sql: ChatSql = {
  sql: "SELECT id, name FROM users LIMIT 10",
  auditId: "audit-1",
  status: "ok",
};

const result: ChatResult = {
  artifactId: "artifact-1",
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
  ],
  rows: [[1, "Ada"]],
  rowCount: 1,
  truncated: false,
  sql: sql.sql,
};

describe("QueryPairList", () => {
  it("puts each executed SQL directly above its result", () => {
    render(<QueryPairList sqls={[sql]} results={[result]} />);

    const code = screen.getByText(/SELECT id, name/);
    const label = screen.getByText("查询结果");
    expect(code.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("1 行 · 2 列")).toBeInTheDocument();
  });

  it("keeps rejected SQL and unpaired results visible", () => {
    render(
      <QueryPairList
        sqls={[{ sql: "DROP TABLE users", auditId: "audit-2", status: "rejected" }]}
        results={[result]}
      />,
    );

    expect(screen.getByText("DROP TABLE users")).toBeInTheDocument();
    expect(screen.getByText("查询结果")).toBeInTheDocument();
  });
});
