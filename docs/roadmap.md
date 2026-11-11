# DataChat 路线图与实施状态

> 更新时间：2026-11-11。本文记录**实际交付状态**、计划外新增能力、已知缺口和下一步候选；原始实施计划保留在 `docs/superpowers/plans/`，其中的复选框是执行模板，不再逐项回填。

## 计划状态

| 计划 | 主题 | 状态 |
| --- | --- | --- |
| [`2026-11-06-datachat-01-foundation.md`](./superpowers/plans/2026-11-06-datachat-01-foundation.md) | 骨架、认证、数据源、SQL 核心 | 已交付 |
| [`2026-11-06-datachat-02-agent-chat.md`](./superpowers/plans/2026-11-06-datachat-02-agent-chat.md) | Pi Agent 运行时与聊天页 | 已交付 |
| [`2026-11-06-datachat-03-analysis.md`](./superpowers/plans/2026-11-06-datachat-03-analysis.md) | 图表、导出、Skills、MCP | 已交付 |
| [`2026-11-06-datachat-04-delivery.md`](./superpowers/plans/2026-11-06-datachat-04-delivery.md) | 报告、分享、审计、设置、Docker | 已交付 |
| [`2026-11-10-experience-recovery-onboarding.md`](./superpowers/plans/2026-11-10-experience-recovery-onboarding.md) | 失败恢复、新手引导、schema 懒刷新 | 已交付 |
| [`2026-11-11-nl2sql-golden-set.md`](./superpowers/plans/2026-11-11-nl2sql-golden-set.md) | NL2SQL 金标集与回归评分 | 已交付 |
| [`2026-11-11-operations-governance.md`](./superpowers/plans/2026-11-11-operations-governance.md) | 保留策略、运行指标、备份恢复 | 已交付 |

## 计划外已交付

以下能力在原计划中没有单独任务，但已经进入代码和文档：

- **多模型服务商管理**：`llm_providers` 表 + 设置页“模型服务”，支持 OpenAI-compatible / Anthropic Messages 协议、`/models` 测试、启停、默认模型、上下文窗口编辑；模型键为 `providerId::modelId`，兼容旧裸模型 ID；旧 `.env` SiliconFlow 配置自动 seed，空 Key 不再产生永久“未配置”状态。
- **会话级模型与思考等级**：Composer 内模型选择器（含 off…max 七档思考）与会话级 `thinkingLevel`。
- **失败恢复**：`runs.retry_of_run_id` + `POST /api/runs/:id/retry`，原地重试并隐藏被替换的失败轮次；“换模型重试”；发送失败可重新发送；停止的轮次也可重试。
- **新手引导**：`/chat` 空态直接选数据源、点示例创建会话并发送；已有会话空态只显示绑定数据源与示例，不再误报“无数据源 / 未配置模型”；模型/数据源加载失败有明确状态和重试。
- **Schema 懒刷新**：新建数据源或空缓存时，`db_schema` 自动调用 `refreshDatasourceSchema`；超过 24h 刷新失败回退旧快照并标记 `stale`，普通用户不再被“请先在数据源页面刷新”卡住。
- **问卷式澄清**：`ask_user_question` 工具 + `QuestionCard`，支持单选/多选/自由文本、多问题 tab，答案回传后模型继续执行。
- **长对话上下文压缩**：内置 billion-context Pi 插件，自动压缩历史；Composer 上下文占用环（70% / 90% 变色）。
- **结果与过程呈现**：SQL 与结果成对、执行过程默认折叠、结果弹窗、思考块、报告内联图表、右侧对话 minimap、全站 Radix Tooltip。
- **工程与部署**：`WEB_PORT` / `PORT` 环境变量；Docker Compose 已在 Docker 29 + Compose v5 实跑并修复空库迁移顺序、构建 target、smoke 模型 ID 等问题。
- **NL2SQL 金标集**：15 条单轮用例、MySQL/PostgreSQL fixture、真实 Agent 链路、结果集逐值比较、`--repeat`、JSON/Markdown 报告与阈值退出码；2026-11-11 基线 MySQL 13/15、PostgreSQL 12/15。
- **运行治理**：管理员“运维”页（`/admin/ops`）提供 7/30/90 天运行指标（成功率、P50/P95、token、Top 数据源、查询审计）、会话/审计保留天数与预览后手动清理（活跃分享、运行中会话自动跳过）、备份列表与 CLI 备份/恢复；可选 `RETENTION_SWEEP_HOURS` 定时清理。清理会同步删除报告/分享，备份不包含 `.env`，恢复需相同 `APP_SECRET`。
- **CI 与 lint**：`.github/workflows/ci.yml` 覆盖 lint、typecheck、服务端/共享包测试、web 测试与构建；独立 job 用 Testcontainers 跑真库集成测试；手动/夜间 `eval:nl2sql` job 在配置 `EVAL_API_KEY` 后运行；根级 `pnpm lint` 使用 ESLint 9 + typescript-eslint flat config。首次 GitHub Actions 运行已通过（2026-11-11，含 7 项 MySQL/PostgreSQL 集成测试）。

## 已知缺口

| 缺口 | 影响 | 现状 |
| --- | --- | --- |
| 真库集成测试本地默认跳过 | 本地日常测试仍不跑 SQL 执行/introspect | CI 已用 `RUN_DB_TESTS=1` + Testcontainers 自动跑；本地仍需显式开启 |
| 金标集未接入每次 CI | 模型或提示词改动不会阻塞合并 | 已加入手动/夜间 job，需要仓库 Secret `EVAL_API_KEY`，未配置时跳过 |
| 无浏览器 E2E | 登录、建会话、重试、分享等主路径无自动回归 | 无 Playwright |
| 单会话单数据源 | 跨库问题不能自动 JOIN | 产品设计约束 |

## 下一步候选

1. **Playwright E2E 冒烟**：登录 → 建数据源（mock 或 fixture）→ 新建会话 → 提问 → 重试 → 分享/撤销 → 410。约 1–2 天，补 UI 主路径回归；CI 已就绪，可直接接入。
2. **产品能力扩展**：跨数据源对比、定时报告/订阅、细粒度 RBAC、会话归档与搜索。3 天以上，需要先确认业务优先级。
3. **备份增强**：异地/对象存储、定时备份与恢复演练。约 1–2 天，适合有正式部署环境后做。

建议顺序：**1 → 2 → 3**。质量门禁与运行治理已完成，下一步优先补浏览器层主路径回归。
