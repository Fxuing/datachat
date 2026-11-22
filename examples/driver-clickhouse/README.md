# ClickHouse 示例数据源驱动插件

这是一个零第三方依赖的 DataChat 数据源驱动插件参考实现，通过 ClickHouse HTTP 接口（`FORMAT JSONCompact` + `readonly=1`）提供只读查询与表结构自省。

## 快速启用

### 方式一：管理后台离线上传（推荐，无需重启）

直接以管理员身份登录 DataChat，进入 **「管理 → 数据源」**，点击右上角 **「驱动插件」→「选择插件包」**，上传本目录下的 `index.mjs` 即可立即热加载使用。

### 方式二：环境变量配置

1. 在服务端 `.env` 中配置显式白名单：

```env
DATASOURCE_PLUGINS=./examples/driver-clickhouse/index.mjs
DATASOURCE_PLUGINS_STRICT=true
```

2. 启动服务端后，进入「管理 → 数据源 → 新建数据源」，即可在「类型」下拉框中看到 **ClickHouse**，并自动渲染该插件声明的扩展参数（传输协议、只读模式级别、可选网关令牌）。

## 安全说明

- 插件在 `dialect` 中额外声明了 `extraForbiddenFunctions`（封禁 `url` / `s3` / `remote` / `file` / `mysql` / `postgresql` 等外部表函数）和 `extraSystemSchemas: ["system"]`。
- 所有用户/AI 生成的 SQL 依然必须经过核心 `guardSql` 与只读执行管道；插件本身无法绕过核心守卫。
- 如需发布独立社区插件包，可将此目录复制为独立 npm 包（如 `datachat-driver-clickhouse`），并用 `@datachat/datasource-sdk` 提供的 `defineDatasourceDriver` 和 `runDriverConformanceChecks` 编写单元测试。
