import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  FILE_MAX_SIZE_BYTES,
  FileImportError,
  parseUploadedFiles,
} from "../src/services/file-import.js";

async function makeXlsxBuffer(
  build: (workbook: ExcelJS.Workbook) => void,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const raw = await workbook.xlsx.writeBuffer();
  return Buffer.from(raw);
}

/** Encode ASCII + GBK Chinese strings (minimal lookup for test strings). */
function encodeGbkMock(bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe("parseUploadedFiles", () => {
  it("parses UTF-8 BOM CSV with quoted newlines and infers clean types", async () => {
    const csv = [
      "\uFEFF工号,身份证号,姓名,部门,下单日期,销售额,折扣率,备注",
      '00123,110101199001011234,张三,销售部,2026-08-01,"¥1,234.50",12.5%,"第一行\n第二行"',
      "00456,110101199202025678,李四,运营部,2026/8/2,¥200,5%,普通备注",
    ].join("\r\n");

    const result = await parseUploadedFiles([
      { fileName: "8月订单明细.csv", buffer: Buffer.from(csv, "utf8") },
    ]);

    expect(result.totalTables).toBe(1);
    expect(result.totalRows).toBe(2);
    const table = result.allTables[0]!;
    expect(table.tableName).toBe("t_8月订单明细");
    expect(table.columns).toEqual([
      {
        name: "工号",
        originalName: "工号",
        type: "TEXT",
        nullable: false,
        sampleValues: ["00123", "00456"],
      },
      {
        name: "身份证号",
        originalName: "身份证号",
        type: "TEXT",
        nullable: false,
        sampleValues: ["110101199001011234", "110101199202025678"],
      },
      {
        name: "姓名",
        originalName: "姓名",
        type: "TEXT",
        nullable: false,
        sampleValues: ["张三", "李四"],
      },
      {
        name: "部门",
        originalName: "部门",
        type: "TEXT",
        nullable: false,
        sampleValues: ["销售部", "运营部"],
      },
      {
        name: "下单日期",
        originalName: "下单日期",
        type: "DATE",
        nullable: false,
        sampleValues: ["2026-08-01", "2026-08-02"],
      },
      {
        name: "销售额",
        originalName: "销售额",
        type: "REAL",
        nullable: false,
        formatHint: "currency",
        sampleValues: ["1234.5", "200"],
      },
      {
        name: "折扣率",
        originalName: "折扣率",
        type: "REAL",
        nullable: false,
        formatHint: "percent",
        sampleValues: ["0.125", "0.05"],
      },
      {
        name: "备注",
        originalName: "备注",
        type: "TEXT",
        nullable: false,
        sampleValues: ["第一行\n第二行", "普通备注"],
      },
    ]);
    expect(table.rows).toEqual([
      ["00123", "110101199001011234", "张三", "销售部", "2026-08-01", 1234.5, 0.125, "第一行\n第二行"],
      ["00456", "110101199202025678", "李四", "运营部", "2026-08-02", 200, 0.05, "普通备注"],
    ]);
  });

  it("falls back to GB18030 decoding for legacy Chinese CSV exports", async () => {
    // GB18030 for: 测试,金额\n部门,100
    const buf = encodeGbkMock([
      0xb2, 0xe2, 0xca, 0xd4, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a,
      0xb2, 0xbf, 0xc3, 0xc5, 0x2c, 0x31, 0x30, 0x30,
    ]);
    const result = await parseUploadedFiles([{ fileName: "gbk.csv", buffer: buf }]);
    const table = result.allTables[0]!;
    expect(table.columns.map((c) => c.name)).toEqual(["测试", "金额"]);
    expect(table.columns[1]?.type).toBe("INTEGER");
    expect(table.rows).toEqual([["部门", 100]]);
  });

  it("supports semicolon CSV delimiters and preserves mixed columns as TEXT without losing values", async () => {
    const csv = "code;qty\nA01;10\nA02;暂无";
    const result = await parseUploadedFiles([{ fileName: "mixed.csv", buffer: Buffer.from(csv) }]);
    const table = result.allTables[0]!;
    expect(table.columns.map((c) => c.type)).toEqual(["TEXT", "TEXT"]);
    expect(table.rows).toEqual([
      ["A01", "10"],
      ["A02", "暂无"],
    ]);
  });

  it("handles XLSX merged title banners, merged data cells, formulas, UTC dates, hidden sheets, and manual headerRow", async () => {
    const buffer = await makeXlsxBuffer((wb) => {
      const hidden = wb.addWorksheet("隐藏表", { state: "hidden" });
      hidden.addRow(["a", "b"]);
      hidden.addRow([1, 2]);

      const sheet = wb.addWorksheet("销售台账");
      sheet.addRow(["2026年8月销售汇总表"]);
      sheet.mergeCells("A1:E1");
      sheet.addRow([]);
      sheet.addRow(["部门", "日期", "单价", "数量", "总额"]);
      sheet.addRow(["华东", new Date(Date.UTC(2026, 7, 15, 0, 0, 0)), 10, 2, { formula: "C4*D4", result: 20 }]);
      sheet.addRow(["华东", new Date(Date.UTC(2026, 7, 16, 14, 30, 0)), 15, 3, { error: "#DIV/0!" }]);
      sheet.mergeCells("A4:A5");
    });

    const autoParsed = await parseUploadedFiles([{ fileName: "台账.xlsx", buffer }]);
    expect(autoParsed.totalTables).toBe(1);
    const table = autoParsed.allTables[0]!;
    expect(autoParsed.files[0]!.detectedHeaderRow).toBe(3);
    expect(autoParsed.files[0]!.headerRow).toBe(3);
    expect(table.tableName).toBe("销售台账");
    expect(table.columns.map((c) => c.type)).toEqual([
      "TEXT",
      "DATETIME",
      "INTEGER",
      "INTEGER",
      "INTEGER",
    ]);
    expect(table.rows).toEqual([
      ["华东", "2026-08-15 00:00:00", 10, 2, 20],
      ["华东", "2026-08-16 14:30:00", 15, 3, null],
    ]);
    expect(table.warnings.join(" ")).toContain("合并单元格");
    expect(table.warnings.join(" ")).toContain("公式错误");

    // Manual override to row 4 parses row 4 as header and row 5 as data
    const manualParsed = await parseUploadedFiles([
      { fileName: "台账.xlsx", buffer, headerRow: 4 },
    ]);
    expect(manualParsed.files[0]!.headerRow).toBe(4);
    expect(manualParsed.allTables[0]!.rowCount).toBe(1);
  });

  it("sanitizes duplicate/reserved identifiers and deduplicates against existing conversation tables", async () => {
    const csv = "sqlite_id,金额,金额,,col-5\n1,10,20,a,b";
    const result = await parseUploadedFiles(
      [{ fileName: "sales.csv", buffer: Buffer.from(csv) }],
      { existingTableNames: ["sales"], existingTableCount: 1, existingRowCount: 5 },
    );
    const table = result.allTables[0]!;
    expect(table.tableName).toBe("sales_2");
    expect(table.columns.map((c) => c.name)).toEqual([
      "c_sqlite_id",
      "金额",
      "金额_2",
      "col_4",
      "col_5",
    ]);
    expect(table.columns[2]?.originalName).toBe("金额");
  });

  it("rejects .xls, empty files, oversized buffers, and conversation limits", async () => {
    await expect(
      parseUploadedFiles([{ fileName: "old.xls", buffer: Buffer.from("abc") }]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });

    await expect(
      parseUploadedFiles([{ fileName: "empty.csv", buffer: Buffer.alloc(0) }]),
    ).rejects.toMatchObject({ code: "EMPTY_FILE" });

    await expect(
      parseUploadedFiles([
        { fileName: "huge.csv", buffer: Buffer.alloc(FILE_MAX_SIZE_BYTES + 1, 97) },
      ]),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE", statusCode: 413 });

    const smallCsv = Buffer.from("a,b\n1,2");
    await expect(
      parseUploadedFiles(
        Array.from({ length: 6 }, (_, i) => ({ fileName: `f${i}.csv`, buffer: smallCsv })),
      ),
    ).rejects.toMatchObject({ code: "TOO_MANY_FILES" });

    await expect(
      parseUploadedFiles([{ fileName: "f.csv", buffer: smallCsv }], {
        existingTableCount: 10,
      }),
    ).rejects.toBeInstanceOf(FileImportError);

    await expect(
      parseUploadedFiles([{ fileName: "f.csv", buffer: smallCsv }], {
        existingRowCount: 200_000,
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_ROWS" });
  });
});
