import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { FileUploadPanel } from "./FileUploadPanel";
import type { FilePreviewResponse } from "../../lib/api";

const samplePreview: FilePreviewResponse = {
  files: [
    {
      fileName: "sales.csv",
      fileType: "csv",
      sizeBytes: 2048,
      headerRow: 1,
      detectedHeaderRow: 1,
      tableCount: 1,
      rowCount: 2,
      tables: [
        {
          tableName: "sales",
          displayName: "sales",
          sheetName: null,
          rowCount: 2,
          columns: [
            {
              name: "部门",
              originalName: "部门",
              type: "TEXT",
              nullable: false,
              sampleValues: ["华东"],
            },
            {
              name: "金额",
              originalName: "金额",
              type: "REAL",
              nullable: false,
              sampleValues: ["120.5"],
            },
          ],
          sampleRows: [
            ["华东", 120.5],
            ["华北", 80],
          ],
          warnings: [],
        },
      ],
    },
  ],
  totalTables: 1,
  totalRows: 2,
};

describe("FileUploadPanel", () => {
  it("triggers onAddFiles when selecting a file from the empty dropzone", async () => {
    const user = userEvent.setup();
    const onAddFiles = vi.fn();
    render(
      <FileUploadPanel
        files={[]}
        headerRows={[]}
        preview={null}
        previewLoading={false}
        previewError={null}
        onAddFiles={onAddFiles}
        onRemoveFile={vi.fn()}
        onHeaderRowChange={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );

    const file = new File(["a,b\n1,2"], "sales.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("选择 Excel 或 CSV 文件"), file);
    expect(onAddFiles).toHaveBeenCalledWith([file]);
  });

  it("renders parsed table preview, errors, remove and clear actions", async () => {
    const user = userEvent.setup();
    const onRemoveFile = vi.fn();
    const onClearAll = vi.fn();
    const file = new File(["部门,金额\n华东,120.5"], "sales.csv", { type: "text/csv" });

    render(
      <FileUploadPanel
        files={[file]}
        headerRows={[undefined]}
        preview={samplePreview}
        previewLoading={false}
        previewError="测试错误提示"
        onAddFiles={vi.fn()}
        onRemoveFile={onRemoveFile}
        onHeaderRowChange={vi.fn()}
        onClearAll={onClearAll}
      />,
    );

    expect(screen.getByText("sales.csv")).toBeInTheDocument();
    expect(screen.getByText("已选择 1 个文件")).toBeInTheDocument();
    expect(screen.getByText("表头：第 1 行")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "华东" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("测试错误提示");

    await user.click(screen.getByRole("button", { name: "移除文件 sales.csv" }));
    expect(onRemoveFile).toHaveBeenCalledWith(0);

    await user.click(screen.getByRole("button", { name: "清空" }));
    expect(onClearAll).toHaveBeenCalled();
  });
});
