# DataChat

自然语言对话式数据查询：用中文提问，Agent 通过只读 SQL 工具查询 MySQL / PostgreSQL，返回结论、SQL 与结果表格。

## 目录

| 路径 | 说明 |
| --- | --- |
| `apps/server` | Fastify + better-sqlite3（会话/审计/结果存储）+ Pi Agent 运行时 |
| `apps/web` | React 19 + Vite + Tailwind 前端 |
| `packages/shared` | 前后端共享类型与校验 |
| `agent/models.json` | 模型白名单（`siliconflow` provider） |
| `scripts/smoke-*.mjs` | 手动冒烟脚本，测试不依赖网络 |

## 前置条件

- Node.js ≥ 22.9，pnpm 10（`corepack enable` 即可）
- 可选：可达的 MySQL / PostgreSQL 测试库（创建数据源时会真实连接探测；没有测试库则无法完成浏览器端 SQL 查询流程）
- 可选：SiliconFlow API Key（没有 Key 时服务可启动，聊天页显示“未配置模型”）

## 环境变量

```bash
cp .env.example .env
```

`APP_SECRET` 必须至少 32 个字符，可用 `openssl rand -hex 32` 生成。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `APP_SECRET` | 是 | 会话签名密钥，≥ 32 字符 |
| `PORT` | 否 | 服务端口，默认 `8080` |
| `DATA_DIR` | 否 | 数据目录，默认 `./data`（SQLite、结果文件、agent 认证缓存） |
| `LOG_LEVEL` | 否 | 日志级别，默认 `info` |
| `SILICONFLOW_API_KEY` | 否 | 模型密钥；缺失时 `/api/models` 返回 `configured:false` |
| `SILICONFLOW_BASE_URL` | 否 | 默认 `https://api.siliconflow.cn/v1` |
| `ADMIN_USERNAME` | 否 | 首个管理员用户名，默认 `admin` |
| `ADMIN_PASSWORD` | 首次启动必填 | ≥ 8 位真实密码；仅当数据库中没有管理员时用于创建，之后修改无效 |

> 空数据库且未设置 `ADMIN_PASSWORD` 时服务会拒绝启动。该密码只用于 bootstrap，后续管理请使用管理接口。

## 安装、构建、启动

```bash
pnpm install
pnpm -r build

# 两个终端分别启动
pnpm --filter @datachat/server dev   # http://localhost:8080
pnpm --filter @datachat/web dev      # http://localhost:5173，/api 代理到 8080
```

或 `pnpm dev` 同时启动。访问 `http://localhost:5173`。

## 验证

```bash
pnpm verify                        # typecheck + 服务端/共享包测试 + web 测试 + 全量构建
pnpm test                          # 服务端与共享包测试（vitest）
pnpm --filter @datachat/web test   # 前端组件测试（jsdom）
pnpm typecheck
```

测试使用内存 SQLite 与假模型，**不访问真实数据库或模型 API**，可离线运行。

## 模型白名单策略

`agent/models.json` 是唯一模型来源，当前白名单 4 个模型。新增模型前必须先通过工具调用冒烟：

```bash
node scripts/smoke-agent.mjs
```

脚本对白名单中的每个模型发起一次带 `db_query` 工具的请求，断言 `finish_reason === "tool_calls"` 且工具名/参数合法；任一模型失败即退出非零。**只有全部通过才允许把新模型加入 `agent/models.json`。**

两个冒烟脚本都是手动的，会从 `.env` 读取密钥，**不会打印密钥**：

```bash
node scripts/smoke-agent.mjs    # 无 Key 时打印跳过信息并退出 0
node scripts/smoke-server.mjs   # 需先 pnpm -r build；临时端口启动服务，校验 /api/health 与 /api/models
```

`smoke-server` 使用临时数据目录和随机 bootstrap 密码，只做进程内校验，不打印密码。

## Docker Compose 部署

单机部署：一个 `server` 容器（Node + Pi SDK + SQLite）加一个 `web` 容器（nginx 托管 SPA 并反代 `/api`）。

```bash
cp .env.example .env
# 必填：APP_SECRET（>=32 字符）、ADMIN_PASSWORD（>=8 字符）、SILICONFLOW_API_KEY
# 可选：ADMIN_USERNAME、APP_ORIGIN（浏览器访问的公开地址）
docker compose up -d --build
# 打开 http://localhost:8080
```

要点：

- 数据（SQLite、artifact、skills、会话）保存在命名卷 `datachat-data`，挂载到容器 `/data`。
- `web` 对外暴露 80，默认映射到主机 `8080`（`WEB_PORT` 可改）；`server` 不直接暴露，由 nginx 反代。
- SSE 已在 `deploy/nginx.conf` 关闭缓冲并把读超时调到 3600s，长查询不会被 nginx 截断。
- 生产环境务必把 `APP_ORIGIN` 设为实际访问地址（多个用逗号分隔），否则登录会被 CSRF 校验拒绝。
- 镜像内保留完整 `node_modules`（含 devDependencies），优先保证 better-sqlite3 / argon2 原生模块可用；后续可用 `pnpm deploy` 裁剪体积。
- 本仓库开发机没有 Docker，`docker compose config` 与镜像构建未实跑；文件按官方镜像与 compose 规范静态校验。

## 手动浏览器验收路径

1. 配置 `.env`（`APP_SECRET`、`ADMIN_PASSWORD`、可选 `SILICONFLOW_API_KEY`）并启动 server + web。
2. 用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。
3. “新建对话”并选择一个数据源。数据源需先在管理接口创建且**可连通**；本仓库默认不附带数据库，请指向自己的测试库。若使用 root 等有写权限的账号，在数据源编辑面板勾选“允许使用有写权限的账号”即可，查询仍被强制只读。
4. 提问（例如“users 表有多少行”），预期：SSE 流式输出中文结论，思考、工具调用与 SQL 收在可折叠的“执行过程”中，结果表格单独展示；可继续追问（如“按角色分组”），也可点击停止中断。
5. 刷新页面，历史消息、SQL 与结果元数据应从服务端恢复。

结果预览行数默认为 200（`QUERY_PREVIEW_ROWS`），完整结果写入 `DATA_DIR/artifacts`；查询上限为 `QUERY_MAX_ROWS`（默认 100000），超时 `QUERY_TIMEOUT_MS`（默认 30000）。

## 图表、导出、技能与 MCP

### 图表

提问时直接描述图形，例如“按月统计订单金额并画柱状图”。Agent 调用 `make_chart` 读取结果 artifact，生成 ECharts option（柱/线/面积/饼/散点，可指定 `x`、`y`、`series` 与 `sum/avg/count/min/max` 聚合），图表显示在对应回答下方；图表卡片右上角“下载 PNG”导出图片。图表只基于已生成的查询结果，不改写 SQL。

### CSV / Excel 导出

结果表格底部有“下载 CSV”和“下载 Excel”，对应 `GET /api/artifacts/:id/download?format=csv|xlsx`。CSV 带 UTF-8 BOM、按 RFC4180 转义；Excel 首行加粗并冻结，数值列保持 number。导出上限 100000 行（超出返回 413 `EXPORT_TOO_LARGE`），仅属主或管理员可下载，并写入 `action=export` 审计；图表 artifact 不支持导出。

### Skills 管理

1. 以管理员登录，左下角“管理”→“技能管理”（`/admin/skills`）。
2. “新建技能”填写 name（`^[a-z0-9][a-z0-9-]{1,63}$`）、description、Markdown 正文与范围；范围选“数据源”时需选择数据源，同名数据源技能会覆盖全局技能。也可用“恢复内置技能”重新导入内置 3 个技能。
3. 保存或启停后无需重启服务，**下一次会话创建时生效**（技能物化到 `DATA_DIR/skills/<conversationId>/`）；已打开的会话继续使用旧技能。

### MCP 管理

1. 以管理员登录，左下角“管理”→“MCP 服务器”（`/admin/mcp`），点击“新建”。
2. 选择传输方式：`stdio` 填 command 与 args（每行一个），可选 env；`http` 填 `http(s)://` URL，可选 headers。可限定到某个数据源（默认全局），并设置启用状态。
3. env / headers 加密存储，列表与编辑页只显示键名和“已设置”标记；值留空表示保持不变。
4. “测试连接”会在 15s 内启动连接并调用 `tools/list`，成功显示工具数与前 5 个工具名，失败只显示脱敏错误。
5. 保存后同样在**下一次会话创建时生效**，Agent 可调用其中启用的工具。

管理员入口仅对 `admin` 角色显示；非管理员访问 `/admin/*` 会跳回 `/chat`。

## 交付验收清单

- [x] 管理员可完全通过 UI 建/改/测/授权/删数据源，无需 curl。
- [x] 任意查询结果可生成图表并导出 CSV / Excel。
- [x] 查询结果可生成 Markdown 报告，报告页可打印为 PDF。
- [x] 报告可分享为匿名链接，撤销后返回 410，公开页最多展示 100 行。
- [x] 审计页可查询登录、用户、数据源、授权、技能、MCP、查询、导出动作。
- [x] 设置修改默认模型与查询上限后，新会话生效。
- [ ] `docker compose up` 实跑（开发机无 Docker，仅做静态校验）。

## 已知限制

- 一个会话只绑定一个数据源，跨库问题不会自动 JOIN。
- 仅支持只读查询（SELECT / SHOW / DESCRIBE / EXPLAIN），不提供写操作；即使数据源使用 root 等写权限账号并勾选“允许使用有写权限的账号”，也不会放开写操作。
- 元数据与会话存单机 SQLite，面向内网小团队，未做多租户与水平扩展。
- 不开放自助注册，账号由管理员创建；分享链接匿名可读，但可撤销、可设过期。
- MCP 的 `stdio` 服务器等同于在本机执行命令，仅应添加可信服务器。
- 报告导出 PDF 依赖浏览器打印，不生成服务端 PDF 文件。
- 数据库集成测试默认跳过；设置 `RUN_DB_TESTS=1` 并准备 Docker 后运行。

## 上下文压缩与使用率

- 对话默认加载 [billion-context](https://github.com/ranxianglei/billion-context)（MIT）的 Pi 原生插件，长对话会在模型调用前自动压缩历史，并注册 `compress` / `decompress` / `search_context` / `acp_status` 等工具。
- 输入框左下角的圆环显示当前会话的上下文占用（`tokens / contextWindow`）；达到 70% 变琥珀色、90% 变红色。
- 如需关闭，设置环境变量 `BILI_NATIVE_PI=0` 后重启服务。
