# Trino 示例数据源驱动插件

零第三方依赖的 DataChat Trino（Hive / Iceberg / Delta Lake 联邦查询）驱动插件参考实现，通过 Trino `/v1/statement` HTTP 接口流式拉取结果。

## 快速启用

### 方式一：管理后台离线上传（推荐，无需重启）

以管理员身份进入 **「管理 → 数据源 → 驱动插件」**，点击 **「选择插件包」** 上传本目录下的 `index.mjs` 即可立即热加载。

### 方式二：环境变量配置

```env
DATASOURCE_PLUGINS=./examples/driver-trino/index.mjs
```

新建数据源时选择 **Trino（插件）**：
- **数据库**：填写 Trino Schema 名（例如 `default` / `sf1`）
- **Catalog 名称**（扩展参数）：填写 Trino Catalog 名（例如 `hive` / `iceberg` / `tpch`）
- **Bearer 访问令牌**（可选，AES-GCM 加密存储）：若集群使用 JWT / OAuth2 鉴权可填写；留空则使用 Basic Auth。
