import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { artifacts } from "../db/schema.js";

export type ColumnType = "number" | "string" | "boolean" | "date" | "json" | "unknown";
export interface ColumnInfo {
  name: string;
  type: ColumnType;
}

export interface ArtifactMeta {
  id: string;
  rowCount: number;
  truncated: boolean;
}

export interface ArtifactRecord extends ArtifactMeta {
  conversationId: string | null;
  userId: string | null;
  runId: string | null;
  columns: ColumnInfo[];
  storagePath: string;
  createdAt: number;
}

export interface ArtifactListInput {
  conversationId?: string;
  runId?: string;
  userId?: string;
  limit?: number;
}

export interface ArtifactStoreOptions {
  finalizeTimeoutMs?: number;
  abortTimeoutMs?: number;
}

const DEFAULT_FINALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

const DECIMAL_KEYS = new Set(["$type", "value"]);

/**
 * JSON.stringify is lossy (or throws) for driver-specific values. Encode them as
 * tagged objects so artifact files round-trip: BigInt, Date, Buffer, Decimal,
 * plus non-finite numbers.
 */
export function encodeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "bigint":
      return { $type: "bigint", value: value.toString() };
    case "number":
      return Number.isFinite(value) ? value : { $type: "number", value: String(value) };
    case "string":
    case "boolean":
      return value;
    case "object":
      break;
    default:
      return String(value);
  }

  if (value instanceof Date) return { $type: "date", value: value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $type: "buffer", value: Buffer.from(value).toString("base64") };
  }
  if (isDecimalLike(value)) return { $type: "decimal", value: value.toString() };
  if (Array.isArray(value)) return value.map((item) => encodeValue(item));
  const encoded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) encoded[key] = encodeValue(item);
  return encoded;
}

export function encodeRow(row: unknown[]): unknown[] {
  return row.map((value) => encodeValue(value));
}

export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => decodeValue(item));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 2 && keys.every((key) => DECIMAL_KEYS.has(key)) && typeof record.$type === "string") {
    switch (record.$type) {
      case "bigint":
        return BigInt(String(record.value));
      case "date":
        return new Date(String(record.value));
      case "buffer":
        return Buffer.from(String(record.value), "base64");
      case "decimal":
        return String(record.value);
      case "number":
        return Number(record.value);
      default:
        break;
    }
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) decoded[key] = decodeValue(item);
  return decoded;
}

export function decodeRow(row: unknown[]): unknown[] {
  return row.map((value) => decodeValue(value));
}

export class ResultWriter {
  readonly id = randomUUID();
  private readonly filePath: string;
  private readonly gzip = createGzip({ level: 6 });
  private readonly out: ReturnType<typeof createWriteStream>;
  private closed = false;
  private finalized = false;
  private doneCalled = false;
  private failure: Error | null = null;

  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly input: {
      userId: string;
      conversationId: string | null;
      runId: string | null;
    },
    private readonly onDone?: () => void,
    private readonly timeouts: { finalizeMs: number; abortMs: number } = {
      finalizeMs: DEFAULT_FINALIZE_TIMEOUT_MS,
      abortMs: DEFAULT_ABORT_TIMEOUT_MS,
    },
  ) {
    this.filePath = path.join(dir, `${this.id}.jsonl.gz`);
    this.out = createWriteStream(this.filePath);
    this.gzip.pipe(this.out);
    this.gzip.on("error", (error: Error) => {
      this.failure = error;
    });
    this.out.on("error", (error: Error) => {
      this.failure = error;
    });
  }

  async write(row: unknown[]): Promise<void> {
    if (this.closed) throw new Error("artifact writer closed");
    if (this.failure) throw this.failure;
    const line = JSON.stringify(encodeRow(row)) + "\n";
    if (!this.gzip.write(line)) await this.waitForDrain();
  }

  async finish(input: { columns: ColumnInfo[]; rowCount: number; truncated: boolean }): Promise<ArtifactMeta> {
    if (this.closed) throw new Error("artifact writer closed");
    this.closed = true;
    try {
      if (this.failure) throw this.failure;
      await this.waitForFinish();
      this.db
        .insert(artifacts)
        .values({
          id: this.id,
          conversationId: this.input.conversationId,
          userId: this.input.userId,
          runId: this.input.runId,
          kind: "result",
          storagePath: path.relative(this.dir, this.filePath),
          columnsJson: JSON.stringify(input.columns),
          rowCount: input.rowCount,
          truncated: input.truncated ? 1 : 0,
          specJson: null,
          createdAt: Date.now(),
        })
        .run();
      this.finalized = true;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      await this.destroyStreams();
      await rm(this.filePath, { force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
      throw this.failure;
    } finally {
      // Keep the writer tracked by the store until finalize actually settles.
      this.notifyDone();
    }
    return { id: this.id, rowCount: input.rowCount, truncated: input.truncated };
  }

  async abort(): Promise<void> {
    // A writer that already inserted its row is immutable: deleting the file now
    // would leave a dangling artifact record behind.
    if (this.finalized) return;
    if (!this.closed) {
      this.closed = true;
      this.notifyDone();
    }
    await this.destroyStreams();
    await rm(this.filePath, { force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  }

  private notifyDone(): void {
    if (this.doneCalled) return;
    this.doneCalled = true;
    this.onDone?.();
  }

  private async destroyStreams(): Promise<void> {
    this.gzip.destroy();
    this.out.destroy();
    if (this.out.closed) return;
    await new Promise<void>((resolve) => {
      const onClose = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.out.off("close", onClose);
        resolve();
      }, this.timeouts.abortMs);
      timer.unref();
      this.out.once("close", onClose);
    });
  }

  private async waitForFinish(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("artifact finalize timed out"));
      }, this.timeouts.finalizeMs);
      timer.unref();
      const onFinish = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.out.off("finish", onFinish);
        this.out.off("error", onError);
        this.gzip.off("error", onError);
      };
      this.out.once("finish", onFinish);
      this.out.once("error", onError);
      this.gzip.once("error", onError);
      this.gzip.end();
    });
  }

  private async waitForDrain(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("artifact write timed out"));
      }, this.timeouts.finalizeMs);
      timer.unref();
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.gzip.off("drain", onDrain);
        this.gzip.off("error", onError);
        this.out.off("error", onError);
      };
      this.gzip.once("drain", onDrain);
      this.gzip.once("error", onError);
      this.out.once("error", onError);
    });
  }
}

export class ArtifactStore {
  private readonly writers = new Set<ResultWriter>();
  private readonly timeouts: { finalizeMs: number; abortMs: number };

  constructor(
    private readonly db: Db,
    private readonly rootDir: string,
    options: ArtifactStoreOptions = {},
  ) {
    this.timeouts = {
      finalizeMs: options.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS,
      abortMs: options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
    };
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  openResult(input: {
    userId: string;
    conversationId?: string | null;
    runId: string | null;
  }): ResultWriter {
    let writer: ResultWriter;
    writer = new ResultWriter(
      this.db,
      this.rootDir,
      {
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        runId: input.runId,
      },
      () => this.writers.delete(writer),
      this.timeouts,
    );
    this.writers.add(writer);
    return writer;
  }

  get(id: string): ArtifactRecord | null {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return row ? toRecord(row) : null;
  }

  getForUser(id: string, userId: string): ArtifactRecord | null {
    const row = this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
      .get();
    return row ? toRecord(row) : null;
  }

  list(input: ArtifactListInput = {}): ArtifactRecord[] {
    const rows = this.db
      .select()
      .from(artifacts)
      .where(
        and(
          input.conversationId ? eq(artifacts.conversationId, input.conversationId) : undefined,
          input.runId ? eq(artifacts.runId, input.runId) : undefined,
          input.userId ? eq(artifacts.userId, input.userId) : undefined,
        ),
      )
      .orderBy(desc(artifacts.createdAt))
      .limit(input.limit ?? 100)
      .all();
    return rows.map(toRecord);
  }

  async read(id: string): Promise<{ meta: ArtifactRecord; rows: unknown[][] } | null> {
    const meta = this.get(id);
    if (!meta || !meta.storagePath) return null;
    const rows: unknown[][] = [];
    const stream = createReadStream(this.resolvePath(meta.storagePath)).pipe(createGunzip());
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line) rows.push(decodeRow(JSON.parse(line) as unknown[]));
    }
    return { meta, rows };
  }

  async delete(id: string): Promise<boolean> {
    const meta = this.get(id);
    if (!meta) return false;
    await this.removeRecord(meta);
    return true;
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const meta = this.getForUser(id, userId);
    if (!meta) return false;
    await this.removeRecord(meta);
    return true;
  }

  private async removeRecord(meta: ArtifactRecord): Promise<void> {
    if (meta.storagePath) await rm(this.resolvePath(meta.storagePath), { force: true });
    this.db.delete(artifacts).where(eq(artifacts.id, meta.id)).run();
  }

  async close(): Promise<void> {
    const writers = [...this.writers];
    this.writers.clear();
    await Promise.all(writers.map((writer) => writer.abort().catch(() => undefined)));
  }

  private resolvePath(storagePath: string): string {
    const root = path.resolve(this.rootDir);
    const resolved = path.resolve(root, storagePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("artifact path escapes storage root");
    }
    return resolved;
  }
}

function isDecimalLike(value: object): boolean {
  const candidate = value as { toFixed?: unknown; toNumber?: unknown; constructor?: { name?: string } };
  const name = candidate.constructor?.name ?? "";
  return (
    typeof candidate.toFixed === "function" &&
    (name.includes("Decimal") || typeof candidate.toNumber === "function")
  );
}

function toRecord(row: typeof artifacts.$inferSelect): ArtifactRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    runId: row.runId,
    rowCount: row.rowCount,
    truncated: row.truncated === 1,
    columns: row.columnsJson ? (JSON.parse(row.columnsJson) as ColumnInfo[]) : [],
    storagePath: row.storagePath ?? "",
    createdAt: row.createdAt,
  };
}
