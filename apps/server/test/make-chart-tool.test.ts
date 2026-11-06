import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { ArtifactStore, type ColumnInfo } from "../src/services/artifacts.js";
import { buildAgentTools } from "../src/agent/tools/index.js";
import { createMakeChartTool, type MakeChartDetails } from "../src/agent/tools/make-chart.js";
import type { AgentToolContext } from "../src/agent/tools/context.js";
import { testConfig as config } from "./helpers/config.js";

let root: string;
let handle: DbHandle;
let artifacts: ArtifactStore;

const columns: ColumnInfo[] = [
  { name: "month", type: "string" },
  { name: "amount", type: "number" },
];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-make-chart-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  artifacts = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await artifacts.init();
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
    userId: "u1",
    conversationId: "c1",
    datasourceId: "d1",
    runId: "r1",
    skillsDir: path.join(root, "skills"),
    ...overrides,
  };
}

async function seedResult(
  rows: unknown[][],
  options: { owner?: string; conversation?: string; columns?: ColumnInfo[] } = {},
): Promise<string> {
  const writer = artifacts.openResult({
    userId: options.owner ?? "u1",
    conversationId: options.conversation ?? "c1",
    runId: "r0",
  });
  for (const row of rows) await writer.write(row);
  const meta = await writer.finish({
    columns: options.columns ?? columns,
    rowCount: rows.length,
    truncated: false,
  });
  return meta.id;
}

function run(
  artifactId: string,
  params: Record<string, unknown>,
  ctx: AgentToolContext = context(),
) {
  return createMakeChartTool(ctx).execute(
    "call-1",
    { artifactId, type: "bar", x: "month", y: "amount", aggregate: "sum", ...params } as never,
    undefined,
    undefined,
    ctx as never,
  );
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function detailsOf(result: unknown): MakeChartDetails {
  return (result as { details: MakeChartDetails }).details;
}

describe("make_chart", () => {
  it("persists a chart artifact with the ECharts spec", async () => {
    const artifactId = await seedResult([
      ["2024-01", 10],
      ["2024-01", 5],
      ["2024-02", 20],
    ]);

    const result = await run(artifactId, { title: "月度金额" });
    expect(result.isError).toBeFalsy();

    const details = detailsOf(result);
    expect(details.chartArtifactId.length).toBeGreaterThan(0);
    expect(details.sourceArtifactId).toBe(artifactId);
    expect(details.points).toBe(2);
    expect(details.title).toBe("月度金额");

    const record = artifacts.get(details.chartArtifactId);
    expect(record?.kind).toBe("chart");
    expect(record?.storagePath).toBe("");
    expect(record?.rowCount).toBe(2);
    expect(record?.conversationId).toBe("c1");
    expect(record?.runId).toBe("r1");
    expect(record?.columns).toEqual(columns);

    const spec = JSON.parse(record!.specJson!) as {
      option: { series: Array<{ data: unknown[] }> };
      chart: { type: string; title: string };
    };
    expect(spec.chart).toMatchObject({ type: "bar", title: "月度金额" });
    expect(spec.option.series[0]!.data).toEqual([20, 15]);
    expect((await artifacts.read(details.chartArtifactId))?.rows).toEqual([]);

    const compact = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(compact).toEqual({
      chartArtifactId: details.chartArtifactId,
      type: "bar",
      points: 2,
      title: "月度金额",
    });
  });

  it("defaults the title to the y column", async () => {
    const artifactId = await seedResult([["2024-01", 10]]);
    const result = await run(artifactId, {});
    expect(detailsOf(result).title).toBe("amount");
  });

  it("rejects artifacts owned by another user", async () => {
    const artifactId = await seedResult([["2024-01", 10]], { owner: "u2" });
    const result = await run(artifactId, {});

    expect(result.isError).toBe(true);
    expect(detailsOf(result).chartArtifactId).toBe("");
    expect(detailsOf(result).code).toBe("ARTIFACT_NOT_FOUND");
    expect(textOf(result)).toContain("不属于当前会话");
  });

  it("rejects artifacts from another conversation", async () => {
    const artifactId = await seedResult([["2024-01", 10]], { conversation: "c2" });
    const result = await run(artifactId, {});
    expect(result.isError).toBe(true);
    expect(detailsOf(result).code).toBe("ARTIFACT_NOT_FOUND");
  });

  it("surfaces chart aggregation errors without creating an artifact", async () => {
    const artifactId = await seedResult([["2024-01", "n/a"]], {
      columns: [
        { name: "month", type: "string" },
        { name: "amount", type: "string" },
      ],
    });
    const result = await run(artifactId, {});

    expect(result.isError).toBe(true);
    expect(detailsOf(result).code).toBe("Y_NOT_NUMERIC");
    expect(artifacts.list({ userId: "u1", conversationId: "c1" })).toHaveLength(1);
  });

  it("is registered in buildAgentTools", () => {
    const names = buildAgentTools(context()).map((tool) => tool.name);
    expect(names).toContain("make_chart");
  });
});
