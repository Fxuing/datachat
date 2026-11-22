import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";
import { FileUploadPanel } from "./FileUploadPanel";
import type { FileDatasetSummary, FilePreviewResponse } from "../../lib/api";

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

  it("lets the user select and confirm-delete a saved dataset", async () => {
    const user = userEvent.setup();
    const onSelectDataset = vi.fn();
    const onDeleteDataset = vi.fn();
    const saved: FileDatasetSummary = {
      id: "ds-1",
      name: "Q4 销售数据集",
      description: "已清洗的销售明细",
      fileType: "csv",
      fileCount: 1,
      tableCount: 1,
      rowCount: 2,
      sizeBytes: 2048,
      createdAt: 1,
      updatedAt: 1,
      tables: [
        {
          id: "t-1",
          datasetId: "ds-1",
          tableName: "sales",
          displayName: "sales",
          sheetName: null,
          rowCount: 2,
          columns: samplePreview.files[0]!.tables[0]!.columns,
          sampleRows: samplePreview.files[0]!.tables[0]!.sampleRows,
          warnings: [],
          createdAt: 1,
        },
      ],
    };

    const { rerender } = render(
      <FileUploadPanel
        files={[]}
        headerRows={[]}
        preview={null}
        previewLoading={false}
        previewError={null}
        savedDatasets={[saved]}
        selectedDatasetId={null}
        onAddFiles={vi.fn()}
        onRemoveFile={vi.fn()}
        onHeaderRowChange={vi.fn()}
        onClearAll={vi.fn()}
        onSelectDataset={onSelectDataset}
        onDeleteDataset={onDeleteDataset}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Q4 销售数据集/ }));
    expect(onSelectDataset).toHaveBeenCalledWith("ds-1");

    await user.click(screen.getByRole("button", { name: "删除数据集 Q4 销售数据集" }));
    const dialog = await screen.findByRole("dialog", { name: "删除数据集" });
    await user.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(onDeleteDataset).toHaveBeenCalledWith("ds-1");

    rerender(
      <FileUploadPanel
        files={[]}
        headerRows={[]}
        preview={null}
        previewLoading={false}
        previewError={null}
        savedDatasets={[saved]}
        selectedDatasetId="ds-1"
        onAddFiles={vi.fn()}
        onRemoveFile={vi.fn()}
        onHeaderRowChange={vi.fn()}
        onClearAll={vi.fn()}
        onSelectDataset={onSelectDataset}
        onDeleteDataset={onDeleteDataset}
      />,
    );

    expect(screen.getByText("已选用数据集：Q4 销售数据集")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "华东" })).toBeInTheDocument();
  });
});
