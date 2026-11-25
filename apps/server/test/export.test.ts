import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "../src/services/artifacts.js";
import {
  csvStream,
  dedupeWorksheetNames,
  multiSheetXlsxStream,
  sanitizeExcelFilename,
  sanitizeWorksheetName,
  xlsxStream,
} from "../src/services/export.js";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

const columns: ColumnInfo[] = [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
  { name: "note", type: "string" },
  { name: "active", type: "boolean" },
  { name: "created", type: "date" },
];

describe("csvStream", () => {
  it("writes a BOM, escapes RFC4180 cells and normalizes null/Date/boolean", async () => {
    const date = new Date("2024-01-02T03:04:05.000Z");
    const rows = [
      [1, "a,b", 'he said "hi"', true, date],
      [2, "line\nbreak", null, false, null],
      [3, "plain", "cr\rlf", true, null],
    ];
    const output = (await collect(csvStream(columns, Readable.from(rows)))).toString("utf8");

    expect(output.startsWith("\uFEFFid,name,note,active,created\r\n")).toBe(true);
    expect(output).toContain('1,"a,b","he said ""hi""",true,2024-01-02T03:04:05.000Z\r\n');
    expect(output).toContain('2,"line\nbreak",,false,\r\n');
    expect(output).toContain('3,plain,"cr\rlf",true,\r\n');
    expect(output.trimEnd().split("\r\n")).toHaveLength(4);
  });

  it("neutralizes spreadsheet formula triggers in string cells", async () => {
    const rows = [
      [1, "=SUM(A1:A2)", "-1+cmd|' /C calc'!A0", true, null],
      [2, "+1", "@import", true, null],
      [3, "\tlead-tab", "\rlead-cr", true, null],
      [4, "-5.2", "plain", true, null],
    ];
    const output = (await collect(csvStream(columns, Readable.from(rows)))).toString("utf8");
    const lines = output.trimEnd().split("\r\n");

    expect(lines[1]).toBe("1,'=SUM(A1:A2),'-1+cmd|' /C calc'!A0,true,");
    expect(lines[2]).toBe("2,'+1,'@import,true,");
    expect(lines[3]).toBe(`3,'\tlead-tab,"'\rlead-cr",true,`);
    expect(lines[4]).toBe("4,'-5.2,plain,true,");
    // Typed numbers are untouched, so negative numbers stay numeric in the sheet.
    expect(output).toContain("1,");
    expect((await collect(csvStream(columns, Readable.from([[-1, "x", "y", true, null]]))))
      .toString("utf8")).toContain("\r\n-1,x,y,true,");
  });

  it("closes the row generator when the consumer destroys the stream", async () => {
    let closed = false;
    async function* rows(): AsyncGenerator<unknown[]> {
      try {
        for (let index = 0; index < 5_000; index += 1) {
          yield [index, "x".repeat(512), "note", true, null];
        }
      } finally {
        closed = true;
      }
    }

    const stream = csvStream(columns, rows());
    // A real client disconnect arrives outside the stream's own data callback.
    stream.once("data", () => setImmediate(() => stream.destroy()));
    await new Promise<void>((resolve) => stream.once("close", () => resolve()));
    // Readable.from destroys its iterator asynchronously, just after "close".
    await expect.poll(() => closed, { interval: 5, timeout: 1_000 }).toBe(true);
  });
});

describe("xlsxStream", () => {
  it("streams a workbook with a bold frozen header and typed cells", async () => {
    const rows = [
      [1, "12.5", "alice", true, new Date("2024-01-02T03:04:05.000Z")],
      [2, 7, null, false, null],
    ];
    const buffer = await collect(
      xlsxStream(
        [
          { name: "id", type: "number" },
          { name: "amount", type: "number" },
          { name: "name", type: "string" },
          { name: "active", type: "boolean" },
          { name: "when", type: "date" },
        ],
        Readable.from(rows),
      ),
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.getWorksheet("结果");
    expect(sheet).toBeDefined();
    if (!sheet) return;

    const header = sheet.getRow(1);
    expect(header.values).toEqual([undefined, "id", "amount", "name", "active", "when"]);
    expect(header.getCell(1).font?.bold).toBe(true);
    expect(sheet.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });

    const first = sheet.getRow(2);
    expect(first.getCell(1).value).toBe(1);
    expect(first.getCell(2).value).toBe(12.5);
    expect(first.getCell(3).value).toBe("alice");
    expect(first.getCell(4).value).toBe(true);
    expect(first.getCell(5).value).toBe("2024-01-02T03:04:05.000Z");

    const second = sheet.getRow(3);
    expect(second.getCell(1).value).toBe(2);
    expect(second.getCell(3).value).toBeNull();
    expect(second.getCell(4).value).toBe(false);
    expect(sheet.actualRowCount).toBe(3);

    for (const index of [1, 2, 3]) {
      const width = sheet.getColumn(index).width ?? 0;
      expect(width).toBeGreaterThanOrEqual(10);
      expect(width).toBeLessThanOrEqual(60);
    }
  });
});

describe("Excel naming helpers", () => {
  it("sanitizes filenames and strips redundant extensions", () => {
    expect(sanitizeExcelFilename("2025/Q1:销售分析?.xlsx")).toBe("2025-Q1-销售分析");
    expect(sanitizeExcelFilename("...  ---  ", "导出结果")).toBe("导出结果");
    expect(sanitizeExcelFilename("销售   明细  表.XLS")).toBe("销售 明细 表");
  });

  it("sanitizes and deduplicates worksheet names within 31 chars case-insensitively", () => {
    expect(sanitizeWorksheetName("[销售]:*?/\\明细'", "Sheet1")).toBe("销售_明细");
    expect(sanitizeWorksheetName("'   '", "Sheet1")).toBe("Sheet1");
    const longBase = "A".repeat(40);
    const deduped = dedupeWorksheetNames([longBase, longBase, "sales", "Sales", "总/表"]);
    expect(deduped[0]).toHaveLength(31);
    expect(deduped[1]).toHaveLength(31);
    expect(deduped[1]!.endsWith(" (2)")).toBe(true);
    expect(deduped[2]).toBe("sales");
    expect(deduped[3]).toBe("Sales (2)");
    expect(deduped[4]).toBe("总_表");
  });
});

describe("multiSheetXlsxStream", () => {
  it("streams multiple worksheets with frozen bold headers and typed cells", async () => {
    const buffer = await collect(
      multiSheetXlsxStream([
        {
          name: "区域汇总",
          columns: [
            { name: "region", type: "string" },
            { name: "amount", type: "number" },
          ],
          rows: Readable.from([
            ["华东", "120.5"],
            ["华南", 80],
          ]),
        },
        {
          name: "区域汇总",
          columns: [
            { name: "id", type: "number" },
            { name: "active", type: "boolean" },
          ],
          rows: Readable.from([[1, true]]),
        },
      ]),
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["区域汇总", "区域汇总 (2)"]);

    const s1 = workbook.getWorksheet("区域汇总")!;
    expect(s1.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(s1.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(s1.getRow(2).getCell(1).value).toBe("华东");
    expect(s1.getRow(2).getCell(2).value).toBe(120.5);
    expect(s1.actualRowCount).toBe(3);

    const s2 = workbook.getWorksheet("区域汇总 (2)")!;
    expect(s2.getRow(2).values).toEqual([undefined, 1, true]);
    expect(s2.actualRowCount).toBe(2);
  });

  it("closes all sheet row generators when the consumer destroys the stream early", async () => {
    let closedA = false;
    let closedB = false;
    async function* rowsA(): AsyncGenerator<unknown[]> {
      try {
        for (let i = 0; i < 5_000; i += 1) {
          yield [i, "x".repeat(256)];
        }
      } finally {
        closedA = true;
      }
    }
    async function* rowsB(): AsyncGenerator<unknown[]> {
      try {
        yield [1, "b"];
      } finally {
        closedB = true;
      }
    }

    const stream = multiSheetXlsxStream([
      { name: "Sheet1", columns: [{ name: "id", type: "number" }, { name: "note", type: "string" }], rows: rowsA() },
      { name: "Sheet2", columns: [{ name: "id", type: "number" }, { name: "note", type: "string" }], rows: rowsB() },
    ]);
    stream.once("data", () => setImmediate(() => stream.destroy()));
    await new Promise<void>((resolve) => stream.once("close", () => resolve()));
    await expect.poll(() => closedA && closedB, { interval: 5, timeout: 1_000 }).toBe(true);
  });
});
