# 数据源驱动插件开发指南

DataChat 内置 **MySQL** 与 **PostgreSQL** 两个参考驱动，同时通过独立的标准协议包 `@datachat/datasource-sdk` 允许社区与企业接入任意其他关系型或分析型数据源（如 ClickHouse、StarRocks、SQL Server、Oracle、DuckDB、Trino 等），而无需修改主仓库代码。

## 核心设计原则

1. **安全边界始终由核心掌控**：所有 AI 生成的 SQL 必须先经过核心 `guardSql` AST 只读校验、行级权限改写（`applyScopeToSql`）与只读执行器（`runGuardedQuery` / `executeReadOnly`），驱动插件**无法绕过**守卫。
2. **显式白名单加载**：服务端**不会**自动扫描 `node_modules`。仅加载环境变量 `DATASOURCE_PLUGINS` 明确列出的模块名或文件路径，且插件不能覆盖内置驱动 id（`mysql`、`postgres`）。
3. **凭据与敏感扩展参数加密落盘**：主密码保存在 `password_cipher`；插件在 `optionsSchema` 中声明 `secret: true` 的扩展字段（例如 API Token、私钥）也会按字段使用 `APP_SECRET` 做 AES-GCM 加密后存入 `options_json`，绝不回显给前端、日志或 Prompt。
4. **卸载优雅降级**：若某数据源依赖的插件后续未加载，列表仍正常展示并标记「驱动未安装」，任何测试、内省或查询请求都会 fail-closed 返回 `DRIVER_NOT_INSTALLED`，不崩溃也不泄露信息。

---

## 快速上手

完整可运行参考实现见 [`examples/driver-clickhouse/`](../examples/driver-clickhouse/)。

### 1. 实现 `DatasourceDriver` 接口

安装或引用 `@datachat/datasource-sdk`（也可像示例插件一样输出符合 v1 协议的纯 ESM 对象）：

```ts
import {
  DATASOURCE_SDK_VERSION,
  defineDatasourceDriver,
  normalizeColumnType,
  safeDriverErrorMessage,
} from "@datachat/datasource-sdk";

export default defineDatasourceDriver({
  manifest: {
    sdkVersion: DATASOURCE_SDK_VERSION, // 当前为 1
    id: "clickhouse",                   // 唯一标识：^[a-z][a-z0-9_-]{1,31}$
    label: "ClickHouse",                // 前端展示名
    connectionMode: "network",
    defaultPort: 8123,
    supportsSsl: true,
    optionsSchema: [
      {
        key: "protocol",
        label: "传输协议",
        type: "select",
        defaultValue: "http",
        options: [
          { value: "http", label: "HTTP" },
          { value: "https", label: "HTTPS" },
        ],
      },
      {
        key: "apiToken",
        label: "网关访问令牌",
        type: "text",
        secret: true, // 自动 AES-GCM 加密，前端密码框渲染，留空保持原值
      },
    ],
    capabilities: {
      explain: false,        // 为 false 时，AI 调用 db_explain 会得到明确提示而非执行
      readOnlyProbe: false,  // probe 是否能可靠检测账号只读状态
      rowScope: false,       // 为 false 时，管理员启用行级权限会被拒绝（SCOPE_UNSUPPORTED_BY_DRIVER）
    },
  },

  dialect: {
    // 核心 AST 解析器所用的基础方言（支持 mysql / postgresql / sqlite / transactsql / mariadb / bigquery）
    parserDialect: "mysql",
    // 参数化占位符风格：qmark (?) | dollar ($1) | at (@p1) | colon (:1)
    placeholderStyle: "qmark",
    quoteChar: "`",
    // 追加到核心 guardSql 的禁止函数与系统库清单（只增不减）
    extraForbiddenFunctions: ["url", "remote", "s3", "file"],
    extraSystemSchemas: ["system"],
    // 注入给 NL2SQL Agent 的简短方言提示
    promptGuidance: "ClickHouse 表名和列名区分大小写；日期函数使用 toDate()/toStartOfMonth()。",
  },

  async probe(config, opts) {
    // 执行轻量连通性检查（例如 SELECT version()），不要泄露 config.password 或 secret options
    return { ok: true, serverVersion: "24.8", readOnly: false, warnings: [] };
  },

  createPool(config) {
    return {
      async introspect() {
        // 返回标准 SchemaSnapshot：{ tables: [...], refreshedAt: Date.now() }
        return { tables: [], refreshedAt: Date.now() };
      },
      async executeQuery(req, emitBatch) {
        // 尊重 req.timeoutMs、req.signal、req.maxRows、req.batchSize
        // 通过 emitBatch({ columns, rows }) 分批流式吐出行数据
        await emitBatch({
          columns: [{ name: "ok", type: normalizeColumnType("Int32") }],
          rows: [[1]],
        });
      },
      async close() {
        // 释放连接池或底层客户端资源
      },
    };
  },
});
```

### 2. 导出规范

插件模块支持以下任一 ESM 导出形式：

- `export default driver`
- `export const driver = ...`
- `export const drivers = [driverA, driverB]`（单个包导出多个驱动）

### 3. 运行一致性测试套件

`@datachat/datasource-sdk` 提供与测试框架无关的 `runDriverConformanceChecks`，可在 Vitest / Jest / Node 脚本中验证清单校验、探测、脱敏、内省、流式执行与资源关闭：

```ts
import { runDriverConformanceChecks } from "@datachat/datasource-sdk";
import myDriver from "./index.js";

const report = await runDriverConformanceChecks({
  driver: myDriver,
  config: {
    id: "test-ck",
    type: "clickhouse",
    host: "127.0.0.1",
    port: 8123,
    database: "default",
    username: "ro",
    password: "secret",
    sslMode: "disable",
    options: { protocol: "http" },
  },
  smokeQuery: "SELECT 1 AS value",
});

if (!report.ok) {
  console.error(report.checks);
  process.exit(1);
}
```

### 4. 在 DataChat 中启用插件

支持两种安装方式（推荐优先使用方式 A 进行离线部署）：

#### 方式 A：管理后台离线上传（热加载，无需重启）

1. 将插件打包为以下任意一种自包含离线包（离线环境不执行 `npm install`，≤ 20 MB）：
   - **单文件 `.mjs`**：零依赖脚本，或使用 `esbuild index.ts --bundle --platform=node --format=esm --outfile=driver.mjs` 打成的单文件包；
   - **压缩包 `.zip` / `.tgz` / `.tar.gz`**：兼容 `npm pack` 结构，包含 `package.json`（声明 `main`/`exports` 与 `version`）及预打包文件。
2. 以管理员身份进入 **「管理 → 数据源 → 驱动插件」**，点击 **「选择插件包」** 上传。
3. 服务端完成安全解压与协议校验后，将插件持久化到 `DATA_DIR/plugins/datasources/<driverId>/`（同步纳入 `pnpm ops:backup` 备份范围）并立即热注册进 `DriverRegistry`；支持随时热启停、覆盖升级与卸载。
4. 如生产环境需锁死仅允许运维通过环境变量加载，可配置 `ALLOW_PLUGIN_UPLOAD=false` 关闭界面上传。

#### 方式 B：环境变量显式白名单（适合容器编排/只读镜像）

在服务端 `.env` 中配置逗号分隔的模块名或文件路径：

```env
# 支持 npm 包名或相对/绝对 ESM 文件路径
DATASOURCE_PLUGINS=./examples/driver-clickhouse/index.mjs
# 设为 true 时，任一插件加载或校验失败会直接阻止服务启动（建议生产开启）
DATASOURCE_PLUGINS_STRICT=true
```

无论采用哪种方式：

- `GET /api/datasources/drivers` 会返回所有已加载驱动的公开清单（含 `optionsSchema` 与 `capabilities`）。
- 管理后台「数据源 → 新建数据源」自动列出插件驱动、切换默认端口，并按 `optionsSchema` 渲染扩展表单项。
- 会话、看板、定时任务、语义层与行级权限（若 `capabilities.rowScope: true`）自动适配新驱动。

---

## 安全检查清单（发布社区插件前必读）

- [ ] `probe()`、`introspect()` 和 `executeQuery()` 的所有连接均应在会话/请求层开启数据库自带的只读模式（如 `readonly=1`、`default_transaction_read_only=on`）。
- [ ] `dialect.extraForbiddenFunctions` 必须封禁该方言可读取外部文件、网络或系统元数据的函数（如 `url()`、`s3()`、`remote()`、`file()`）。
- [ ] `dialect.extraSystemSchemas` 必须封禁系统元数据表库（如 `system`、`sys`）。
- [ ] 所有错误消息在返回前应通过 `safeDriverErrorMessage(err, [config.password, ...secretValues])` 脱敏。
- [ ] 仅当方言的 `parserDialect` 与 `placeholderStyle` 能被 `node-sql-parser` 正确改写并由底层驱动支持位置参数绑定时，才可将 `capabilities.rowScope` 设为 `true`。
