import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXCEL_MAX_SHEETS } from "@datachat/shared";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { createRole, setUserRoles } from "../src/db/repositories/roles.js";
import { createRun } from "../src/db/repositories/runs.js";
import { insertUser } from "../src/db/repositories/users.js";
import { ArtifactStore, type ColumnInfo } from "../src/services/artifacts.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { buildAgentTools } from "../src/agent/tools/index.js";
import { createExcelTool, type CreateExcelDetails } from "../src/agent/tools/create-excel.js";
import type { AgentToolContext } from "../src/agent/tools/context.js";
import { testConfig as config } from "./helpers/config.js";

let root: string;
let handle: DbHandle;
let artifacts: ArtifactStore;
let conversationId: string;
let otherConversationId: string;
let scopedDatasourceId: string;
let userId: string;
let noExportUserId: string;
let otherUserId: string;

const columns: ColumnInfo[] = [
  { name: "region", type: "string" },
  { name: "amount", type: "number" },
];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-create-excel-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  artifacts = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await artifacts.init();

  userId = "u1";
  noExportUserId = "u-no-export";
  otherUserId = "u2";
  const now = Date.now();
  for (const id of [userId, noExportUserId, otherUserId]) {
    insertUser(handle.db, {
      id,
      username: id,
      passwordHash: "hash",
      role: "user",
      createdAt: now,
    });
  }
  const memberRole = createRole(handle.db, {
    name: "exporter",
    permissions: ["chat.use", "export.data"],
  });
  setUserRoles(handle.db, userId, [memberRole.id]);
  setUserRoles(handle.db, otherUserId, [memberRole.id]);

  const restrictedRole = createRole(handle.db, {
    name: "viewer-only",
    permissions: ["chat.use"],
  });
  setUserRoles(handle.db, noExportUserId, [restrictedRole.id]);

  scopedDatasourceId = "ds-scoped";
  insertDatasource(handle.db, {
    id: scopedDatasourceId,
    name: "scoped",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "scoped",
    username: "scoped",
    passwordCipher: "cipher",
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    dataScopeMode: "enabled",
  });

  conversationId = createConversation(handle.db, {
    userId,
    sourceKind: "file",
    datasourceId: null,
  }).id;
  otherConversationId = createConversation(handle.db, {
    userId,
    sourceKind: "file",
    datasourceId: null,
  }).id;
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    db: handle.db,
    config,
    pools: {} as PoolRegistry,
    artifacts,
    userId,
    conversationId,
    datasourceId: null,
    sourceKind: "file",
    runId: "r-current",
    skillsDir: path.join(root, "skills"),
    ...overrides,
  };
}

async function seedResult(
  rows: unknown[][],
  options: {
    owner?: string;
    conversation?: string;
    runId?: string | null;
    rowCount?: number;
  } = {},
): Promise<string> {
  const writer = artifacts.openResult({
    userId: options.owner ?? userId,
    conversationId: options.conversation ?? conversationId,
    runId: options.runId === undefined ? null : options.runId,
  });
  for (const row of rows) await writer.write(row);
  const meta = await writer.finish({
    columns,
    rowCount: options.rowCount ?? rows.length,
    truncated: false,
  });
  return meta.id;
}

function detailsOf(result: unknown): CreateExcelDetails {
  return (result as { details: CreateExcelDetails }).details;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function run(
  params: { filename: string; sheets: Array<{ name: string; artifactId: string }> },
  ctx: AgentToolContext = context(),
) {
  return createExcelTool(ctx).execute("call-1", params, undefined, undefined, ctx as never);
}

describe("create_excel", () => {
  it("creates a multi-sheet excel workbook artifact with sanitized filename and unique sheet names", async () => {
    const a1 = await seedResult([
      ["华东", 120],
      ["华南", 80],
    ]);
    const a2 = await seedResult([["总计", 200]]);

    const result = await run({
      filename: "2025/Q1:销售分析.xlsx",
      sheets: [
        { name: "区域/汇总:长名称超出三十一个字符会被自动截断保证合法性", artifactId: a1 },
        { name: "区域/汇总:长名称超出三十一个字符会被自动截断保证合法性", artifactId: a2 },
      ],
    });

    expect(result.isError).toBeFalsy();
    const details = detailsOf(result);
    expect(details.filename).toBe("2025-Q1-销售分析");
    expect(details.totalRows).toBe(3);
    expect(details.sheets).toHaveLength(2);
    expect(details.sheets[0]!.name).not.toBe(details.sheets[1]!.name);
    expect(details.sheets[0]!.name.length).toBeLessThanOrEqual(31);
    expect(details.sheets[1]!.name.length).toBeLessThanOrEqual(31);

    const stored = artifacts.get(details.excelArtifactId);
    expect(stored?.kind).toBe("excel");
    expect(stored?.storagePath).toBe("");
    expect(stored?.rowCount).toBe(3);
    expect(stored?.runId).toBe("r-current");
    expect((await artifacts.read(details.excelArtifactId))?.rows).toEqual([]);

    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      excelArtifactId: details.excelArtifactId,
      filename: "2025-Q1-销售分析.xlsx",
      totalRows: 3,
      placeholder: `[[excel:${details.excelArtifactId}]]`,
    });
  });

  it("rejects execution when the user lacks export.data permission", async () => {
    const a1 = await seedResult([["华东", 10]], { owner: noExportUserId });
    const result = await run(
      { filename: "销售汇总", sheets: [{ name: "汇总", artifactId: a1 }] },
      context({ userId: noExportUserId }),
    );
    expect(result.isError).toBe(true);
    expect(detailsOf(result).code).toBe("FORBIDDEN");
  });

  it("rejects foreign, cross-conversation, and non-result artifacts", async () => {
    const foreignId = await seedResult([["华东", 1]], { owner: otherUserId });
    const otherConvId = await seedResult([["华东", 1]], { conversation: otherConversationId });
    const chartMeta = artifacts.createChart({
      conversationId,
      userId,
      runId: "r0",
      columns,
      spec: { option: {} },
      rowCount: 1,
    });

    const foreign = await run({
      filename: "a",
      sheets: [{ name: "s", artifactId: foreignId }],
    });
    expect(foreign.isError).toBe(true);
    expect(detailsOf(foreign).code).toBe("ARTIFACT_NOT_FOUND");

    const otherConv = await run({
      filename: "a",
      sheets: [{ name: "s", artifactId: otherConvId }],
    });
    expect(otherConv.isError).toBe(true);
    expect(detailsOf(otherConv).code).toBe("ARTIFACT_NOT_FOUND");

    const chart = await run({
      filename: "a",
      sheets: [{ name: "s", artifactId: chartMeta.id }],
    });
    expect(chart.isError).toBe(true);
    expect(detailsOf(chart).code).toBe("INVALID_ARTIFACT_KIND");
  });

  it("rejects sheets whose run is hidden by department data scope", async () => {
    const scopedConv = createConversation(handle.db, {
      userId,
      datasourceId: scopedDatasourceId,
    }).id;
    const legacyRun = createRun(handle.db, {
      conversationId: scopedConv,
      userId,
      // No scopeSnapshot recorded while datasource has dataScopeMode="enabled" -> invisible to non-admin
    });
    const scopedResult = await seedResult([["华东", 10]], {
      conversation: scopedConv,
      runId: legacyRun.id,
    });

    const result = await run(
      { filename: "越权数据", sheets: [{ name: "明细", artifactId: scopedResult }] },
      context({ conversationId: scopedConv, datasourceId: scopedDatasourceId, sourceKind: "datasource" }),
    );
    expect(result.isError).toBe(true);
    expect(detailsOf(result).code).toBe("ARTIFACT_NOT_FOUND");
  });

  it("rejects workbooks exceeding total row cap or sheet cap", async () => {
    const big1 = await seedResult([["a", 1]], { rowCount: 60_000 });
    const big2 = await seedResult([["b", 2]], { rowCount: 40_001 });

    const overRows = await run({
      filename: "超大工作簿",
      sheets: [
        { name: "s1", artifactId: big1 },
        { name: "s2", artifactId: big2 },
      ],
    });
    expect(overRows.isError).toBe(true);
    expect(detailsOf(overRows).code).toBe("EXPORT_TOO_LARGE");

    const small = await seedResult([["a", 1]]);
    const overSheets = await run({
      filename: "过多工作表",
      sheets: Array.from({ length: EXCEL_MAX_SHEETS + 1 }, (_, i) => ({
        name: `S${i + 1}`,
        artifactId: small,
      })),
    });
    expect(overSheets.isError).toBe(true);
    expect(detailsOf(overSheets).code).toBe("VALIDATION");
  });

  it("gates create_excel behind canExportData and list_artifacts returns only result artifacts", async () => {
    const r1 = await seedResult([["华东", 10]]);
    artifacts.createChart({
      conversationId,
      userId,
      runId: "r0",
      columns,
      spec: { option: {} },
      rowCount: 1,
    });
    await run({ filename: "汇总", sheets: [{ name: "区域", artifactId: r1 }] });

    expect(buildAgentTools(context(), { canExportData: false }).map((t) => t.name)).not.toContain(
      "create_excel",
    );
    const tools = buildAgentTools(context(), { canExportData: true });
    expect(tools.map((t) => t.name)).toContain("create_excel");

    const listTool = tools.find((t) => t.name === "list_artifacts")!;
    const listed = await listTool.execute("call-list", {} as never, undefined, undefined, context() as never);
    const body = JSON.parse(textOf(listed)) as { artifacts: Array<{ id: string }> };
    expect(body.artifacts.map((a) => a.id)).toEqual([r1]);
  });
});
