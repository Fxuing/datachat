import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { testConfig } from "./helpers/config.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

let tmpDir: string;
let db: Db;
let closeDb: () => void;
let adminCookie: string;
let viewerCookie: string;

function makeMultipart(
  fileName: string,
  content: Buffer | string,
  extraFields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----DataChatTest${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(extraFields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    ),
  );
  chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Minimal valid ZIP builder (Deflate method 8) for testing offline archive extraction. */
function buildZip(entries: Array<{ name: string; content: string | Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const compressed = zlib.deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/** Minimal valid USTAR .tgz builder for testing npm-pack style archives. */
function buildTgz(entries: Array<{ name: string; content: string | Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, Math.min(100, Buffer.byteLength(entry.name)), "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${raw.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "ascii");
    header.fill(0x20, 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i]!;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header, raw);
    const rem = raw.length % 512;
    if (rem > 0) blocks.push(Buffer.alloc(512 - rem, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function driverSource(id: string, label: string): string {
  return `
export default {
  manifest: {
    sdkVersion: 1,
    id: ${JSON.stringify(id)},
    label: ${JSON.stringify(label)},
    connectionMode: "network",
    defaultPort: 9000,
    supportsSsl: false,
    optionsSchema: [],
    capabilities: { explain: false, readOnlyProbe: false, rowScope: false }
  },
  dialect: { parserDialect: "mysql", placeholderStyle: "qmark", quoteChar: "\`" },
  async probe() { return { ok: true, readOnly: false, warnings: [] }; },
  createPool() {
    return {
      async introspect() { return { tables: [], refreshedAt: Date.now() }; },
      async executeQuery(_req, emit) { await emit({ columns: [{ name: "v", type: "number" }], rows: [[1]] }); },
      async close() {}
    };
  }
};
`;
}

beforeEach(async () => {
  // Keep temp dir on the same drive as the workspace so Vitest's module runner can resolve file:// imports.
  const base = path.join(REPO_ROOT, ".tmp-plugin-upload-tests");
  fs.mkdirSync(base, { recursive: true });
  tmpDir = fs.mkdtempSync(path.join(base, "run-"));

  const handle = createDb(path.join(tmpDir, "app.db"));
  db = handle.db;
  closeDb = () => handle.sqlite.close();
  migrateDb(db);

  const hash = await hashPassword("secret");
  const now = Date.now();
  const admin = insertUser(db, {
    id: randomUUID(),
    username: "root",
    passwordHash: hash,
    role: "admin",
    createdAt: now,
  });
  const viewer = insertUser(db, {
    id: randomUUID(),
    username: "alice",
    passwordHash: hash,
    role: "user",
    createdAt: now,
  });
  const signer = createSessionSigner(testConfig.appSecret);
  adminCookie = await signer.sign({ sub: admin.id, username: admin.username, role: admin.role });
  viewerCookie = await signer.sign({ sub: viewer.id, username: viewer.username, role: viewer.role });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(path.join(REPO_ROOT, ".tmp-plugin-upload-tests"), { recursive: true, force: true });
});

describe("offline datasource plugin upload & management", () => {
  it("uploads .mjs, upgrades with replace=true, toggles enable/disable, persists across restarts, and uninstalls", async () => {
    const config = { ...testConfig, dataDir: tmpDir };
    const app = await buildApp({ config, db, enableRateLimit: false });

    try {
      // Non-admin is forbidden.
      const forbidden = await app.inject({
        method: "GET",
        url: "/api/admin/datasource-plugins",
        cookies: { dc_session: viewerCookie },
      });
      expect(forbidden.statusCode).toBe(403);

      // Upload real ClickHouse example .mjs file.
      const ckBytes = fs.readFileSync(
        path.join(REPO_ROOT, "examples", "driver-clickhouse", "index.mjs"),
      );
      const mp = makeMultipart("clickhouse-driver.mjs", ckBytes);
      const uploadRes = await app.inject({
        method: "POST",
        url: "/api/admin/datasource-plugins/upload",
        cookies: { dc_session: adminCookie },
        headers: mp.headers,
        payload: mp.payload,
      });
      expect(uploadRes.statusCode).toBe(201);
      const uploaded = uploadRes.json() as {
        replaced: boolean;
        plugin: { id: string; label: string; source: string; enabled: boolean; loaded: boolean };
      };
      expect(uploaded.replaced).toBe(false);
      expect(uploaded.plugin.id).toBe("clickhouse");
      expect(uploaded.plugin.source).toBe("upload");
      expect(uploaded.plugin.loaded).toBe(true);

      // Immediately hot-registered in GET /api/datasources/drivers without restart.
      const driversRes = await app.inject({
        method: "GET",
        url: "/api/datasources/drivers",
        cookies: { dc_session: adminCookie },
      });
      expect(
        (driversRes.json() as { drivers: Array<{ id: string }> }).drivers.some(
          (d) => d.id === "clickhouse",
        ),
      ).toBe(true);

      // Duplicate upload without replace=true returns 409 PLUGIN_ALREADY_EXISTS.
      const dupMp = makeMultipart("clickhouse-v2.mjs", driverSource("clickhouse", "ClickHouse v2"));
      const dupRes = await app.inject({
        method: "POST",
        url: "/api/admin/datasource-plugins/upload",
        cookies: { dc_session: adminCookie },
        headers: dupMp.headers,
        payload: dupMp.payload,
      });
      expect(dupRes.statusCode).toBe(409);
      expect((dupRes.json() as { error: { code: string } }).error.code).toBe("PLUGIN_ALREADY_EXISTS");

      // Re-uploading with replace=true hot-upgrades immediately.
      const upgMp = makeMultipart("clickhouse-v2.mjs", driverSource("clickhouse", "ClickHouse v2"), {
        replace: "true",
      });
      const upgRes = await app.inject({
        method: "POST",
        url: "/api/admin/datasource-plugins/upload",
        cookies: { dc_session: adminCookie },
        headers: upgMp.headers,
        payload: upgMp.payload,
      });
      expect(upgRes.statusCode).toBe(201);
      expect((upgRes.json() as { replaced: boolean; plugin: { label: string } }).replaced).toBe(true);
      expect((upgRes.json() as { plugin: { label: string } }).plugin.label).toBe("ClickHouse v2");

      // Disable hot-unregisters the driver.
      const disableRes = await app.inject({
        method: "PATCH",
        url: "/api/admin/datasource-plugins/clickhouse",
        cookies: { dc_session: adminCookie },
        payload: { enabled: false },
      });
      expect(disableRes.statusCode).toBe(200);
      expect((disableRes.json() as { plugin: { enabled: boolean; loaded: boolean } }).plugin).toMatchObject({
        enabled: false,
        loaded: false,
      });
      const afterDisable = await app.inject({
        method: "GET",
        url: "/api/datasources/drivers",
        cookies: { dc_session: adminCookie },
      });
      expect(
        (afterDisable.json() as { drivers: Array<{ id: string }> }).drivers.some(
          (d) => d.id === "clickhouse",
        ),
      ).toBe(false);

      // Re-enable hot-registers it again.
      const enableRes = await app.inject({
        method: "PATCH",
        url: "/api/admin/datasource-plugins/clickhouse",
        cookies: { dc_session: adminCookie },
        payload: { enabled: true },
      });
      expect(enableRes.statusCode).toBe(200);
      expect((enableRes.json() as { plugin: { loaded: boolean } }).plugin.loaded).toBe(true);
    } finally {
      await app.close();
    }

    // Simulated server restart: fresh buildApp loads persisted enabled plugin automatically.
    const restarted = await buildApp({ config, db, enableRateLimit: false });
    try {
      const driversAfterBoot = await restarted.inject({
        method: "GET",
        url: "/api/datasources/drivers",
        cookies: { dc_session: adminCookie },
      });
      const ck = (
        driversAfterBoot.json() as { drivers: Array<{ id: string; label: string }> }
      ).drivers.find((d) => d.id === "clickhouse");
      expect(ck?.label).toBe("ClickHouse v2");

      // Uninstall removes from registry, DB, and disk.
      const delRes = await restarted.inject({
        method: "DELETE",
        url: "/api/admin/datasource-plugins/clickhouse",
        cookies: { dc_session: adminCookie },
      });
      expect(delRes.statusCode).toBe(200);
      expect(fs.existsSync(path.join(tmpDir, "plugins", "datasources", "clickhouse"))).toBe(false);
    } finally {
      await restarted.close();
    }
  });

  it("extracts .zip and .tgz bundles and rejects zip-slip, built-in overrides, and disabled uploads", async () => {
    const config = { ...testConfig, dataDir: tmpDir };
    const app = await buildApp({ config, db, enableRateLimit: false });

    try {
      // .zip bundle with top-level folder and package.json main entry.
      const zipBuf = buildZip([
        {
          name: "driver-starrocks/package.json",
          content: JSON.stringify({
            name: "datachat-driver-starrocks",
            version: "2.3.4",
            type: "module",
            main: "./dist/entry.mjs",
          }),
        },
        {
          name: "driver-starrocks/dist/entry.mjs",
          content: driverSource("starrocks", "StarRocks"),
        },
      ]);
      const zipMp = makeMultipart("driver-starrocks.zip", zipBuf);
      const zipRes = await app.inject({
        method: "POST",
        url: "/api/admin/datasource-plugins/upload",
        cookies: { dc_session: adminCookie },
        headers: zipMp.headers,
        payload: zipMp.payload,
      });
      expect(zipRes.statusCode).toBe(201);
      expect((zipRes.json() as { plugin: { id: string; version: string } }).plugin).toMatchObject({
        id: "starrocks",
        version: "2.3.4",
      });

      // .tgz bundle (npm pack layout: package/...).
      const tgzBuf = buildTgz([
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "datachat-driver-doris",
            version: "0.9.1",
            type: "module",
            main: "index.mjs",
          }),
        },
        {
          name: "package/index.mjs",
          content: driverSource("doris", "Apache Doris"),
        },
      ]);
      const tgzMp = makeMultipart("driver-doris-0.9.1.tgz", tgzBuf);
      const tgzRes = await app.inject({
        method: "POST",
        url: "/api/admin/datasource-plugins/upload",
        cookies: { dc_session: adminCookie },
        headers: tgzMp.headers,
        payload: tgzMp.payload,
      });
      expect(tgzRes.statusCode).toBe(201);
      expect((tgzRes.json() as { plugin: { id: string; version: string } }).plugin).toMatchObject({
        id: "doris",
        version: "0.9.1",
      });

      // Zip-slip traversal is rejected cleanly.
      const evilZip = buildZip([{ name: "../escape.mjs", content: driverSource("evil", "Evil") }]);
      const evilMp = makeMultipart("evil.zip", evilZip);
      const evilRes = await app.inject({
        method: "POST",
        url: "/api/admin/datasource-plugins/upload",
        cookies: { dc_session: adminCookie },
        headers: evilMp.headers,
        payload: evilMp.payload,
      });
      expect(evilRes.statusCode).toBe(400);
      expect((evilRes.json() as { error: { code: string } }).error.code).toBe("INVALID_ARCHIVE");

      // Built-in mysql id cannot be overridden.
      const mysqlMp = makeMultipart("fake-mysql.mjs", driverSource("mysql", "Fake MySQL"));
      const mysqlRes = await app.inject({
        method: "POST",
        url: "/api/admin/datasource-plugins/upload",
        cookies: { dc_session: adminCookie },
        headers: mysqlMp.headers,
        payload: mysqlMp.payload,
      });
      expect(mysqlRes.statusCode).toBe(409);
      expect((mysqlRes.json() as { error: { code: string } }).error.code).toBe("PLUGIN_ID_CONFLICT");
    } finally {
      await app.close();
    }

    // ALLOW_PLUGIN_UPLOAD=false blocks uploads with 403.
    const lockedApp = await buildApp({
      config: { ...config, allowPluginUpload: false },
      db,
      enableRateLimit: false,
    });
    try {
      const mp = makeMultipart("trino.mjs", driverSource("trino", "Trino"));
      const res = await lockedApp.inject({
        method: "POST",
        url: "/api/admin/datasource-plugins/upload",
        cookies: { dc_session: adminCookie },
        headers: mp.headers,
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("PLUGIN_UPLOAD_DISABLED");
    } finally {
      await lockedApp.close();
    }
  });
});
