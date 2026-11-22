import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  resolveConversationSqlitePath,
  resolveDatasetSqlitePath,
} from "../src/services/file-store.js";
import { testConfig } from "./helpers/config.js";

function encodeMultipart(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType?: string; content: Buffer | string }
  >,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----DataChatTest${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ("filename" in part) {
      const content =
        typeof part.content === "string" ? Buffer.from(part.content, "utf8") : part.content;
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`,
          "utf8",
        ),
        content,
        Buffer.from("\r\n", "utf8"),
      );
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          "utf8",
        ),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

let tmpDir: string;
let db: Db;
let closeDb: () => void;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let otherCookie: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-datasets-test-"));
  const handle = createDb(path.join(tmpDir, "app.db"));
  db = handle.db;
  closeDb = () => handle.sqlite.close();
  migrateDb(db);

  const hash = await hashPassword("secret");
  const now = Date.now();
  const owner = insertUser(db, {
    id: randomUUID(),
    username: "alice",
    passwordHash: hash,
    role: "user",
    createdAt: now,
  });
  const other = insertUser(db, {
    id: randomUUID(),
    username: "bob",
    passwordHash: hash,
    role: "user",
    createdAt: now,
  });

  const signer = createSessionSigner(testConfig.appSecret);
  cookie = await signer.sign({ sub: owner.id, username: owner.username, role: owner.role });
  otherCookie = await signer.sign({ sub: other.id, username: other.username, role: other.role });

  const fakeRuntime = {
    isBusy: vi.fn(() => false),
    remove: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  } as unknown as RuntimeManager;

  app = await buildApp({
    config: { ...testConfig, dataDir: tmpDir },
    db,
    enableRateLimit: false,
    agentRuntime: fakeRuntime,
  });
});

afterEach(async () => {
  await app.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("file datasets api", () => {
  it("saves a file conversation as a dataset, clones it into a new conversation, and enforces ownership", async () => {
    const csv = "region,amount\n华东,120\n华北,280\n";
    const upload = encodeMultipart([
      { name: "files", filename: "sales.csv", contentType: "text/csv", content: csv },
    ]);

    const createdConvRes = await app.inject({
      method: "POST",
      url: "/api/conversations/file",
      cookies: { dc_session: cookie },
      headers: upload.headers,
      payload: upload.payload,
    });
    expect(createdConvRes.statusCode).toBe(201);
    const convId = (createdConvRes.json() as { conversation: { id: string } }).conversation.id;

    // Foreign user cannot save another user's conversation.
    const foreignSave = await app.inject({
      method: "POST",
      url: `/api/file-datasets/from-conversation/${convId}`,
      cookies: { dc_session: otherCookie },
      payload: { name: "窃取数据集" },
    });
    expect(foreignSave.statusCode).toBe(404);

    // Owner saves the file conversation as a reusable dataset.
    const savedRes = await app.inject({
      method: "POST",
      url: `/api/file-datasets/from-conversation/${convId}`,
      cookies: { dc_session: cookie },
      payload: { name: "区域销售样本", description: "Q4 测试集" },
    });
    expect(savedRes.statusCode).toBe(201);
    const dataset = (
      savedRes.json() as {
        dataset: {
          id: string;
          name: string;
          description: string | null;
          tableCount: number;
          rowCount: number;
          tables: Array<{ tableName: string; rowCount: number }>;
        };
      }
    ).dataset;
    expect(dataset.name).toBe("区域销售样本");
    expect(dataset.description).toBe("Q4 测试集");
    expect(dataset.tableCount).toBe(1);
    expect(dataset.rowCount).toBe(2);
    expect(dataset.tables[0]?.tableName).toBe("sales");
    expect(fs.existsSync(resolveDatasetSqlitePath(tmpDir, dataset.id))).toBe(true);

    // Lists datasets for owner only.
    const ownerList = await app.inject({
      method: "GET",
      url: "/api/file-datasets",
      cookies: { dc_session: cookie },
    });
    expect(ownerList.statusCode).toBe(200);
    expect((ownerList.json() as { datasets: unknown[] }).datasets).toHaveLength(1);

    const otherList = await app.inject({
      method: "GET",
      url: "/api/file-datasets",
      cookies: { dc_session: otherCookie },
    });
    expect(otherList.statusCode).toBe(200);
    expect((otherList.json() as { datasets: unknown[] }).datasets).toHaveLength(0);

    // Foreign user cannot clone from owner's dataset.
    const foreignClone = await app.inject({
      method: "POST",
      url: "/api/conversations/from-dataset",
      cookies: { dc_session: otherCookie },
      payload: { datasetId: dataset.id },
    });
    expect(foreignClone.statusCode).toBe(404);

    // Owner starts a brand-new conversation from the saved dataset.
    const clonedRes = await app.inject({
      method: "POST",
      url: "/api/conversations/from-dataset",
      cookies: { dc_session: cookie },
      payload: { datasetId: dataset.id },
    });
    expect(clonedRes.statusCode).toBe(201);
    const cloned = clonedRes.json() as {
      conversation: { id: string; sourceKind: string };
      files: Array<{ fileName: string }>;
      tables: Array<{ tableName: string; rowCount: number }>;
    };
    expect(cloned.conversation.id).not.toBe(convId);
    expect(cloned.conversation.sourceKind).toBe("file");
    expect(cloned.files[0]?.fileName).toContain("区域销售样本");
    expect(cloned.tables[0]).toMatchObject({ tableName: "sales", rowCount: 2 });
    expect(fs.existsSync(resolveConversationSqlitePath(tmpDir, cloned.conversation.id))).toBe(true);

    // Rename dataset and delete it; cloned conversation sqlite remains intact.
    const renamedRes = await app.inject({
      method: "PATCH",
      url: `/api/file-datasets/${dataset.id}`,
      cookies: { dc_session: cookie },
      payload: { name: "区域销售 V2" },
    });
    expect(renamedRes.statusCode).toBe(200);
    expect((renamedRes.json() as { dataset: { name: string } }).dataset.name).toBe("区域销售 V2");

    const deletedRes = await app.inject({
      method: "DELETE",
      url: `/api/file-datasets/${dataset.id}`,
      cookies: { dc_session: cookie },
    });
    expect(deletedRes.statusCode).toBe(204);
    expect(fs.existsSync(resolveDatasetSqlitePath(tmpDir, dataset.id))).toBe(false);
    expect(fs.existsSync(resolveConversationSqlitePath(tmpDir, cloned.conversation.id))).toBe(true);
  });
});
