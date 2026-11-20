# 部署、配置与运维指南

本文档汇总 DataChat 的环境变量说明、Docker Compose 部署、模型服务与冒烟校验、权限与治理功能配置、备份恢复及 NL2SQL 金标集评估。

---

## 环境变量

根目录 `.env.example` 用于本地开发，`deploy/env.example` 用于 Docker Compose 部署。

`APP_SECRET` 必须至少 32 个字符，可用 `openssl rand -hex 32` 生成。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `APP_SECRET` | 是 | 会话签名与敏感配置加密密钥，≥ 32 字符 |
| `ADMIN_PASSWORD` | 首次启动必填 | ≥ 8 位管理员初始密码；仅在空库首次 bootstrap 时生效 |
| `ADMIN_USERNAME` | 否 | 首个管理员用户名，默认 `admin` |
| `PORT` | 否 | 后端服务端口，默认 `8080` |
| `WEB_PORT` | 否 | 前端端口，默认 `5173`；Docker 下同时作为对外映射端口 |
| `DATA_DIR` | 否 | 数据目录，默认 `./data`（SQLite、artifact、上传文件、agent 认证缓存） |
| `LOG_LEVEL` | 否 | 日志级别，默认 `info` |
| `SILICONFLOW_API_KEY` | 否 | 默认模型密钥；缺失时可启动但 `/api/models` 返回 `configured:false` |
| `SILICONFLOW_BASE_URL` | 否 | 默认 `https://api.siliconflow.cn/v1` |
| `APP_ORIGIN` | 否 | 浏览器访问的完整 origin（含端口，多个用逗号分隔）；不匹配会被 CSRF 拒绝 |
| `COOKIE_SECURE` | 否 | 会话 Cookie 是否带 `Secure`；留空时按 `APP_ORIGIN` 自动判断（`http`→`false`，`https`→`true`） |
| `TRUST_PROXY` | 否 | 位于 nginx / 反向代理后设为 `true`，用于读取 `X-Forwarded-*` |
| `QUERY_PREVIEW_ROWS` | 否 | 结果预览行数上限，默认 `200` |
| `QUERY_MAX_ROWS` | 否 | 单次查询最大保留行数，默认 `100000` |
| `QUERY_TIMEOUT_MS` | 否 | 单次查询超时（ms），默认 `30000` |
| `RETENTION_SWEEP_HOURS` | 否 | 定时清理检查间隔（小时），默认 `0`（关闭） |
| `BILI_NATIVE_PI` | 否 | 设为 `0` 可关闭内置 `billion-context` 上下文压缩插件 |

---

## Docker Compose 部署

单机部署由 `server`（Node + Pi SDK + SQLite）和 `web`（nginx 托管 SPA 并反代 `/api`）组成：

```bash
cp deploy/env.example .env
# 必填：APP_SECRET（>=32 字符）、ADMIN_PASSWORD（>=8 字符）
# 生产环境务必设置 APP_ORIGIN 为实际访问地址（包含端口）
docker compose up -d --build
```

### 使用离线/预构建镜像

```bash
# 构建机导出
docker save datachat-server:<tag> datachat-web:<tag> | gzip -1 > datachat-images-<tag>.tar.gz

# 目标服务器加载并启动
docker load -i datachat-images-<tag>.tar.gz
mkdir -p /opt/datachat && cd /opt/datachat
cp /path/to/docker-compose.yml .
cp /path/to/deploy/env.example .env
# 编辑 .env 中的 DATACHAT_VERSION=<tag>、APP_SECRET、ADMIN_PASSWORD、APP_ORIGIN、WEB_PORT
docker compose up -d
```

部署要点：

- 数据（SQLite、artifact、skills、Pi 会话、上传文件 SQLite）保存在命名卷 `datachat-data`（容器内 `/data`）。
- `deploy/nginx.conf` 已为 SSE 关闭缓冲并设置 3600s 读超时，`client_max_body_size` 为 `25m`（适配单文件 ≤ 20 MB 上传）。
- 通过 IP + HTTP 访问时，`APP_ORIGIN` 必须包含完整协议、IP 与端口（如 `http://192.168.1.10:5173`）。

---

## 模型服务与冒烟脚本

管理员可在「设置 → 模型服务」配置多个 OpenAI-compatible 或 Anthropic Messages provider、测试 `/models`、编辑上下文窗口并设置默认模型；系统会自动同步启用模型至 `DATA_DIR/agent/models.json`。

新增模型前建议运行手动冒烟脚本确认 function calling 与服务健康：

```bash
node scripts/smoke-agent.mjs    # 校验白名单模型的 db_query tool calling 能力（无 Key 时跳过）
node scripts/smoke-server.mjs   # 需先 pnpm -r build；校验 /api/health 与 /api/models
```

---

## 功能管理与治理

### 角色、权限与行级数据范围

- **RBAC**：包含 6 个功能权限（`chat.use`、`skill.use`、`mcp.use`、`report.create`、`share.create`、`export.data`）和 9 个系统管理权限。
- **部门与行级权限**：管理员在「管理 → 部门」维护部门树与部门数据源授权，在数据源配置「行级权限」表策略；查询在 SQL 守卫后、执行前改写为派生表过滤，未分类表或缺失映射默认拒绝，历史结果按执行时的部门快照鉴权。详见 [部门与行级数据权限](subsystems/data-scope.md)。

### Excel / CSV 临时文件分析

- 支持在「新建对话」切换「Excel / CSV 文件」模式，拖拽上传 `.xlsx` / `.csv`（单文件 ≤ 20 MB、单次 ≤ 5 个文件、单会话 ≤ 10 张表、总行数 ≤ 20 万行）。
- 自动识别 UTF-8 BOM / GB18030、合并单元格、公式值与表头行并支持手动调整表头行；会话内支持继续追加文件进行多表 `JOIN`。
- 每个文件会话拥有独立的 `DATA_DIR/files/<conversationId>/data.sqlite`，查询在只读子进程中执行，不污染主库与业务库。

### 技能（Skills）与 MCP

- **Skills**：「管理 → 技能管理」维护全局或数据源级 Markdown 技能，支持“恢复内置技能”；保存后在**下一次新建会话**物化生效。
- **MCP**：「管理 → MCP 服务器」支持 `stdio` 与 `http` 传输；`env` / `headers` 加密存储，支持 15s 超时连接测试，保存后在**下一次新建会话**生效。

### 用户记忆、定时任务与站内信

- **用户记忆**：支持对话中 `memory_save` 与运行后异步提取，按用户严格隔离，不进入报告与公开分享；管理员可在系统设置全局启停。详见 [记忆](subsystems/memory.md)。
- **定时任务**：具备 `chat.use` + `report.create` 权限的用户可在「定时任务」配置 5 段 Cron 与 IANA 时区，到期在隐藏会话执行并生成报告、发送站内信通知（连续失败 3 次自动停用）。详见 [定时任务](subsystems/scheduled-tasks.md)。

---

## 运维、备份与保留策略

- **运行指标与数据保留**：「管理 → 运维」（`/admin/ops`）查看 7/30/90 天运行指标，并可配置会话与审计保留天数（支持先预览再清理，自动跳过活跃运行与未过期分享）。
- **备份与恢复**：
  ```bash
  pnpm ops:backup
  pnpm ops:restore --from <backup-dir> --yes
  ```
  备份包含 SQLite、artifact、Pi 会话、技能与 agent 配置（不含 `.env`）；恢复时必须使用原 `APP_SECRET`，否则无法解密数据源密码与外部密钥。

---

## NL2SQL 金标集评估

`evals/nl2sql/` 内置电商 MySQL / PostgreSQL 固定测试集（15 条用例），通过真实 Agent 链路执行并逐值比对结果集：

```bash
# 默认启动 Testcontainers（需要 Docker）
pnpm eval:nl2sql

# 指向已有测试库或本地网关
EVAL_BASE_URL='http://127.0.0.1:3425/v1' EVAL_API_KEY='local' pnpm eval:nl2sql -- --dialect both --threshold 0.8
```

常用参数：`--dialect mysql|postgres|both`、`--case <id>`、`--model <id>`、`--repeat <n>`、`--threshold 0.8`、`--timeout 120`、`--output <dir>`。
