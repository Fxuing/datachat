import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { ArtifactStore, decodeValue } from "../src/services/artifacts.js";

let root: string;
let handle: DbHandle;
let store: ArtifactStore;
const USER = "user-1";
const OTHER = "user-2";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-artifacts-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  store = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await store.init();
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ArtifactStore", () => {
  it("writes gzipped JSONL rows and records metadata", async () => {
    const writer = store.openResult({ userId: USER, conversationId: "c1", runId: "r1" });
    await writer.write([1, "a"]);
    await writer.write([2, null]);
    const meta = await writer.finish({
      columns: [
        { name: "id", type: "number" },
        { name: "name", type: "string" },
      ],
      rowCount: 2,
      truncated: false,
    });

    expect(meta.rowCount).toBe(2);
    const file = path.join(root, "artifacts", `${meta.id}.jsonl.gz`);
    expect(gunzipSync(fs.readFileSync(file)).toString()).toBe('[1,"a"]\n[2,null]\n');

    const record = store.get(meta.id);
    expect(record?.id).toBe(meta.id);
    expect(record?.rowCount).toBe(2);
    expect(record?.columns.map((column) => column.name)).toEqual(["id", "name"]);

    const read = await store.read(meta.id);
    expect(read?.rows).toEqual([
      [1, "a"],
      [2, null],
    ]);
  });

  it("round-trips BigInt, Date, Buffer, Decimal and non-finite numbers without loss", async () => {
    class FakeDecimal {
      constructor(private readonly value: string) {}
      toFixed(): string {
        return this.value;
      }
      toNumber(): number {
        return Number(this.value);
      }
      toString(): string {
        return this.value;
      }
    }

    const date = new Date("2024-01-02T03:04:05.006Z");
    const buffer = Buffer.from([1, 2, 3]);
    const writer = store.openResult({ userId: USER, conversationId: "c1", runId: null });
    await writer.write([1n, date, buffer, new FakeDecimal("12.34"), Number.NaN]);
    const meta = await writer.finish({ columns: [], rowCount: 1, truncated: false });

    const raw = gunzipSync(
      fs.readFileSync(path.join(root, "artifacts", `${meta.id}.jsonl.gz`)),
    ).toString();
    expect(JSON.parse(raw.trim())).toEqual([
      { $type: "bigint", value: "1" },
      { $type: "date", value: "2024-01-02T03:04:05.006Z" },
      { $type: "buffer", value: "AQID" },
      { $type: "decimal", value: "12.34" },
      { $type: "number", value: "NaN" },
    ]);

    const read = await store.read(meta.id);
    expect(read?.rows).toHaveLength(1);
    const row = read?.rows[0] ?? [];
    expect(row[0]).toBe(1n);
    expect(row[1]).toEqual(date);
    expect(Buffer.isBuffer(row[2])).toBe(true);
    expect(Buffer.from(row[2] as Buffer)).toEqual(buffer);
    expect(row[3]).toBe("12.34");
    expect(Number.isNaN(row[4])).toBe(true);
  });

  it("lists, filters and deletes artifacts", async () => {
    const first = store.openResult({ userId: USER, conversationId: "c1", runId: "r1" });
    await first.write([1]);
    const firstMeta = await first.finish({ columns: [], rowCount: 1, truncated: false });

    const second = store.openResult({ userId: USER, conversationId: "c2", runId: "r2" });
    await second.write([2]);
    const secondMeta = await second.finish({ columns: [], rowCount: 1, truncated: true });

    expect(store.list().map((item) => item.id)).toEqual(
      expect.arrayContaining([firstMeta.id, secondMeta.id]),
    );
    expect(store.list({ conversationId: "c1" }).map((item) => item.id)).toEqual([firstMeta.id]);
    expect(store.list({ runId: "r2" }).map((item) => item.id)).toEqual([secondMeta.id]);

    const file = path.join(root, "artifacts", `${firstMeta.id}.jsonl.gz`);
    expect(fs.existsSync(file)).toBe(true);
    await expect(store.delete(firstMeta.id)).resolves.toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.get(firstMeta.id)).toBeNull();
    await expect(store.delete(firstMeta.id)).resolves.toBe(false);
  });

  it("abort removes the partial file and leaves no artifact row", async () => {
    const writer = store.openResult({ userId: USER, conversationId: "c1", runId: null });
    await writer.write([1]);
    await writer.abort();

    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(path.join(root, "artifacts"))).toEqual([]);
    await expect(writer.write([2])).rejects.toThrow(/closed/);
  });

  it("rejects artifact paths that escape the storage root", async () => {
    const writer = store.openResult({ userId: USER, conversationId: "c1", runId: null });
    await writer.write([1]);
    const meta = await writer.finish({ columns: [], rowCount: 1, truncated: false });
    handle.sqlite
      .prepare("UPDATE artifacts SET storage_path = ? WHERE id = ?")
      .run("../escape.jsonl.gz", meta.id);
    await expect(store.read(meta.id)).rejects.toThrow(/escapes storage root/);
  });

  it("scopes artifacts to their owner and never aborts a finalized file", async () => {
    const writer = store.openResult({ userId: USER, conversationId: "c1", runId: null });
    await writer.write([1]);
    const meta = await writer.finish({ columns: [], rowCount: 1, truncated: false });

    const record = store.get(meta.id);
    expect(record?.userId).toBe(USER);
    expect(record?.conversationId).toBe("c1");
    expect(store.getForUser(meta.id, OTHER)).toBeNull();
    expect(store.getForUser(meta.id, USER)?.id).toBe(meta.id);

    const file = path.join(root, "artifacts", `${meta.id}.jsonl.gz`);
    await writer.abort();
    expect(fs.existsSync(file)).toBe(true);
    expect(store.get(meta.id)?.id).toBe(meta.id);

    await expect(store.deleteForUser(meta.id, OTHER)).resolves.toBe(false);
    await expect(store.deleteForUser(meta.id, USER)).resolves.toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("times out a stuck finalize instead of hanging", async () => {
    const timed = new ArtifactStore(handle.db, path.join(root, "artifacts"), {
      finalizeTimeoutMs: 20,
      abortTimeoutMs: 20,
    });
    await timed.init();
    const writer = timed.openResult({ userId: USER, conversationId: null, runId: null });
    await writer.write([1]);
    // Simulate an output stream that never emits "finish".
    (writer as unknown as { gzip: { end: () => void } }).gzip.end = () => undefined;
    await expect(writer.finish({ columns: [], rowCount: 1, truncated: false })).rejects.toThrow(
      /timed out/,
    );
    expect(timed.list()).toEqual([]);
  });

  it("surfaces output-stream errors instead of waiting for a drain that never comes", async () => {
    const writer = store.openResult({ userId: USER, conversationId: null, runId: null });
    (writer as unknown as { out: { emit: (event: string, error: Error) => void } }).out.emit(
      "error",
      new Error("disk full"),
    );
    await expect(writer.write([1])).rejects.toThrow(/disk full/);
    await writer.abort();
  });

  it("decodes plain values unchanged", () => {
    expect(decodeValue("x")).toBe("x");
    expect(decodeValue(3)).toBe(3);
    expect(decodeValue({ a: [1, true, null] })).toEqual({ a: [1, true, null] });
  });
});
