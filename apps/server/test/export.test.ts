import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "../src/services/artifacts.js";
import { csvStream, xlsxStream } from "../src/services/export.js";

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
