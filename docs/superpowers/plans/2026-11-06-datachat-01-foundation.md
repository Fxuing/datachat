# DataChat Plan 1: Foundation, Auth, Datasources, SQL Core

> **实施状态：已交付。** 下方复选框保留为原始执行模板，未逐项回填；实际交付、计划外能力与差异见 [`docs/roadmap.md`](../../roadmap.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一个可运行的 Fastify + SQLite 后端骨架，完成登录、用户/授权、数据源管理与只读 SQL 核心（守卫、流式执行、结果落盘、审计），并用 Testcontainers 验证 MySQL/PostgreSQL 两条链路。

**Architecture:** pnpm workspace 单仓。`apps/server` 是 Fastify 应用，`packages/shared` 放 zod 契约。SQLite 由 Drizzle + better-sqlite3 管理，迁移用 drizzle-kit 生成。SQL 执行分三层：`guardSql()` 纯函数解析校验 → `executeReadOnly()` 通过 mysql2/pg 流式读取 → `ArtifactStore` 写 JSONL.gz 并落 `artifacts`/`query_audit`。

**Tech Stack:** Node 22, TypeScript (ESM, strict), Fastify 5, Drizzle ORM, better-sqlite3, zod, jose, @node-rs/argon2, mysql2, pg + pg-cursor, node-sql-parser, vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-06-datachat-design.md` §5.2、§6、§7、§8、§9、§13、§15、§17。

---

## 前置约定

- 所有命令在仓库根目录 `G:/dev_directory/ai/datachat` 执行。
- 集成测试需要 Docker；默认跳过，显式 `RUN_DB_TESTS=1` 才跑：
  - Git Bash / Linux / macOS：`RUN_DB_TESTS=1 pnpm vitest run apps/server/test/...`
  - PowerShell：`$env:RUN_DB_TESTS="1"; pnpm vitest run apps/server/test/...`
- 每一 Task 结束必须 `pnpm typecheck` 通过并 commit。
- 所有时间戳是 UTC epoch 毫秒；ID 用 `crypto.randomUUID()`。

---

## Task 1: Workspace 骨架与健康检查

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/routes/health.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/index.ts`
- Create: `apps/server/test/health.test.ts`
- Create: `packages/shared/package.json`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: 写根目录配置**

`package.json`：

```json
{
  "name": "datachat",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.3",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "verify": "pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "cross-env": "^7.0.3",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/server/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
```

`.gitignore`：

```
node_modules/
dist/
data/
*.db
*.db-shm
*.db-wal
.env
coverage/
```

`.env.example`：

```
PORT=8080
APP_SECRET=replace-with-at-least-32-random-characters
DATA_DIR=./data
LOG_LEVEL=info
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-now
```

- [ ] **Step 2: 写 shared 包**

`packages/shared/package.json`：

```json
{
  "name": "@datachat/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "typescript": "^5.7.2" }
}
```

`packages/shared/src/index.ts`：

```ts
import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const userRoleSchema = z.enum(["admin", "user"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const publicUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  role: userRoleSchema,
  status: z.enum(["active", "disabled"]),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const datasourceTypeSchema = z.enum(["mysql", "postgres"]);
export type DatasourceType = z.infer<typeof datasourceTypeSchema>;

export const datasourceInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  type: datasourceTypeSchema,
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(500).optional(),
  sslMode: z.enum(["disable", "require"]).default("disable"),
});
export type DatasourceInput = z.infer<typeof datasourceInputSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
```

- [ ] **Step 3: 写 server 配置与骨架**

`apps/server/package.json`：

```json
{
  "name": "@datachat/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@datachat/shared": "workspace:*",
    "@fastify/cookie": "^11.0.2",
    "@fastify/rate-limit": "^9.1.0",
    "@node-rs/argon2": "^2.0.2",
    "better-sqlite3": "^11.7.0",
    "drizzle-orm": "^0.38.3",
    "fastify": "^5.2.0",
    "jose": "^5.9.6",
    "mysql2": "^3.11.5",
    "node-sql-parser": "^5.3.4",
    "pg": "^8.13.1",
    "pg-cursor": "^2.12.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@testcontainers/mysql": "^10.16.0",
    "@testcontainers/postgresql": "^10.16.0",
    "@types/better-sqlite3": "^7.6.12",
    "@types/pg": "^8.11.10",
    "drizzle-kit": "^0.30.1",
    "testcontainers": "^10.16.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

`apps/server/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

`apps/server/src/config.ts`：

```ts
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8080),
  APP_SECRET: z.string().min(32, "APP_SECRET 至少 32 个字符"),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.string().default("info"),
  SILICONFLOW_API_KEY: z.string().optional(),
  SILICONFLOW_BASE_URL: z.string().url().default("https://api.siliconflow.cn/v1"),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().min(8).optional(),
});

export interface AppConfig {
  port: number;
  appSecret: string;
  dataDir: string;
  dbPath: string;
  logLevel: string;
  siliconflowApiKey?: string;
  siliconflowBaseUrl: string;
  adminUsername: string;
  adminPassword?: string;
  isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const dataDir = path.resolve(parsed.DATA_DIR);
  return {
    port: parsed.PORT,
    appSecret: parsed.APP_SECRET,
    dataDir,
    dbPath: path.join(dataDir, "datachat.db"),
    logLevel: parsed.LOG_LEVEL,
    siliconflowApiKey: parsed.SILICONFLOW_API_KEY || undefined,
    siliconflowBaseUrl: parsed.SILICONFLOW_BASE_URL,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    isProduction: env.NODE_ENV === "production",
  };
}
```

`apps/server/src/routes/health.ts`：

```ts
import type { FastifyInstance } from "fastify";

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    ok: true,
    version: "0.1.0",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  }));
}
```

`apps/server/src/app.ts`：

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import type { AppConfig } from "./config.js";

export interface BuildAppOptions {
  config: AppConfig;
  enableRateLimit?: boolean;
}

export async function buildApp({ config, enableRateLimit = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  await app.register(import("@fastify/cookie"));
  if (enableRateLimit) {
    await app.register(import("@fastify/rate-limit"), { global: false });
  }
  await app.register(healthRoutes);
  return app;
}
```

`apps/server/src/index.ts`：

```ts
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = await buildApp({ config });
await app.listen({ port: config.port, host: "0.0.0.0" });
```

- [ ] **Step 4: 写健康检查测试并确认失败**

`apps/server/test/health.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir: "./data-test",
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  adminUsername: "admin",
  isProduction: false,
};

describe("health", () => {
  it("returns ok", async () => {
    const app = await buildApp({ config, enableRateLimit: false });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });
});
```

Run: `pnpm install && pnpm vitest run apps/server/test/health.test.ts`
Expected: FAIL，报找不到 `fastify` 或 `../src/app.js`（依赖未安装/文件未就绪）。

- [ ] **Step 5: 安装依赖并让测试通过**

Run:

```bash
pnpm install
pnpm vitest run apps/server/test/health.test.ts
```

Expected: `1 passed`。

- [ ] **Step 6: 类型检查并提交**

```bash
pnpm typecheck
git add -A
git commit -m "chore: scaffold workspace with fastify health endpoint"
```

---

## Task 2: 数据库 schema、迁移与管理员初始化

**Files:**
- Create: `apps/server/drizzle.config.ts`
- Create: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/db/migrate.ts`
- Create: `apps/server/src/auth/bootstrap.ts`
- Create: `apps/server/src/db/repositories/users.ts`
- Create: `apps/server/test/db.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: 写 Drizzle schema**

`apps/server/src/db/schema.ts`（Plan 1 只用到前 5 张表，其余表一次建好避免后续迁移）：

```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  lastLoginAt: integer("last_login_at"),
});

export const datasources = sqliteTable("datasources", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type", { enum: ["mysql", "postgres"] }).notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  database: text("database").notNull(),
  username: text("username").notNull(),
  passwordCipher: text("password_cipher").notNull(),
  sslMode: text("ssl_mode", { enum: ["disable", "require"] }).notNull().default("disable"),
  readOnlyVerified: integer("read_only_verified").notNull().default(0),
  status: text("status").notNull().default("unknown"),
  lastCheckedAt: integer("last_checked_at"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const datasourceGrants = sqliteTable("datasource_grants", {
  id: text("id").primaryKey(),
  datasourceId: text("datasource_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const datasourceSchemaCache = sqliteTable("datasource_schema_cache", {
  datasourceId: text("datasource_id").primaryKey(),
  payloadJson: text("payload_json").notNull(),
  tableCount: integer("table_count").notNull().default(0),
  refreshedAt: integer("refreshed_at").notNull(),
  error: text("error"),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  datasourceId: text("datasource_id").notNull(),
  title: text("title"),
  modelId: text("model_id"),
  thinkingLevel: text("thinking_level").notNull().default("off"),
  piSessionFile: text("pi_session_file"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastMessageAt: integer("last_message_at"),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("queued"),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
});

export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const queryAudit = sqliteTable("query_audit", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  conversationId: text("conversation_id"),
  userId: text("user_id").notNull(),
  datasourceId: text("datasource_id").notNull(),
  action: text("action", { enum: ["query", "explain", "export"] }).notNull().default("query"),
  sqlText: text("sql_text").notNull(),
  sqlHash: text("sql_hash").notNull(),
  status: text("status", { enum: ["ok", "rejected", "error", "timeout"] }).notNull(),
  rowCount: integer("row_count"),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  runId: text("run_id"),
  kind: text("kind", { enum: ["result", "chart"] }).notNull(),
  storagePath: text("storage_path"),
  columnsJson: text("columns_json"),
  rowCount: integer("row_count").notNull().default(0),
  truncated: integer("truncated").notNull().default(0),
  specJson: text("spec_json"),
  createdAt: integer("created_at").notNull(),
});

export const reports = sqliteTable("reports", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  markdown: text("markdown").notNull(),
  artifactIdsJson: text("artifact_ids_json").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  conversationId: text("conversation_id"),
  reportId: text("report_id"),
  createdBy: text("created_by").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
});

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  transport: text("transport", { enum: ["stdio", "http"] }).notNull(),
  command: text("command"),
  argsJson: text("args_json"),
  envCipher: text("env_cipher"),
  url: text("url"),
  headersCipher: text("headers_cipher"),
  datasourceId: text("datasource_id"),
  enabled: integer("enabled").notNull().default(1),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  scope: text("scope", { enum: ["global", "datasource"] }).notNull(),
  datasourceId: text("datasource_id"),
  name: text("name").notNull(),
  description: text("description").notNull(),
  content: text("content").notNull(),
  enabled: integer("enabled").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});
```

- [ ] **Step 2: 写 schema 类型与迁移配置**

`apps/server/src/db/client.ts`：

```ts
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

export function createDb(path: string): DbHandle {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export { schema };
```

`apps/server/drizzle.config.ts`：

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: "./data/datachat.db" },
});
```

`apps/server/src/db/migrate.ts`：

```ts
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
```

- [ ] **Step 3: 写用户仓库与管理员初始化**

`apps/server/src/db/repositories/users.ts`：

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { users } from "../schema.js";
import type { PublicUser, UserRole } from "@datachat/shared";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string | null;
  role: UserRole;
  status: "active" | "disabled";
  createdAt: number;
  lastLoginAt: number | null;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
  };
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.username, username)).get() as UserRow | undefined;
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get() as UserRow | undefined;
}

export function countUsers(db: Db): number {
  return db.select({ id: users.id }).from(users).all().length;
}

export function insertUser(
  db: Db,
  input: { id: string; username: string; passwordHash: string; role: UserRole; displayName?: string | null; createdAt: number },
): UserRow {
  const row: UserRow = {
    id: input.id,
    username: input.username,
    passwordHash: input.passwordHash,
    displayName: input.displayName ?? null,
    role: input.role,
    status: "active",
    createdAt: input.createdAt,
    lastLoginAt: null,
  };
  db.insert(users).values(row).run();
  return row;
}
```

`apps/server/src/auth/bootstrap.ts`：

```ts
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { countUsers, findUserByUsername, insertUser } from "../db/repositories/users.js";
import { hashPassword } from "./password.js";

export async function bootstrapAdmin(db: Db, config: AppConfig): Promise<void> {
  if (countUsers(db) > 0) return;
  if (!config.adminPassword) {
    throw new Error("数据库为空且未设置 ADMIN_PASSWORD，无法创建管理员");
  }
  const existing = findUserByUsername(db, config.adminUsername);
  if (existing) return;
  insertUser(db, {
    id: randomUUID(),
    username: config.adminUsername,
    passwordHash: await hashPassword(config.adminPassword),
    role: "admin",
    displayName: "管理员",
    createdAt: Date.now(),
  });
}
```

（`auth/password.ts` 在 Task 3 创建；本 Task 结束前先创建它，见 Step 4。）

- [ ] **Step 4: 先写 password 模块，供 bootstrap 使用**

`apps/server/src/auth/password.ts`：

```ts
import { hash, verify } from "@node-rs/argon2";

export function hashPassword(password: string): Promise<string> {
  return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
```

- [ ] **Step 5: 写迁移测试**

`apps/server/test/db.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { countUsers } from "../src/db/repositories/users.js";
import { bootstrapAdmin } from "../src/auth/bootstrap.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir: "./data-test",
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  adminUsername: "admin",
  adminPassword: "admin-password",
  isProduction: false,
};

describe("database", () => {
  it("runs migrations and seeds one admin once", async () => {
    const { db } = createDb(":memory:");
    migrateDb(db);
    await bootstrapAdmin(db, config);
    await bootstrapAdmin(db, config);
    expect(countUsers(db)).toBe(1);
  });
});
```

- [ ] **Step 6: 生成迁移并跑测试**

Run:

```bash
pnpm --filter @datachat/server exec drizzle-kit generate
pnpm vitest run apps/server/test/db.test.ts
```

Expected: 生成 `apps/server/drizzle/0000_*.sql`；测试 `1 passed`。

- [ ] **Step 7: 接入启动流程**

`apps/server/src/index.ts` 改为：

```ts
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { migrateDb } from "./db/migrate.js";
import { bootstrapAdmin } from "./auth/bootstrap.js";
import fs from "node:fs";

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const { db } = createDb(config.dbPath);
migrateDb(db);
await bootstrapAdmin(db, config);
const app = await buildApp({ config, db });
await app.listen({ port: config.port, host: "0.0.0.0" });
```

`app.ts` 本步先接受可选的 `db`（Task 3 起使用）：

```ts
export interface BuildAppOptions {
  config: AppConfig;
  db?: import("./db/client.js").Db;
  enableRateLimit?: boolean;
}
```

`buildApp` 签名解构加上 `db` 但暂不使用（TS 会报未使用变量，用 `void db;` 或留到 Task 3）。本步直接改成：

```ts
export async function buildApp({ config, enableRateLimit = true }: BuildAppOptions): Promise<FastifyInstance> {
```

并删除 `db` 字段；Task 3 再加。

- [ ] **Step 8: 提交**

```bash
pnpm typecheck
git add -A
git commit -m "feat: add sqlite schema, migrations, and admin bootstrap"
```

---

## Task 3: 认证（密码、JWT、守卫、登录路由）

**Files:**
- Create: `apps/server/src/auth/jwt.ts`
- Create: `apps/server/src/auth/guard.ts`
- Create: `apps/server/src/types/fastify.d.ts`
- Create: `apps/server/src/routes/auth.ts`
- Create: `apps/server/test/auth.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: 写 JWT 与守卫**

`apps/server/src/auth/jwt.ts`：

```ts
import { SignJWT, jwtVerify } from "jose";
import type { UserRole } from "@datachat/shared";

export interface SessionPayload {
  sub: string;
  username: string;
  role: UserRole;
}

export function createSessionSigner(secret: string) {
  const key = new TextEncoder().encode(secret);

  return {
    sign(payload: SessionPayload): Promise<string> {
      return new SignJWT({ username: payload.username, role: payload.role })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(payload.sub)
        .setIssuedAt()
        .setExpirationTime("12h")
        .sign(key);
    },
    async verify(token: string): Promise<SessionPayload> {
      const { payload } = await jwtVerify(token, key);
      if (typeof payload.sub !== "string") throw new Error("missing sub");
      if (payload.role !== "admin" && payload.role !== "user") throw new Error("bad role");
      return {
        sub: payload.sub,
        username: typeof payload.username === "string" ? payload.username : "",
        role: payload.role,
      };
    },
  };
}

export type SessionSigner = ReturnType<typeof createSessionSigner>;
```

`apps/server/src/types/fastify.d.ts`：

```ts
import "fastify";
import type { SessionPayload } from "../auth/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionPayload;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
```

`apps/server/src/auth/guard.ts`：

```ts
import type { FastifyInstance } from "fastify";
import type { SessionSigner } from "./jwt.js";

export const SESSION_COOKIE = "dc_session";

export function registerAuthGuards(app: FastifyInstance, signer: SessionSigner): void {
  app.decorateRequest("user", undefined);

  app.decorate("authenticate", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
    }
    try {
      request.user = await signer.verify(token);
    } catch {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "登录已过期，请重新登录" } });
    }
  });

  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "需要管理员权限" } });
    }
  });
}
```

- [ ] **Step 2: 写登录路由**

`apps/server/src/routes/auth.ts`：

```ts
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { loginSchema } from "@datachat/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { findUserByUsername, toPublicUser } from "../db/repositories/users.js";
import { verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE } from "../auth/guard.js";
import type { SessionSigner } from "../auth/jwt.js";

export interface AuthRouteOptions {
  config: AppConfig;
  db: Db;
  signer: SessionSigner;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const { config, db, signer } = opts;

  app.post(
    "/api/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "VALIDATION", message: "用户名或密码格式不正确" } });
      }
      const user = findUserByUsername(db, parsed.data.username);
      if (!user || user.status !== "active") {
        return reply.code(401).send({ error: { code: "AUTH_FAILED", message: "用户名或密码错误" } });
      }
      const ok = await verifyPassword(user.passwordHash, parsed.data.password);
      if (!ok) {
        return reply.code(401).send({ error: { code: "AUTH_FAILED", message: "用户名或密码错误" } });
      }
      const token = await signer.sign({ sub: user.id, username: user.username, role: user.role });
      db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id)).run();
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProduction,
        path: "/",
        maxAge: 12 * 60 * 60,
      });
      return { user: toPublicUser(user) };
    },
  );

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => {
    const user = findUserByUsername(db, request.user!.username);
    if (!user) {
      return { user: null };
    }
    return { user: toPublicUser(user) };
  });

  // randomUUID 在后续任务使用
}
```

- [ ] **Step 3: 装配 app 并加 CSRF 检查**

`apps/server/src/app.ts` 改为：

```ts
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { registerAuthGuards } from "./auth/guard.js";
import { createSessionSigner } from "./auth/jwt.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  enableRateLimit?: boolean;
}

export async function buildApp({ config, db, enableRateLimit = true }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  const signer = createSessionSigner(config.appSecret);

  await app.register(cookie);
  if (enableRateLimit) {
    await app.register(rateLimit, { global: false });
  }

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (!origin) return;
    const host = request.headers.host;
    try {
      if (new URL(origin).host !== host) {
        return reply.code(403).send({ error: { code: "CSRF", message: "跨站请求被拒绝" } });
      }
    } catch {
      return reply.code(403).send({ error: { code: "CSRF", message: "非法 Origin" } });
    }
  });

  registerAuthGuards(app, signer);
  await app.register(healthRoutes);
  await app.register(authRoutes, { config, db, signer });
  return app;
}
```

`index.ts` 传入 `db`。

- [ ] **Step 4: 写认证测试**

`apps/server/test/auth.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { hashPassword } from "../src/auth/password.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir: "./data-test",
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  adminUsername: "admin",
  isProduction: false,
};

let db: Db;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  insertUser(db, {
    id: "u1",
    username: "alice",
    passwordHash: await hashPassword("correct-password"),
    role: "user",
    createdAt: Date.now(),
  });
});

describe("auth", () => {
  it("logs in and returns the current user", async () => {
    const app = await buildApp({ config, db, enableRateLimit: false });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "correct-password" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies[0];
    expect(cookie?.name).toBe("dc_session");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { dc_session: cookie!.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("alice");
    await app.close();
  });

  it("rejects wrong password and missing session", async () => {
    const app = await buildApp({ config, db, enableRateLimit: false });
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const me = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 5: 更新 health 测试、跑测试并提交**

Task 3 起 `buildApp` 必须传 `db`。把 `apps/server/test/health.test.ts` 的 `buildApp({ config, enableRateLimit: false })` 改为：

```ts
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";

const { db } = createDb(":memory:");
migrateDb(db);
const app = await buildApp({ config, db, enableRateLimit: false });
```

```bash
pnpm vitest run apps/server/test/health.test.ts apps/server/test/auth.test.ts
pnpm typecheck
git add -A
git commit -m "feat: add cookie auth with argon2 and jwt guard"
```

Expected: `3 passed`。

---

## Task 4: 用户管理与数据源授权 API

**Files:**
- Create: `apps/server/src/routes/admin-users.ts`
- Create: `apps/server/src/db/repositories/grants.ts`
- Create: `apps/server/test/admin-users.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: 写授权仓库**

`apps/server/src/db/repositories/grants.ts`：

```ts
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "../client.js";
import { datasourceGrants } from "../schema.js";

export function listGrantedUserIds(db: Db, datasourceId: string): string[] {
  return db
    .select({ userId: datasourceGrants.userId })
    .from(datasourceGrants)
    .where(eq(datasourceGrants.datasourceId, datasourceId))
    .all()
    .map((row) => row.userId);
}

export function replaceGrants(db: Db, datasourceId: string, userIds: string[]): void {
  db.delete(datasourceGrants).where(eq(datasourceGrants.datasourceId, datasourceId)).run();
  for (const userId of [...new Set(userIds)]) {
    db.insert(datasourceGrants)
      .values({ id: randomUUID(), datasourceId, userId, createdAt: Date.now() })
      .run();
  }
}

export function userCanAccessDatasource(db: Db, userId: string, datasourceId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const row = db
    .select({ id: datasourceGrants.id })
    .from(datasourceGrants)
    .where(and(eq(datasourceGrants.datasourceId, datasourceId), eq(datasourceGrants.userId, userId)))
    .get();
  return Boolean(row);
}
```

- [ ] **Step 2: 写管理员路由**

`apps/server/src/routes/admin-users.ts`：

```ts
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { insertUser, toPublicUser } from "../db/repositories/users.js";
import { hashPassword } from "../auth/password.js";
import { listGrantedUserIds, replaceGrants } from "../db/repositories/grants.js";

const createUserSchema = z.object({
  username: z.string().trim().min(2).max(64),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().max(64).optional(),
  role: z.enum(["admin", "user"]).default("user"),
});

const updateUserSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  password: z.string().min(8).max(200).optional(),
});

export async function adminUserRoutes(app: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;

  app.get("/api/admin/users", { preHandler: app.requireAdmin }, async () => {
    const rows = db.select().from(users).all();
    return { users: rows.map((row) => toPublicUser(row)) };
  });

  app.post("/api/admin/users", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法", details: parsed.error.flatten() } });
    }
    const exists = db.select({ id: users.id }).from(users).where(eq(users.username, parsed.data.username)).get();
    if (exists) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: "用户名已存在" } });
    }
    const row = insertUser(db, {
      id: randomUUID(),
      username: parsed.data.username,
      passwordHash: await hashPassword(parsed.data.password),
      role: parsed.data.role,
      displayName: parsed.data.displayName ?? null,
      createdAt: Date.now(),
    });
    return reply.code(201).send({ user: toPublicUser(row) });
  });

  app.patch("/api/admin/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = updateUserSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const target = db.select().from(users).where(eq(users.id, params.data.id)).get();
    if (!target) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "用户不存在" } });
    }
    db.update(users)
      .set({
        role: body.data.role ?? target.role,
        status: body.data.status ?? target.status,
        passwordHash: body.data.password ? await hashPassword(body.data.password) : target.passwordHash,
      })
      .where(eq(users.id, target.id))
      .run();
    const updated = db.select().from(users).where(eq(users.id, target.id)).get()!;
    return { user: toPublicUser(updated) };
  });

  app.get("/api/admin/datasources/:id/grants", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    return { userIds: listGrantedUserIds(db, params.data.id) };
  });

  app.put("/api/admin/datasources/:id/grants", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ userIds: z.array(z.string().uuid()) }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    replaceGrants(db, params.data.id, body.data.userIds);
    return { ok: true };
  });
}
```

- [ ] **Step 3: 注册路由并写测试**

`app.ts` 加：

```ts
await app.register(adminUserRoutes, { db });
```

`apps/server/test/admin-users.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir: "./data-test",
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  adminUsername: "admin",
  isProduction: false,
};

let db: Db;
let adminCookie: string;
let userCookie: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  insertUser(db, { id: "u-admin", username: "root", passwordHash: await hashPassword("admin-pass"), role: "admin", createdAt: Date.now() });
  insertUser(db, { id: "u-user", username: "bob", passwordHash: await hashPassword("user-pass"), role: "user", createdAt: Date.now() });
  const signer = createSessionSigner(config.appSecret);
  adminCookie = await signer.sign({ sub: "u-admin", username: "root", role: "admin" });
  userCookie = await signer.sign({ sub: "u-user", username: "bob", role: "user" });
});

function app() {
  return buildApp({ config, db, enableRateLimit: false });
}

describe("admin users", () => {
  it("lists users for admin only", async () => {
    const a = await app();
    const ok = await a.inject({ method: "GET", url: "/api/admin/users", cookies: { dc_session: adminCookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().users).toHaveLength(2);

    const denied = await a.inject({ method: "GET", url: "/api/admin/users", cookies: { dc_session: userCookie } });
    expect(denied.statusCode).toBe(403);
    await a.close();
  });

  it("creates a user and replaces grants", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { dc_session: adminCookie },
      payload: { username: "carol", password: "carol-pass-123", role: "user" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().user.id;

    const granted = await a.inject({
      method: "PUT",
      url: `/api/admin/datasources/ds-1/grants`,
      cookies: { dc_session: adminCookie },
      payload: { userIds: [id] },
    });
    expect(granted.statusCode).toBe(200);

    const list = await a.inject({
      method: "GET",
      url: `/api/admin/datasources/ds-1/grants`,
      cookies: { dc_session: adminCookie },
    });
    expect(list.json().userIds).toEqual([id]);
    await a.close();
  });
});
```

- [ ] **Step 4: 跑测试并提交**

```bash
pnpm vitest run apps/server/test/admin-users.test.ts
pnpm typecheck
git add -A
git commit -m "feat: add user admin and datasource grant APIs"
```

Expected: `2 passed`。

---

## Task 5: 数据源加密、CRUD 与连接测试

**Files:**
- Create: `apps/server/src/agent/datasource/crypto.ts`
- Create: `apps/server/src/agent/datasource/pool.ts`
- Create: `apps/server/src/agent/datasource/probe.ts`
- Create: `apps/server/src/db/repositories/datasources.ts`
- Create: `apps/server/src/routes/datasources.ts`
- Create: `apps/server/test/datasource.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: 写加解密与池注册**

`apps/server/src/agent/datasource/crypto.ts`：

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function deriveSecretKey(appSecret: string): Buffer {
  return scryptSync(appSecret, "datachat-db-v1", 32);
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = value.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("unsupported secret format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("invalid secret");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
```

`apps/server/src/agent/datasource/pool.ts`：

```ts
import mysql, { type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import type { DatasourceType } from "@datachat/shared";

export interface DatasourceConnection {
  id: string;
  type: DatasourceType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: "disable" | "require";
}

export interface Pools {
  mysql?: MysqlPool;
  pg?: PgPool;
}

export class PoolRegistry {
  private pools = new Map<string, Pools>();

  get(ds: DatasourceConnection): Pools {
    const existing = this.pools.get(ds.id);
    if (existing) return existing;

    const pools: Pools = {};
    if (ds.type === "mysql") {
      const pool = mysql.createPool({
        host: ds.host,
        port: ds.port,
        database: ds.database,
        user: ds.username,
        password: ds.password,
        connectionLimit: 5,
        connectTimeout: 10_000,
        timezone: "Z",
        supportBigNumbers: true,
        ssl: ds.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
      });
      pool.on("connection", (connection) => {
        connection.query("SET SESSION TRANSACTION READ ONLY");
        connection.query("SET SESSION time_zone = '+00:00'");
      });
      pools.mysql = pool;
    } else {
      const pool = new PgPool({
        host: ds.host,
        port: ds.port,
        database: ds.database,
        user: ds.username,
        password: ds.password,
        max: 5,
        statement_timeout: 30_000,
        ssl: ds.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
      });
      pool.on("connect", (client) => {
        client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
        client.query("SET TIME ZONE 'UTC'");
      });
      pools.pg = pool;
    }
    this.pools.set(ds.id, pools);
    return pools;
  }

  async closeAll(): Promise<void> {
    for (const pools of this.pools.values()) {
      await pools.mysql?.end().catch(() => undefined);
      await pools.pg?.end().catch(() => undefined);
    }
    this.pools.clear();
  }
}
```

- [ ] **Step 2: 写连接探测**

`apps/server/src/agent/datasource/probe.ts`：

```ts
import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import type { DatasourceType } from "@datachat/shared";

export interface ProbeInput {
  type: DatasourceType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: "disable" | "require";
}

export interface ProbeResult {
  ok: boolean;
  serverVersion?: string;
  readOnly: boolean;
  warnings: string[];
  error?: string;
}

export async function probeDatasource(input: ProbeInput): Promise<ProbeResult> {
  if (input.type === "mysql") {
    let connection: mysql.Connection | undefined;
    try {
      connection = await mysql.createConnection({
        host: input.host,
        port: input.port,
        database: input.database,
        user: input.username,
        password: input.password,
        connectTimeout: 10_000,
        ssl: input.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
      });
      const [versionRows] = await connection.query("SELECT VERSION() AS version");
      const version = String((versionRows as Array<{ version: string }>)[0]?.version ?? "unknown");
      const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
      const grants = (grantRows as Array<Record<string, string>>)
        .flatMap((row) => Object.values(row))
        .join(" ");
      const writeGrant = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(grants);
      const warnings = writeGrant ? ["当前账号具有写权限，建议改用只读账号"] : [];
      return { ok: true, serverVersion: version, readOnly: !writeGrant, warnings };
    } catch (error) {
      return { ok: false, readOnly: false, warnings: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
      await connection?.end().catch(() => undefined);
    }
  }

  const client = new PgClient({
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.username,
    password: input.password,
    connectionTimeoutMillis: 10_000,
    ssl: input.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.connect();
    const version = String((await client.query("SELECT version() AS version")).rows[0]?.version ?? "unknown");
    const readOnlyRow = await client.query("SHOW default_transaction_read_only");
    const canCreate = await client.query("SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create");
    const defaultReadOnly = String(readOnlyRow.rows[0]?.default_transaction_read_only ?? "off") === "on";
    const writeGrant = Boolean(canCreate.rows[0]?.can_create);
    const warnings = writeGrant ? ["当前账号具有建表权限，建议改用只读账号"] : [];
    return { ok: true, serverVersion: version, readOnly: defaultReadOnly && !writeGrant, warnings };
  } catch (error) {
    return { ok: false, readOnly: false, warnings: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
```

- [ ] **Step 3: 写数据源仓库**

`apps/server/src/db/repositories/datasources.ts`：

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import { datasourceGrants, datasources } from "../schema.js";
import type { DatasourceType } from "@datachat/shared";

export interface DatasourceRow {
  id: string;
  name: string;
  type: DatasourceType;
  host: string;
  port: number;
  database: string;
  username: string;
  passwordCipher: string;
  sslMode: "disable" | "require";
  readOnlyVerified: number;
  status: string;
  lastCheckedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export function insertDatasource(db: Db, row: DatasourceRow): void {
  db.insert(datasources).values(row).run();
}

export function updateDatasource(db: Db, id: string, patch: Partial<DatasourceRow>): void {
  db.update(datasources).set({ ...patch, updatedAt: Date.now() }).where(eq(datasources.id, id)).run();
}

export function findDatasource(db: Db, id: string): DatasourceRow | undefined {
  return db.select().from(datasources).where(eq(datasources.id, id)).get() as DatasourceRow | undefined;
}

export function listDatasourcesForUser(db: Db, userId: string, isAdmin: boolean): DatasourceRow[] {
  if (isAdmin) {
    return db.select().from(datasources).all() as DatasourceRow[];
  }
  const granted = db
    .select({ id: datasourceGrants.datasourceId })
    .from(datasourceGrants)
    .where(eq(datasourceGrants.userId, userId))
    .all()
    .map((row) => row.id);
  if (granted.length === 0) return [];
  return db.select().from(datasources).where(inArray(datasources.id, granted)).all() as DatasourceRow[];
}

export function userCanAccess(db: Db, userId: string, datasourceId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return Boolean(
    db
      .select({ id: datasourceGrants.id })
      .from(datasourceGrants)
      .where(and(eq(datasourceGrants.datasourceId, datasourceId), eq(datasourceGrants.userId, userId)))
      .get(),
  );
}
```

- [ ] **Step 4: 写路由（含测试连接）**

`apps/server/src/routes/datasources.ts`：

```ts
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { datasourceInputSchema } from "@datachat/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { datasources } from "../db/schema.js";
import {
  findDatasource,
  insertDatasource,
  listDatasourcesForUser,
  updateDatasource,
} from "../db/repositories/datasources.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../agent/datasource/crypto.js";
import { probeDatasource } from "../agent/datasource/probe.js";

export interface DatasourceRouteOptions {
  config: AppConfig;
  db: Db;
}

const updateSchema = datasourceInputSchema.partial().extend({
  name: z.string().trim().min(1).max(64).optional(),
});

export async function datasourceRoutes(app: FastifyInstance, opts: DatasourceRouteOptions): Promise<void> {
  const { config, db } = opts;
  const key = deriveSecretKey(config.appSecret);

  app.get("/api/datasources", { preHandler: app.authenticate }, async (request) => {
    const rows = listDatasourcesForUser(db, request.user!.sub, request.user!.role === "admin");
    return {
      datasources: rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        host: row.host,
        port: row.port,
        database: row.database,
        username: row.username,
        sslMode: row.sslMode,
        status: row.status,
        readOnlyVerified: Boolean(row.readOnlyVerified),
        lastCheckedAt: row.lastCheckedAt,
      })),
    };
  });

  app.post("/api/datasources", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = datasourceInputSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.password) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "缺少必要参数" } });
    }
    const probe = await probeDatasource({
      type: parsed.data.type,
      host: parsed.data.host,
      port: parsed.data.port,
      database: parsed.data.database,
      username: parsed.data.username,
      password: parsed.data.password,
      sslMode: parsed.data.sslMode,
    });
    if (!probe.ok) {
      return reply.code(400).send({ error: { code: "DS_UNREACHABLE", message: probe.error ?? "连接失败" } });
    }
    const id = randomUUID();
    const now = Date.now();
    insertDatasource(db, {
      id,
      name: parsed.data.name,
      type: parsed.data.type,
      host: parsed.data.host,
      port: parsed.data.port,
      database: parsed.data.database,
      username: parsed.data.username,
      passwordCipher: encryptSecret(parsed.data.password, key),
      sslMode: parsed.data.sslMode,
      readOnlyVerified: probe.readOnly ? 1 : 0,
      status: "ok",
      lastCheckedAt: now,
      createdBy: request.user!.sub,
      createdAt: now,
      updatedAt: now,
    });
    return reply.code(201).send({ id, warnings: probe.warnings, readOnly: probe.readOnly });
  });

  app.patch("/api/datasources/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    }
    const existing = findDatasource(db, params.data.id);
    if (!existing) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });

    const patch: Record<string, unknown> = {
      name: body.data.name ?? existing.name,
      host: body.data.host ?? existing.host,
      port: body.data.port ?? existing.port,
      database: body.data.database ?? existing.database,
      username: body.data.username ?? existing.username,
      sslMode: body.data.sslMode ?? existing.sslMode,
    };
    if (body.data.password) {
      patch.passwordCipher = encryptSecret(body.data.password, key);
    }
    updateDatasource(db, existing.id, patch);
    return { ok: true };
  });

  app.delete("/api/datasources/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    const existing = findDatasource(db, params.data.id);
    if (!existing) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });
    db.delete(datasources).where(eq(datasources.id, existing.id)).run();
    return { ok: true };
  });

  app.post("/api/datasources/:id/test", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    const ds = findDatasource(db, params.data.id);
    if (!ds) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });

    const probe = await probeDatasource({
      type: ds.type,
      host: ds.host,
      port: ds.port,
      database: ds.database,
      username: ds.username,
      password: decryptSecret(ds.passwordCipher, key),
      sslMode: ds.sslMode,
    });
    updateDatasource(db, ds.id, {
      status: probe.ok ? "ok" : "error",
      lastCheckedAt: Date.now(),
      readOnlyVerified: probe.readOnly ? 1 : 0,
    });
    return probe;
  });
}
```

- [ ] **Step 5: 写单元测试（加密往返 + CRUD）**

`apps/server/test/datasource.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";

describe("datasource crypto", () => {
  it("round-trips a secret and rejects tampering", () => {
    const key = deriveSecretKey("test-secret-test-secret-test-secret-32");
    const cipher = encryptSecret("p@ssw0rd:with:colons", key);
    expect(cipher.startsWith("v1:")).toBe(true);
    expect(decryptSecret(cipher, key)).toBe("p@ssw0rd:with:colons");

    const tampered = cipher.slice(0, -4) + "AAAA";
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("produces different ciphertexts for the same input", () => {
    const key = deriveSecretKey("test-secret-test-secret-test-secret-32");
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });
});
```

- [ ] **Step 6: 注册路由，跑测试并提交**

`app.ts` 加：

```ts
await app.register(datasourceRoutes, { config, db });
```

```bash
pnpm vitest run apps/server/test/datasource.test.ts
pnpm typecheck
git add -A
git commit -m "feat: add datasource crud with encrypted credentials and probing"
```

Expected: `2 passed`。

---

## Task 6: Schema 反射与缓存

**Files:**
- Create: `apps/server/src/agent/datasource/introspect.ts`
- Create: `apps/server/src/db/repositories/schema-cache.ts`
- Create: `apps/server/src/routes/datasource-schema.ts`
- Create: `apps/server/test/introspect.integration.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: 写反射类型与 MySQL 实现**

`apps/server/src/agent/datasource/introspect.ts`：

```ts
import type { Pool as MysqlPool } from "mysql2/promise";
import type { Pool as PgPool } from "pg";

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string | null;
}

export interface SchemaIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface SchemaForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface SchemaTable {
  schema: string;
  name: string;
  comment: string | null;
  columns: SchemaColumn[];
  primaryKey: string[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
}

export interface SchemaSnapshot {
  tables: SchemaTable[];
  refreshedAt: number;
}

export async function introspectMysql(pool: MysqlPool, database: string): Promise<SchemaSnapshot> {
  const [tableRows] = await pool.query(
    `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_NAME`,
    [database],
  );
  const [columnRows] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [database],
  );
  const [indexRows] = await pool.query(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [database],
  );
  const [fkRows] = await pool.query(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [database],
  );

  const tables = new Map<string, SchemaTable>();
  for (const row of tableRows as Array<{ TABLE_NAME: string; TABLE_SCHEMA: string; TABLE_COMMENT: string }>) {
    tables.set(row.TABLE_NAME, {
      schema: row.TABLE_SCHEMA,
      name: row.TABLE_NAME,
      comment: row.TABLE_COMMENT || null,
      columns: [],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    });
  }
  for (const row of columnRows as Array<Record<string, string>>) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    table.columns.push({
      name: row.COLUMN_NAME,
      type: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === "YES",
      defaultValue: row.COLUMN_DEFAULT ?? null,
      comment: row.COLUMN_COMMENT || null,
    });
  }
  for (const row of indexRows as Array<Record<string, string>>) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    let index = table.indexes.find((item) => item.name === row.INDEX_NAME);
    if (!index) {
      index = { name: row.INDEX_NAME, unique: row.NON_UNIQUE === "0", columns: [] };
      table.indexes.push(index);
    }
    index.columns.push(row.COLUMN_NAME);
    if (row.INDEX_NAME === "PRIMARY") table.primaryKey.push(row.COLUMN_NAME);
  }
  for (const row of fkRows as Array<Record<string, string>>) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    let fk = table.foreignKeys.find((item) => item.name === row.CONSTRAINT_NAME);
    if (!fk) {
      fk = { name: row.CONSTRAINT_NAME, columns: [], referencedTable: row.REFERENCED_TABLE_NAME, referencedColumns: [] };
      table.foreignKeys.push(fk);
    }
    fk.columns.push(row.COLUMN_NAME);
    fk.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
  }
  return { tables: [...tables.values()], refreshedAt: Date.now() };
}

export async function introspectPostgres(pool: PgPool): Promise<SchemaSnapshot> {
  const tableResult = await pool.query(`
    SELECT n.nspname AS schema, c.relname AS name, obj_description(c.oid) AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','v','m','p')
      AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY n.nspname, c.relname
  `);
  const columnResult = await pool.query(`
    SELECT table_schema AS schema, table_name AS name, column_name AS column_name,
           data_type AS data_type, is_nullable AS is_nullable, column_default AS column_default,
           col_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, ordinal_position) AS comment
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  `);
  const pkResult = await pool.query(`
    SELECT tc.table_schema AS schema, tc.table_name AS name, kcu.column_name AS column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
  `);
  const fkResult = await pool.query(`
    SELECT tc.table_schema AS schema, tc.table_name AS name, tc.constraint_name AS constraint_name,
           kcu.column_name AS column_name, ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
  `);
  const indexResult = await pool.query(`
    SELECT n.nspname AS schema, t.relname AS name, i.relname AS index_name, ix.indisunique AS is_unique,
           a.attname AS column_name
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY n.nspname, t.relname, i.relname, k.ord
  `);

  const tables = new Map<string, SchemaTable>();
  for (const row of tableResult.rows) {
    tables.set(`${row.schema}.${row.name}`, {
      schema: row.schema,
      name: row.name,
      comment: row.comment ?? null,
      columns: [],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    });
  }
  for (const row of columnResult.rows) {
    const table = tables.get(`${row.schema}.${row.name}`);
    if (!table) continue;
    table.columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
      defaultValue: row.column_default,
      comment: row.comment ?? null,
    });
  }
  for (const row of pkResult.rows) {
    tables.get(`${row.schema}.${row.name}`)?.primaryKey.push(row.column_name);
  }
  for (const row of fkResult.rows) {
    const table = tables.get(`${row.schema}.${row.name}`);
    if (!table) continue;
    let fk = table.foreignKeys.find((item) => item.name === row.constraint_name);
    if (!fk) {
      fk = { name: row.constraint_name, columns: [], referencedTable: row.referenced_table, referencedColumns: [] };
      table.foreignKeys.push(fk);
    }
    fk.columns.push(row.column_name);
    fk.referencedColumns.push(row.referenced_column);
  }
  for (const row of indexResult.rows) {
    const table = tables.get(`${row.schema}.${row.name}`);
    if (!table) continue;
    let index = table.indexes.find((item) => item.name === row.index_name);
    if (!index) {
      index = { name: row.index_name, unique: Boolean(row.is_unique), columns: [] };
      table.indexes.push(index);
    }
    index.columns.push(row.column_name);
  }
  return { tables: [...tables.values()], refreshedAt: Date.now() };
}
```

- [ ] **Step 2: 写缓存仓库与路由**

`apps/server/src/db/repositories/schema-cache.ts`：

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { datasourceSchemaCache } from "../schema.js";
import type { SchemaSnapshot } from "../../agent/datasource/introspect.js";

export function saveSchema(db: Db, datasourceId: string, snapshot: SchemaSnapshot): void {
  const payloadJson = JSON.stringify(snapshot);
  db.insert(datasourceSchemaCache)
    .values({
      datasourceId,
      payloadJson,
      tableCount: snapshot.tables.length,
      refreshedAt: snapshot.refreshedAt,
      error: null,
    })
    .onConflictDoUpdate({
      target: datasourceSchemaCache.datasourceId,
      set: { payloadJson, tableCount: snapshot.tables.length, refreshedAt: snapshot.refreshedAt, error: null },
    })
    .run();
}

export function loadSchema(db: Db, datasourceId: string): SchemaSnapshot | null {
  const row = db.select().from(datasourceSchemaCache).where(eq(datasourceSchemaCache.datasourceId, datasourceId)).get();
  if (!row) return null;
  return JSON.parse(row.payloadJson) as SchemaSnapshot;
}
```

`apps/server/src/routes/datasource-schema.ts`：

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import { findDatasource } from "../db/repositories/datasources.js";
import { loadSchema, saveSchema } from "../db/repositories/schema-cache.js";
import { userCanAccess } from "../db/repositories/datasources.js";
import { decryptSecret, deriveSecretKey } from "../agent/datasource/crypto.js";
import { PoolRegistry } from "../agent/datasource/pool.js";
import { introspectMysql, introspectPostgres } from "../agent/datasource/introspect.js";

export async function datasourceSchemaRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig; db: Db; pools: PoolRegistry },
): Promise<void> {
  const { config, db, pools } = opts;
  const key = deriveSecretKey(config.appSecret);

  app.post("/api/datasources/:id/refresh-schema", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    const ds = findDatasource(db, params.data.id);
    if (!ds) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });

    const connection = {
      id: ds.id,
      type: ds.type,
      host: ds.host,
      port: ds.port,
      database: ds.database,
      username: ds.username,
      password: decryptSecret(ds.passwordCipher, key),
      sslMode: ds.sslMode,
    };
    const handle = pools.get(connection);
    try {
      const snapshot =
        ds.type === "mysql"
          ? await introspectMysql(handle.mysql!, ds.database)
          : await introspectPostgres(handle.pg!);
      saveSchema(db, ds.id, snapshot);
      return { tableCount: snapshot.tables.length, refreshedAt: snapshot.refreshedAt };
    } catch (error) {
      return reply.code(502).send({
        error: { code: "DS_UNREACHABLE", message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  app.get("/api/datasources/:id/schema", { preHandler: app.authenticate }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
    if (!userCanAccess(db, request.user!.sub, params.data.id, request.user!.role === "admin")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "无权访问该数据源" } });
    }
    const snapshot = loadSchema(db, params.data.id);
    if (!snapshot) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "尚未缓存 schema" } });
    const search = String((request.query as { search?: string }).search ?? "").toLowerCase();
    const tables = (search
      ? snapshot.tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(search))
      : snapshot.tables
    ).slice(0, 50);
    return { tables, refreshedAt: snapshot.refreshedAt, total: snapshot.tables.length };
  });
}
```

- [ ] **Step 3: 写集成测试（Docker）**

`apps/server/test/introspect.integration.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import mysql from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { introspectMysql, introspectPostgres } from "../src/agent/datasource/introspect.js";

const run = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!run)("schema introspection", () => {
  it("reads mysql tables, columns, pk and fk", async () => {
    const container = await new MySqlContainer("mysql:8.0").start();
    const pool = mysql.createPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getUserPassword(),
    });
    await pool.query("CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL COMMENT '姓名')");
    await pool.query("CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, amount DECIMAL(10,2), CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id))");
    const snapshot = await introspectMysql(pool, container.getDatabase());
    const names = snapshot.tables.map((t) => t.name).sort();
    expect(names).toEqual(["orders", "users"]);
    const users = snapshot.tables.find((t) => t.name === "users")!;
    expect(users.columns.find((c) => c.name === "name")?.comment).toBe("姓名");
    expect(users.primaryKey).toEqual(["id"]);
    expect(snapshot.tables.find((t) => t.name === "orders")?.foreignKeys[0]?.referencedTable).toBe("users");
    await pool.end();
    await container.stop();
  });

  it("reads postgres tables and columns", async () => {
    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = new PgPool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL)");
    const snapshot = await introspectPostgres(pool);
    const users = snapshot.tables.find((t) => t.name === "users")!;
    expect(users.columns.map((c) => c.name)).toContain("name");
    expect(users.primaryKey).toContain("id");
    await pool.end();
    await container.stop();
  });
});
```

- [ ] **Step 4: 注册路由、装配池、跑测试**

`app.ts` 在 `buildApp` 内部创建池与 artifact store（避免每个测试自己装配），并注册路由：

```ts
import path from "node:path";
import { PoolRegistry } from "./agent/datasource/pool.js";
import { ArtifactStore } from "./services/artifacts.js";
import { datasourceSchemaRoutes } from "./routes/datasource-schema.js";

const pools = new PoolRegistry();
const artifacts = new ArtifactStore(db, path.join(config.dataDir, "artifacts"));
await artifacts.init();
await app.register(datasourceSchemaRoutes, { config, db, pools });
app.addHook("onClose", async () => pools.closeAll());
```

`BuildAppOptions` 不变；`index.ts` 不需修改。

```bash
pnpm vitest run apps/server/test/introspect.integration.test.ts   # 无 Docker 时 skipped
RUN_DB_TESTS=1 pnpm vitest run apps/server/test/introspect.integration.test.ts
pnpm typecheck
git add -A
git commit -m "feat: add schema introspection and cache"
```

Expected: 无 Docker `2 skipped`；有 Docker `2 passed`。

---

## Task 7: SQL 守卫与语料测试

**Files:**
- Create: `apps/server/src/agent/sql/guard.ts`
- Create: `apps/server/test/sql/guard.test.ts`

- [ ] **Step 1: 写守卫实现**

`apps/server/src/agent/sql/guard.ts`：

```ts
import { Parser } from "node-sql-parser";

export type SqlDialect = "mysql" | "postgres";
export type GuardErrorCode =
  | "EMPTY"
  | "PARSE_ERROR"
  | "FORBIDDEN_STATEMENT"
  | "FORBIDDEN_CONSTRUCT"
  | "LIMIT_TOO_LARGE"
  | "TOO_MANY_TABLES";

export type GuardResult =
  | { ok: true; sql: string }
  | { ok: false; code: GuardErrorCode; reason: string };

const parser = new Parser();

const ALLOWED_ROOT = new Set(["select", "show", "desc", "explain"]);
const FORBIDDEN_STATEMENTS = new Set([
  "insert", "update", "delete", "replace", "create", "drop", "alter", "truncate",
  "grant", "revoke", "call", "set", "use", "lock", "unlock", "rename", "analyze",
  "vacuum", "attach", "detach", "pragma", "copy", "merge",
]);
const FORBIDDEN_FUNCTIONS = new Set([
  "sleep", "benchmark", "load_file", "pg_sleep", "pg_read_file",
  "pg_read_binary_file", "pg_ls_dir", "dblink", "lo_import", "lo_export",
  "pg_terminate_backend", "pg_cancel_backend",
]);

export interface GuardInput {
  sql: string;
  dialect: SqlDialect;
  maxRows: number;
  maxTables?: number;
}

export function guardSql({ sql, dialect, maxRows, maxTables = 20 }: GuardInput): GuardResult {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) return { ok: false, code: "EMPTY", reason: "SQL 为空" };
  if (trimmed.length > 100_000) {
    return { ok: false, code: "FORBIDDEN_CONSTRUCT", reason: "SQL 过长" };
  }

  let ast: unknown;
  try {
    ast = parser.astify(trimmed, { database: dialect === "mysql" ? "mysql" : "postgresql" });
  } catch (error) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      reason: `SQL 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (Array.isArray(ast)) {
    return { ok: false, code: "FORBIDDEN_STATEMENT", reason: "只允许单条语句" };
  }

  const root = ast as Record<string, unknown>;
  const rootType = String(root.type ?? "").toLowerCase();
  if (!ALLOWED_ROOT.has(rootType)) {
    return { ok: false, code: "FORBIDDEN_STATEMENT", reason: `不允许的语句类型：${rootType || "unknown"}` };
  }

  let violation: string | null = null;
  walk(ast, (node) => {
    if (violation) return;
    const type = String(node.type ?? "").toLowerCase();
    if (FORBIDDEN_STATEMENTS.has(type)) {
      violation = `包含禁止的语句：${type}`;
      return;
    }
    if (type === "function") {
      const name = functionName(node);
      if (name && FORBIDDEN_FUNCTIONS.has(name)) {
        violation = `禁止调用函数：${name}`;
        return;
      }
    }
    if (node.into) {
      violation = "禁止 SELECT INTO / OUTFILE";
      return;
    }
    if (node.locking_read) {
      violation = "禁止加锁读（FOR UPDATE / LOCK IN SHARE MODE）";
    }
  });

  if (violation) {
    return { ok: false, code: "FORBIDDEN_CONSTRUCT", reason: violation };
  }

  const from = root.from;
  if (Array.isArray(from) && from.length > maxTables) {
    return { ok: false, code: "TOO_MANY_TABLES", reason: `关联表数量超过 ${maxTables}` };
  }

  if (rootType === "select") {
    const limit = root.limit as { value?: unknown } | null | undefined;
    if (!limit) {
      return { ok: true, sql: `${trimmed}\nLIMIT ${maxRows + 1}` };
    }
    const value = lastNumericLimit(limit);
    if (value === null) {
      return { ok: false, code: "FORBIDDEN_CONSTRUCT", reason: "LIMIT 必须是数字常量" };
    }
    if (value > maxRows) {
      return { ok: false, code: "LIMIT_TOO_LARGE", reason: `LIMIT ${value} 超过上限 ${maxRows}` };
    }
  }

  return { ok: true, sql: trimmed };
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
    return;
  }
  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit, seen);
}

function functionName(node: Record<string, unknown>): string | null {
  const name = node.name as { name?: Array<{ value?: unknown }> } | undefined;
  const first = name?.name?.[0]?.value;
  return typeof first === "string" ? first.toLowerCase() : null;
}

function lastNumericLimit(limit: { value?: unknown }): number | null {
  const raw = limit.value;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const last = raw[raw.length - 1] as { value?: unknown };
  return typeof last.value === "number" ? last.value : null;
}
```

- [ ] **Step 2: 写语料测试（含 40+ 断言数据）**

`apps/server/test/sql/guard.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { guardSql, type SqlDialect } from "../../src/agent/sql/guard.js";

const MAX = 1000;

const allowed: Array<[string, SqlDialect]> = [
  ["SELECT id, name FROM users", "mysql"],
  ["SELECT id FROM users LIMIT 10", "mysql"],
  ["select count(*) from orders where created_at >= '2024-01-01'", "postgres"],
  ["WITH x AS (SELECT 1 AS n) SELECT n FROM x", "postgres"],
  ["SELECT a.id, b.total FROM a JOIN b ON a.id = b.a_id", "mysql"],
  ["SELECT * FROM t1 UNION SELECT * FROM t2", "postgres"],
  ["SHOW TABLES", "mysql"],
  ["DESC users", "mysql"],
  ["SELECT id FROM users WHERE name LIKE '%a%' ORDER BY id", "postgres"],
  ["SELECT COALESCE(sum(amount), 0) FROM orders", "mysql"],
];

const rejected: Array<[string, SqlDialect, string]> = [
  ["DELETE FROM users", "mysql", "FORBIDDEN_STATEMENT"],
  ["UPDATE users SET name = 'x'", "mysql", "FORBIDDEN_STATEMENT"],
  ["INSERT INTO users (id) VALUES (1)", "mysql", "FORBIDDEN_STATEMENT"],
  ["REPLACE INTO users (id) VALUES (1)", "mysql", "FORBIDDEN_STATEMENT"],
  ["DROP TABLE users", "mysql", "FORBIDDEN_STATEMENT"],
  ["CREATE TABLE x (id int)", "mysql", "FORBIDDEN_STATEMENT"],
  ["ALTER TABLE users ADD COLUMN age int", "mysql", "FORBIDDEN_STATEMENT"],
  ["TRUNCATE TABLE users", "mysql", "FORBIDDEN_STATEMENT"],
  ["GRANT SELECT ON *.* TO bob", "mysql", "FORBIDDEN_STATEMENT"],
  ["CALL do_something()", "mysql", "FORBIDDEN_STATEMENT"],
  ["SET autocommit = 0", "mysql", "FORBIDDEN_STATEMENT"],
  ["SELECT 1; DROP TABLE users", "mysql", "FORBIDDEN_STATEMENT"],
  ["SELECT * FROM users FOR UPDATE", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM users LOCK IN SHARE MODE", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT SLEEP(10)", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT BENCHMARK(1000000, MD5('a'))", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT LOAD_FILE('/etc/passwd')", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT pg_sleep(10)", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT pg_read_file('/etc/passwd')", "postgres", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * INTO OUTFILE '/tmp/x' FROM users", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["SELECT * FROM users LIMIT 999999", "mysql", "LIMIT_TOO_LARGE"],
  ["SELECT * FROM users LIMIT 10, 5000", "mysql", "LIMIT_TOO_LARGE"],
  ["SELECT * FROM users LIMIT ?", "mysql", "FORBIDDEN_CONSTRUCT"],
  ["", "mysql", "EMPTY"],
  ["   ", "mysql", "EMPTY"],
  ["SELECT * FROM " + Array.from({ length: 21 }, (_, i) => `t${i}`).join(", "), "mysql", "TOO_MANY_TABLES"],
];

describe("guardSql", () => {
  it.each(allowed)("allows %s (%s)", (sql, dialect) => {
    const result = guardSql({ sql, dialect, maxRows: MAX });
    expect(result.ok).toBe(true);
  });

  it.each(rejected)("rejects %s (%s)", (sql, dialect, code) => {
    const result = guardSql({ sql, dialect, maxRows: MAX });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("rejects VACUUM regardless of parser support", () => {
    const result = guardSql({ sql: "VACUUM", dialect: "postgres", maxRows: MAX });
    expect(result.ok).toBe(false);
  });

  it("appends a limit when missing", () => {
    const result = guardSql({ sql: "SELECT id FROM users", dialect: "mysql", maxRows: 100 });
    expect(result).toEqual({ ok: true, sql: "SELECT id FROM users\nLIMIT 101" });
  });

  it("keeps an existing safe limit", () => {
    const result = guardSql({ sql: "SELECT id FROM users LIMIT 5", dialect: "postgres", maxRows: 100 });
    expect(result).toEqual({ ok: true, sql: "SELECT id FROM users LIMIT 5" });
  });
});
```

- [ ] **Step 3: 跑测试并修正解析差异**

```bash
pnpm vitest run apps/server/test/sql/guard.test.ts
```

Expected: 全绿。若有少量方言解析差异（例如 `VACUUM` 可能抛 PARSE_ERROR），以实际解析器行为为准调整断言——**不允许**放宽为放行；只允许把错误码改成实际返回的拒绝码。

- [ ] **Step 4: 提交**

```bash
pnpm typecheck
git add -A
git commit -m "feat: add sql guard with allow/deny corpus"
```

---

## Task 8: 流式执行器、结果落盘与审计

**Files:**
- Create: `apps/server/src/services/artifacts.ts`
- Create: `apps/server/src/services/audit.ts`
- Create: `apps/server/src/agent/sql/executor.ts`
- Create: `apps/server/test/artifacts.test.ts`
- Create: `apps/server/test/sql/executor.integration.test.ts`

- [ ] **Step 1: 写 artifact store**

`apps/server/src/services/artifacts.ts`：

```ts
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createGzip } from "node:zlib";
import { randomUUID } from "node:crypto";
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

export class ResultWriter {
  readonly id = randomUUID();
  private readonly filePath: string;
  private readonly gzip = createGzip({ level: 6 });
  private readonly out: ReturnType<typeof createWriteStream>;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly input: { conversationId: string; runId: string | null },
  ) {
    this.filePath = path.join(dir, `${this.id}.jsonl.gz`);
    this.out = createWriteStream(this.filePath);
    this.gzip.pipe(this.out);
  }

  async write(row: unknown[]): Promise<void> {
    if (this.closed) throw new Error("artifact writer closed");
    const line = JSON.stringify(row) + "\n";
    if (!this.gzip.write(line)) {
      await new Promise<void>((resolve) => this.gzip.once("drain", () => resolve()));
    }
  }

  async finish(input: { columns: ColumnInfo[]; rowCount: number; truncated: boolean }): Promise<ArtifactMeta> {
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.out.once("finish", () => resolve());
      this.out.once("error", reject);
      this.gzip.once("error", reject);
      this.gzip.end();
    });
    this.db
      .insert(artifacts)
      .values({
        id: this.id,
        conversationId: this.input.conversationId,
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
    return { id: this.id, rowCount: input.rowCount, truncated: input.truncated };
  }

  async abort(): Promise<void> {
    this.closed = true;
    this.gzip.destroy();
    this.out.destroy();
  }
}

export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly rootDir: string,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  openResult(input: { conversationId: string; runId: string | null }): ResultWriter {
    return new ResultWriter(this.db, this.rootDir, input);
  }
}
```

- [ ] **Step 2: 写审计与执行器**

`apps/server/src/services/audit.ts`：

```ts
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { queryAudit } from "../db/schema.js";

export interface AuditInput {
  runId: string | null;
  conversationId: string | null;
  userId: string;
  datasourceId: string;
  action: "query" | "explain" | "export";
  sqlText: string;
  status: "ok" | "rejected" | "error" | "timeout";
  rowCount?: number;
  durationMs?: number;
  errorMessage?: string;
}

export function recordAudit(db: Db, input: AuditInput): string {
  const id = randomUUID();
  db.insert(queryAudit)
    .values({
      id,
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasourceId,
      action: input.action,
      sqlText: input.sqlText,
      sqlHash: createHash("sha256").update(input.sqlText).digest("hex"),
      status: input.status,
      rowCount: input.rowCount ?? null,
      durationMs: input.durationMs ?? null,
      errorMessage: input.errorMessage ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}
```

`apps/server/src/agent/sql/executor.ts`：

```ts
import type { Pool as MysqlPool } from "mysql2/promise";
import type { Pool as PgPool, QueryResult } from "pg";
import { Cursor } from "pg-cursor";
import type { ColumnInfo } from "../../services/artifacts.js";

export class SqlTimeoutError extends Error {
  constructor() {
    super("查询超时");
    this.name = "SqlTimeoutError";
  }
}

export class SqlAbortedError extends Error {
  constructor() {
    super("查询已取消");
    this.name = "SqlAbortedError";
  }
}

export interface ExecuteInput {
  dialect: "mysql" | "postgres";
  pool: MysqlPool | PgPool;
  sql: string;
  maxRows: number;
  previewRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  columns: ColumnInfo[];
  previewRows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

interface Batch {
  columns: ColumnInfo[];
  rows: unknown[][];
}

const BATCH_SIZE = 500;

export async function executeReadOnly(
  input: ExecuteInput,
  onRow: (row: unknown[]) => Promise<void>,
): Promise<ExecuteResult> {
  const started = Date.now();
  let columns: ColumnInfo[] = [];
  const previewRows: unknown[][] = [];
  let rowCount = 0;
  let truncated = false;

  const consume = async (batch: Batch): Promise<void> => {
    if (columns.length === 0) columns = batch.columns;
    for (const row of batch.rows) {
      if (rowCount >= input.maxRows) {
        truncated = true;
        return;
      }
      rowCount += 1;
      if (previewRows.length < input.previewRows) previewRows.push(row);
      await onRow(row);
    }
  };

  try {
    if (input.dialect === "mysql") {
      await streamMysql(input, consume, () => truncated || input.signal?.aborted === true);
    } else {
      await streamPostgres(input, consume, () => truncated || input.signal?.aborted === true);
    }
  } catch (error) {
    if (input.signal?.aborted) throw new SqlAbortedError();
    throw error;
  }

  return {
    columns: columns.map((column, index) => ({ ...column, type: inferType(previewRows, index) })),
    previewRows,
    rowCount,
    truncated,
    durationMs: Date.now() - started,
  };
}

async function streamMysql(
  input: ExecuteInput,
  onBatch: (batch: Batch) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  const pool = input.pool as MysqlPool;
  const connection = await pool.getConnection();
  let destroyed = false;
  try {
    await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.floor(input.timeoutMs)}`);
    const query = connection.query({ sql: input.sql, rowsAsArray: true });
    let columns: ColumnInfo[] = [];
    query.on("fields", (fields) => {
      columns = fields.map((field) => ({ name: field.name, type: "unknown" as const }));
    });
    const stream = query.stream({ highWaterMark: BATCH_SIZE });
    let rows: unknown[][] = [];
    for await (const row of stream as AsyncIterable<unknown[]>) {
      if (shouldStop()) {
        destroyed = true;
        connection.destroy();
        break;
      }
      rows.push(row);
      if (rows.length >= BATCH_SIZE) {
        await onBatch({ columns, rows });
        rows = [];
      }
    }
    if (rows.length > 0) await onBatch({ columns, rows });
  } finally {
    if (!destroyed) connection.release();
  }
}

async function streamPostgres(
  input: ExecuteInput,
  onBatch: (batch: Batch) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  const pool = input.pool as PgPool;
  const client = await pool.connect();
  const cursor = client.query(new Cursor(input.sql, [], { rowMode: "array" }));
  let destroyed = false;
  try {
    while (true) {
      if (shouldStop()) {
        destroyed = true;
        await cursor.close().catch(() => undefined);
        break;
      }
      const { rows, result } = await readCursor(cursor, BATCH_SIZE);
      if (rows.length === 0) break;
      const columns: ColumnInfo[] = result.fields.map((field) => ({ name: field.name, type: "unknown" }));
      await onBatch({ columns, rows });
      if (rows.length < BATCH_SIZE) break;
    }
  } finally {
    client.release(destroyed);
  }
}

function readCursor(cursor: Cursor, count: number): Promise<{ rows: unknown[][]; result: QueryResult }> {
  return new Promise((resolve, reject) => {
    cursor.read(count, (error: Error | null, rows: unknown[], result: QueryResult) => {
      if (error) reject(error);
      else resolve({ rows, result });
    });
  });
}

function inferType(rows: unknown[][], index: number): ColumnInfo["type"] {
  for (const row of rows) {
    const value = row[index];
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "bigint") return "number";
    if (typeof value === "boolean") return "boolean";
    if (value instanceof Date) return "date";
    if (typeof value === "object") return "json";
    return "string";
  }
  return "unknown";
}
```

- [ ] **Step 3: 写 artifact 单元测试**

`apps/server/test/artifacts.test.ts`：

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { artifacts } from "../src/db/schema.js";

describe("artifact store", () => {
  it("writes gzipped jsonl and inserts metadata", async () => {
    const { db } = createDb(":memory:");
    migrateDb(db);
    const dir = await mkdtemp(path.join(tmpdir(), "dc-artifacts-"));
    const store = new ArtifactStore(db, dir);
    await store.init();

    const writer = store.openResult({ conversationId: "c1", runId: "r1" });
    await writer.write([1, "a"]);
    await writer.write([2, null]);
    const meta = await writer.finish({ columns: [{ name: "id", type: "number" }, { name: "name", type: "string" }], rowCount: 2, truncated: false });

    const row = db.select().from(artifacts).all()[0]!;
    expect(row.id).toBe(meta.id);
    expect(row.rowCount).toBe(2);
    const content = gunzipSync(await readFile(path.join(dir, `${meta.id}.jsonl.gz`))).toString("utf8");
    expect(content).toBe('[1,"a"]\n[2,null]\n');
  });
});
```

- [ ] **Step 4: 写执行器集成测试**

`apps/server/test/sql/executor.integration.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import mysql from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { executeReadOnly } from "../../src/agent/sql/executor.js";

const run = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!run)("executeReadOnly", () => {
  it("streams mysql rows and caps at maxRows", async () => {
    const container = await new MySqlContainer("mysql:8.0").start();
    const pool = mysql.createPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      rowsAsArray: true,
    });
    await pool.query("CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20))");
    await pool.query("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')");

    const rows: unknown[][] = [];
    const result = await executeReadOnly(
      { dialect: "mysql", pool, sql: "SELECT * FROM t", maxRows: 2, previewRows: 10, timeoutMs: 5000 },
      async (row) => { rows.push(row); },
    );
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(rows).toHaveLength(2);
    await pool.end();
    await container.stop();
  });

  it("streams postgres rows with columns", async () => {
    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = new PgPool({ connectionString: container.getConnectionUri() });
    await pool.query("CREATE TABLE t (id int primary key, name text)");
    await pool.query("INSERT INTO t VALUES (1,'a'),(2,'b')");

    const rows: unknown[][] = [];
    const result = await executeReadOnly(
      { dialect: "postgres", pool, sql: "SELECT id, name FROM t ORDER BY id", maxRows: 100, previewRows: 10, timeoutMs: 5000 },
      async (row) => { rows.push(row); },
    );
    expect(result.rowCount).toBe(2);
    expect(result.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(result.columns[0]?.type).toBe("number");
    expect(rows[1]).toEqual([2, "b"]);
    await pool.end();
    await container.stop();
  });
});
```

- [ ] **Step 5: 跑测试并提交**

```bash
pnpm vitest run apps/server/test/artifacts.test.ts
RUN_DB_TESTS=1 pnpm vitest run apps/server/test/sql/executor.integration.test.ts
pnpm typecheck
git add -A
git commit -m "feat: add streaming sql executor and artifact storage"
```

Expected: artifact 测试 `1 passed`；集成测试 `2 passed`（无 Docker 时 skipped）。

---

## Task 9: 守卫 + 执行 + 审计编排

**Files:**
- Create: `apps/server/src/services/query-service.ts`
- Create: `apps/server/test/query-service.test.ts`
- Create: `apps/server/test/query-service.integration.test.ts`

- [ ] **Step 1: 写编排服务**

`apps/server/src/services/query-service.ts`：

```ts
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { findDatasource, type DatasourceRow } from "../db/repositories/datasources.js";
import { decryptSecret, deriveSecretKey } from "../agent/datasource/crypto.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import { guardSql, type GuardErrorCode } from "../agent/sql/guard.js";
import { SqlAbortedError, SqlTimeoutError, executeReadOnly } from "../agent/sql/executor.js";
import type { ArtifactStore, ColumnInfo } from "./artifacts.js";
import { recordAudit } from "./audit.js";

export interface RunQueryInput {
  datasource: DatasourceRow;
  userId: string;
  conversationId: string | null;
  runId: string | null;
  sql: string;
  action?: "query" | "explain";
  signal?: AbortSignal;
}

export type RunQueryResult =
  | {
      ok: true;
      artifactId: string;
      columns: ColumnInfo[];
      previewRows: unknown[][];
      rowCount: number;
      truncated: boolean;
      durationMs: number;
      auditId: string;
    }
  | { ok: false; code: GuardErrorCode | "SQL_ERROR" | "SQL_TIMEOUT" | "SQL_ABORTED"; reason: string; auditId: string };

export interface QueryServiceDeps {
  db: Db;
  config: AppConfig;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
}

export async function runGuardedQuery(deps: QueryServiceDeps, input: RunQueryInput): Promise<RunQueryResult> {
  const { db, config, pools, artifacts } = deps;
  const action = input.action ?? "query";
  const guard = guardSql({
    sql: input.sql,
    dialect: input.datasource.type,
    maxRows: config.queryMaxRows,
  });

  if (!guard.ok) {
    const auditId = recordAudit(db, {
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasource.id,
      action,
      sqlText: input.sql,
      status: "rejected",
      errorMessage: guard.reason,
    });
    return { ok: false, code: guard.code, reason: guard.reason, auditId };
  }

  const connection = {
    id: input.datasource.id,
    type: input.datasource.type,
    host: input.datasource.host,
    port: input.datasource.port,
    database: input.datasource.database,
    username: input.datasource.username,
    password: decryptSecret(input.datasource.passwordCipher, deriveSecretKey(config.appSecret)),
    sslMode: input.datasource.sslMode,
  };
  const handle = pools.get(connection);
  const started = Date.now();
  const writer = artifacts.openResult({ conversationId: input.conversationId ?? "adhoc", runId: input.runId });

  try {
    const result = await executeReadOnly(
      {
        dialect: input.datasource.type,
        pool: input.datasource.type === "mysql" ? handle.mysql! : handle.pg!,
        sql: guard.sql,
        maxRows: config.queryMaxRows,
        previewRows: config.queryPreviewRows,
        timeoutMs: config.queryTimeoutMs,
        signal: input.signal,
      },
      (row) => writer.write(row),
    );
    const meta = await writer.finish({
      columns: result.columns,
      rowCount: result.rowCount,
      truncated: result.truncated,
    });
    const auditId = recordAudit(db, {
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasource.id,
      action,
      sqlText: guard.sql,
      status: "ok",
      rowCount: result.rowCount,
      durationMs: Date.now() - started,
    });
    return {
      ok: true,
      artifactId: meta.id,
      columns: result.columns,
      previewRows: result.previewRows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      durationMs: Date.now() - started,
      auditId,
    };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    const timeout = error instanceof SqlTimeoutError || /timeout|MAX_EXECUTION_TIME/i.test(String(error));
    const aborted = error instanceof SqlAbortedError;
    const status = timeout ? "timeout" : aborted ? "error" : "error";
    const auditId = recordAudit(db, {
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasource.id,
      action,
      sqlText: guard.sql,
      status,
      durationMs: Date.now() - started,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      code: timeout ? "SQL_TIMEOUT" : aborted ? "SQL_ABORTED" : "SQL_ERROR",
      reason: error instanceof Error ? error.message : String(error),
      auditId,
    };
  }
}

export function loadDatasourceOrThrow(db: Db, id: string): DatasourceRow {
  const ds = findDatasource(db, id);
  if (!ds) throw new Error(`数据源不存在: ${id}`);
  return ds;
}
```

- [ ] **Step 2: 给 config 增加查询设置**

`apps/server/src/config.ts` 的 `AppConfig` 增加：

```ts
  queryMaxRows: number;
  queryPreviewRows: number;
  queryTimeoutMs: number;
```

`loadConfig` 的 env schema 增加：

```ts
  QUERY_MAX_ROWS: z.coerce.number().int().positive().default(100_000),
  QUERY_PREVIEW_ROWS: z.coerce.number().int().positive().default(200),
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
```

return 增加：

```ts
    queryMaxRows: parsed.QUERY_MAX_ROWS,
    queryPreviewRows: parsed.QUERY_PREVIEW_ROWS,
    queryTimeoutMs: parsed.QUERY_TIMEOUT_MS,
```

同步更新 `test/*.ts` 里所有 `AppConfig` 字面量，补这三项（建议在 `apps/server/test/helpers/config.ts` 建一份共享 fixture，下面 Step 3 使用）。

`apps/server/test/helpers/config.ts`：

```ts
import type { AppConfig } from "../../src/config.js";

export const testConfig: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir: "./data-test",
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  adminUsername: "admin",
  isProduction: false,
  queryMaxRows: 1000,
  queryPreviewRows: 200,
  queryTimeoutMs: 5000,
};
```

把现有测试中的 `config` 对象替换为 `import { testConfig as config } from "./helpers/config.js";`。

- [ ] **Step 3: 写拒绝路径测试**

`apps/server/test/query-service.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { recordAudit } from "../src/services/audit.js";
import { queryAudit } from "../src/db/schema.js";
import { testConfig as config } from "./helpers/config.js";

describe("audit", () => {
  it("hashes sql and persists rejected statements", () => {
    const { db } = createDb(":memory:");
    migrateDb(db);
    recordAudit(db, {
      runId: null,
      conversationId: null,
      userId: "u1",
      datasourceId: "d1",
      action: "query",
      sqlText: "DELETE FROM users",
      status: "rejected",
      errorMessage: "不允许的语句类型",
    });
    const row = db.select().from(queryAudit).all()[0]!;
    expect(row.status).toBe("rejected");
    expect(row.sqlHash).toHaveLength(64);
    expect(config.queryMaxRows).toBe(1000);
  });
});
```

（真正的编排拒绝路径在 Step 4 的集成测试里覆盖，避免重复造 pool。）

- [ ] **Step 4: 写编排集成测试（MySQL）**

`apps/server/test/query-service.integration.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MySqlContainer } from "@testcontainers/mysql";
import mysql from "mysql2/promise";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { PoolRegistry } from "../src/agent/datasource/pool.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import { runGuardedQuery } from "../src/services/query-service.js";
import { queryAudit } from "../src/db/schema.js";
import { testConfig as config } from "./helpers/config.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!run)("runGuardedQuery", () => {
  let container: Awaited<ReturnType<MySqlContainer["start"]>>;
  let mysqlPool: mysql.Pool;

  beforeAll(async () => {
    container = await new MySqlContainer("mysql:8.0").start();
    mysqlPool = mysql.createPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getUserPassword(),
    });
    await mysqlPool.query("CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20))");
    await mysqlPool.query("INSERT INTO t VALUES (1,'a'),(2,'b')");
  });

  afterAll(async () => {
    await mysqlPool?.end();
    await container?.stop();
  });

  it("executes a select, stores artifact, and audits both paths", async () => {
    const { db } = createDb(":memory:");
    migrateDb(db);
    const now = Date.now();
    insertDatasource(db, {
      id: "d1",
      name: "test",
      type: "mysql",
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      username: container.getUsername(),
      passwordCipher: encryptSecret(container.getUserPassword(), deriveSecretKey(config.appSecret)),
      sslMode: "disable",
      readOnlyVerified: 1,
      status: "ok",
      lastCheckedAt: now,
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });
    const dir = await mkdtemp(path.join(tmpdir(), "dc-q-"));
    const deps = {
      db,
      config,
      pools: new PoolRegistry(),
      artifacts: new ArtifactStore(db, dir),
    };
    await deps.artifacts.init();

    const ds = db.select().from((await import("../src/db/schema.js")).datasources).all()[0]!;
    const ok = await runGuardedQuery(deps, {
      datasource: ds,
      userId: "u1",
      conversationId: "c1",
      runId: null,
      sql: "SELECT * FROM t ORDER BY id",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.rowCount).toBe(2);
      expect(ok.columns[0]?.name).toBe("id");
    }

    const rejected = await runGuardedQuery(deps, {
      datasource: ds,
      userId: "u1",
      conversationId: "c1",
      runId: null,
      sql: "DELETE FROM t",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("FORBIDDEN_STATEMENT");

    const audits = db.select().from(queryAudit).all();
    expect(audits.map((a) => a.status).sort()).toEqual(["ok", "rejected"]);
    await deps.pools.closeAll();
  });
});
```

- [ ] **Step 5: 跑测试、类型检查、提交**

```bash
pnpm vitest run apps/server/test/query-service.test.ts
RUN_DB_TESTS=1 pnpm vitest run apps/server/test/query-service.integration.test.ts
pnpm typecheck
git add -A
git commit -m "feat: orchestrate guarded query execution with audit"
```

Expected: `1 passed` + `1 passed`。

---

## Task 10: 全量验证与 Plan 1 收尾

**Files:**
- Create: `docs/superpowers/plans/2026-11-06-datachat-01-foundation.md`（本文件已存在，不需重复创建）
- Modify: `apps/server/src/index.ts`（确保启动时 `artifacts.init()`）

- [ ] **Step 1: 确认启动与关闭**

`buildApp` 已在 Task 6 内部创建 `pools` 与 `artifacts` 并注册 `onClose`，本步只需确认 `index.ts` 在监听前创建 `dataDir`（Task 2 已加），并确认 `ArtifactStore.init()` 在 `buildApp` 内被 await。

无需再修改 `BuildAppOptions`；Plan 2 的 query 路由会从 `buildApp` 的闭包里拿到 `artifacts` 与 `pools`。

- [ ] **Step 2: 跑全量验证**

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected: typecheck 无错误；`pnpm test` 除 Docker 集成外全绿；build 生成 `apps/server/dist`。

- [ ] **Step 3: 手工启动冒烟**

```bash
cp .env.example .env
# 编辑 .env：APP_SECRET 填 32+ 字符，ADMIN_PASSWORD 填至少 8 位
pnpm --filter @datachat/server dev
```

另开终端：

```bash
curl -s http://127.0.0.1:8080/api/health
curl -s -c cookies.txt -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}'
curl -s -b cookies.txt http://127.0.0.1:8080/api/auth/me
```

Expected：health `{"ok":true,...}`；login 返回 `{"user":{...role:"admin"}}`；me 返回同一用户。

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "chore: complete foundation plan verification"
git log --oneline -5
```

---

## 自检（写完计划后执行）

- **Spec 覆盖检查（Plan 1 范围）**
  - §6 数据模型 → Task 2 全表 + 迁移。
  - §7.1 认证与用户 → Task 3/4。
  - §7.2 数据源 → Task 5/6（`/schema` 已实现；`/refresh-schema` 已实现）。
  - §8.1 守卫 → Task 7。
  - §8.2 执行器 → Task 8（只读会话、超时、流式、截断）。
  - §8.3 审计 → Task 8/9。
  - §9 schema 缓存 → Task 6。
  - §13 安全（加密、限流、CSRF）→ Task 1/3/5。
  - §17 步骤 1–4 → 本计划。
  - 未覆盖：`GET /api/admin/audit`、`PUT /api/admin/settings`、数据源删除前的会话检查（属 Plan 4/后续，按 spec 记入 Plan 4）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤给了完整实现。
- **类型一致性**：
  - `DatasourceRow` 在 `db/repositories/datasources.ts` 定义，`query-service.ts` 引用同一路径。
  - `ColumnInfo` 在 `services/artifacts.ts` 定义，executor 与 query-service 共用。
  - `testConfig` 统一从 `apps/server/test/helpers/config.ts` 引入。
  - `AppConfig` 的三个 query 字段在 Task 9 Step 2 加入，Task 9 之前的所有字面量必须同步补字段（Task 9 Step 2 已写清）。

---

## 执行注意事项（已知边界，不阻塞 Plan 1）

1. **`AppConfig` 字面量批量更新**：Task 9 Step 2 给 `AppConfig` 增加 `queryMaxRows/queryPreviewRows/queryTimeoutMs` 后，执行者必须 `rg "AppConfig = \{" apps/server/test` 找齐所有旧字面量并替换为 `testConfig`，否则 typecheck 失败。
2. **生产构建**：`packages/shared` 的 `main` 指向 `src/index.ts`，开发/测试由 tsx/vitest 直接解析；`tsc` 构建不会打包它。Plan 4 做 Docker 前必须二选一：给 shared 加 `tsup` 产出 dist 并改 exports；或给 server 加 `tsup` 且配置 `noExternal: ["@datachat/shared"]`。Plan 1 的 `pnpm build` 只验证类型与 `apps/server/dist` 产物存在。
3. **`.env` 加载**：Plan 1 未引入 dotenv。开发时用 shell 导出变量，或 Plan 2 在 `index.ts` 顶部加 `dotenv`（显式指定仓库根路径，避免 cwd 差异）。
4. **延后到 Plan 4 的规约**：最后一个管理员不可禁用/降级（spec §13）；删除数据源前检查历史会话并提供 `force`（spec §7.2）；`GET /api/admin/audit` 与 `PUT /api/admin/settings`。
5. **node-sql-parser 方言行为**：`database: "postgresql"`、多语句返回数组、`VACUUM` 解析行为以 Task 7 测试为准；只允许调整“拒绝码”，不得把拒绝改为放行。
6. **Testcontainers**：首次运行需拉取 `mysql:8.0` 与 `postgres:16-alpine`，耗时较长；无 Docker 时集成测试整体 skipped，属预期。
