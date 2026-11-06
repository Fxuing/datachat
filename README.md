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

## 手动浏览器验收路径

1. 配置 `.env`（`APP_SECRET`、`ADMIN_PASSWORD`、可选 `SILICONFLOW_API_KEY`）并启动 server + web。
2. 用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。
3. “新建对话”并选择一个数据源。数据源需先在管理接口创建且**可连通**；本仓库默认不附带数据库，请指向自己的测试库。
4. 提问（例如“users 表有多少行”），预期：SSE 流式输出中文结论、SQL 卡片和结果表格；可继续追问（如“按角色分组”），也可点击停止中断。
5. 刷新页面，历史消息、SQL 与结果元数据应从服务端恢复。

结果预览行数默认为 200（`QUERY_PREVIEW_ROWS`），完整结果写入 `DATA_DIR/artifacts`；查询上限为 `QUERY_MAX_ROWS`（默认 100000），超时 `QUERY_TIMEOUT_MS`（默认 30000）。
