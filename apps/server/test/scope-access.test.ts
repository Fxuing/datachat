import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { appendRunEvent } from "../src/db/repositories/run-events.js";
import { insertUser } from "../src/db/repositories/users.js";
import { createRun, findRun, saveRunScopeSnapshot } from "../src/db/repositories/runs.js";
import { updateDatasource } from "../src/db/repositories/datasources.js";
import {
  createDepartment,
  setUserDepartments,
} from "../src/db/repositories/departments.js";
import { upsertScopePolicy } from "../src/db/repositories/data-scope.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { ArtifactStore, type ColumnInfo } from "../src/services/artifacts.js";
import { runScopeVisible } from "../src/services/scope-access.js";
import { createShare, resolveShare, revokeSharesForDatasource } from "../src/services/shares.js";
import { testConfig } from "./helpers/config.js";

const columns: ColumnInfo[] = [{ name: "id", type: "number" }];

let root: string;
let db: Db;
let store: ArtifactStore;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let adminCookie: string;
let datasourceId: string;
let conversationId: string;
let salesId: string;
let eastId: string;
let westId: string;

const fakeRuntime = {
  bus: new RunEventBus(),
  abort: vi.fn(() => true),
  remove: vi.fn(async () => undefined),
  isBusy: vi.fn(() => false),
  shutdown: vi.fn(async () => undefined),
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-scope-access-"));
  db = createDb(":memory:").db;
  migrateDb(db);
  const signer = createSessionSigner(testConfig.appSecret);
  for (const [id, username, role] of [
    ["u1", "alice", "user"],
    ["admin", "root", "admin"],
  ] as const) {
    insertUser(db, { id, username, passwordHash: "not-used", role, createdAt: Date.now() });
  }
  cookie = await signer.sign({ sub: "u1", username: "alice", role: "user" });
  adminCookie = await signer.sign({ sub: "admin", username: "root", role: "admin" });

  datasourceId = "d1";
  insertDatasource(db, {
    id: datasourceId,
    name: "demo",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "demo",
    username: "demo",
    passwordCipher: "cipher",
    readOnlyVerified: 1,
    createdBy: "admin",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  replaceGrants(db, datasourceId, ["u1"]);
  conversationId = createConversation(db, { userId: "u1", datasourceId, title: "销售" }).id;

  salesId = createDepartment(db, { name: "销售", code: "sales" }).id;
  eastId = createDepartment(db, { name: "华东", code: "east", parentId: salesId }).id;
  westId = createDepartment(db, { name: "华西", code: "west", parentId: salesId }).id;
  setUserDepartments(db, "u1", [salesId]);
  upsertScopePolicy(db, {
    datasourceId,
    tableName: "orders",
    mode: "scoped",
    rules: [{ columnName: "dept_id", operator: "in", valueMode: "department_id" }],
  });

  store = new ArtifactStore(db, path.join(root, "artifacts"));
  await store.init();
  app = await buildApp({
    config: { ...testConfig, dataDir: root, agentAuthPath: path.join(root, "agent", "auth.json") },
    db,
    enableRateLimit: false,
    agentRuntime: fakeRuntime as unknown as RuntimeManager,
    artifacts: store,
  });
});

afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedResult(runId: string): Promise<string> {
  const writer = store.openResult({ userId: "u1", conversationId, runId });
  await writer.write([1]);
  const meta = await writer.finish({ columns, rowCount: 1, truncated: false });
  return meta.id;
}

async function seedRun(departments: string[] | null, options: { enabled?: boolean } = {}) {
  if (options.enabled !== false) {
    updateDatasource(db, datasourceId, { dataScopeMode: "enabled" });
  }
  const run = createRun(db, { conversationId, userId: "u1" });
  if (departments) {
    saveRunScopeSnapshot(
      db,
      run.id,
      JSON.stringify({ v: 1, datasourceId, departments, policyHash: "h" }),
    );
  }
  appendRunEvent(db, {
    runId: run.id,
    conversationId,
    type: "user_message",
    payload: { content: "有多少订单？" },
  });
  return { run: findRun(db, run.id)!, artifactId: await seedResult(run.id) };
}

describe("run scope visibility", () => {
  it("keeps runs inside the viewer's current department subtree", async () => {
    const { run } = await seedRun([eastId]);
    expect(runScopeVisible(db, run, false)).toBe(true);
  });

  it("hides runs whose snapshot leaves the current department subtree", async () => {
    const { run } = await seedRun([westId]);
    setUserDepartments(db, "u1", [eastId]);
    expect(runScopeVisible(db, run, false)).toBe(false);
  });

  it("treats snapshots without a department list as unrestricted", async () => {
    const { run } = await seedRun([]);
    expect(runScopeVisible(db, run, false)).toBe(true);
  });

  it("hides legacy runs without a snapshot once the datasource is enabled", async () => {
    const { run } = await seedRun(null);
    expect(runScopeVisible(db, run, false)).toBe(false);
    expect(runScopeVisible(db, run, true)).toBe(true);
  });

  it("keeps legacy runs readable while the datasource is off", async () => {
    const { run } = await seedRun(null, { enabled: false });
    expect(runScopeVisible(db, run, false)).toBe(true);
  });
});

describe("scope-aware artifact routes", () => {
  it("returns rows for a visible run and 404 for a stale snapshot", async () => {
    const { artifactId } = await seedRun([eastId]);
    const visible = await app.inject({
      method: "GET",
      url: `/api/artifacts/${artifactId}/rows`,
      cookies: { dc_session: cookie },
    });
    expect(visible.statusCode).toBe(200);

    setUserDepartments(db, "u1", [westId]);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/artifacts/${artifactId}/rows`,
      cookies: { dc_session: cookie },
    });
    expect(hidden.statusCode).toBe(404);

    const admin = await app.inject({
      method: "GET",
      url: `/api/artifacts/${artifactId}/rows`,
      cookies: { dc_session: adminCookie },
    });
    expect(admin.statusCode).toBe(200);
  });

  it("labels scoped runs with the department names that filtered them", async () => {
    const { run } = await seedRun([eastId]);
    saveRunScopeSnapshot(
      db,
      run.id,
      JSON.stringify({
        v: 1,
        datasourceId,
        departments: [eastId],
        departmentNames: ["华东"],
        scopedTables: ["orders"],
        policyHash: "h",
      }),
    );

    const detail = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
      cookies: { dc_session: cookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      messages: { runId: string; scope: { departments: string[] } | null }[];
    };
    expect(body.messages.find((item) => item.runId === run.id)?.scope).toEqual({
      departments: ["华东"],
    });
  });

  it("drops legacy runs from the conversation detail for non-admins", async () => {
    await seedRun(null);
    const detail = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
      cookies: { dc_session: cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages).toEqual([]);
  });
});

describe("shares under department scope", () => {
  it("refuses new public shares once the datasource is enabled", async () => {
    updateDatasource(db, datasourceId, { dataScopeMode: "enabled" });
    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      cookies: { dc_session: cookie },
      payload: { conversationId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SHARE_DISABLED_BY_SCOPE");
  });

  it("makes existing links fail after enablement and revokes them", async () => {
    const created = createShare({ db, userId: "u1", conversationId });
    expect(created.ok).toBe(true);
    const token = created.ok ? created.share.token : "";
    updateDatasource(db, datasourceId, { dataScopeMode: "enabled" });

    const resolved = await resolveShare({ db, artifacts: store, token });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe("SHARE_DISABLED_BY_SCOPE");

    expect(revokeSharesForDatasource(db, datasourceId)).toBe(1);
    expect(revokeSharesForDatasource(db, datasourceId)).toBe(0);
  });
});
