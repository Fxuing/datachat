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

## 已知缺口

| 缺口 | 影响 | 现状 |
| --- | --- | --- |
| 没有 CI | 提交无法自动跑 typecheck/test/build | 无 `.github/workflows` |
| 没有 ESLint | 风格与常见错误靠人工/tsc | 无 lint 配置 |
| 真库集成测试默认跳过 | SQL 执行、introspect、连接池缺少自动回归 | `RUN_DB_TESTS=1` + Docker 才运行，共 5 项 skipped |
| 金标集未接入 CI/定时任务 | 模型或提示词改动不会自动报警 | 只能手动 `pnpm eval:nl2sql` |
| 无浏览器 E2E | 登录、建会话、重试、分享等主路径无自动回归 | 无 Playwright |
| 无数据保留策略 | artifact、审计、会话会无限增长 | 无清理任务/配置 |
| 无运行指标聚合 | 看不到成功率、耗时、token 成本趋势 | 只有单次 run 记录 |
| 无备份/恢复 | SQLite 与 artifact 依赖手工拷贝 | 无命令/文档 |
| 单会话单数据源 | 跨库问题不能自动 JOIN | 产品设计约束 |

## 下一步候选

1. **质量门禁与自动化（推荐）**：GitHub Actions 跑 `pnpm verify`；加 ESLint；用 MySQL/PostgreSQL service 容器跑 `RUN_DB_TESTS=1` 的集成测试；再加一个手动/夜间 `eval:nl2sql` job（读仓库 Secrets，无 Key 时跳过）。约 1–1.5 天，直接补上当前最大的工程缺口，并让金标集 baseline 真正有约束力。
2. **运行治理**：artifact/审计/会话保留策略（按天数/大小清理）、运行指标聚合页（成功率、P95 耗时、token/成本）、SQLite + artifact 备份恢复命令。约 1–1.5 天，适合准备长期内网运行时做。
3. **Playwright E2E 冒烟**：登录 → 建数据源（mock 或 fixture）→ 新建会话 → 提问 → 重试 → 分享/撤销 → 410。约 1–2 天，补 UI 主路径回归，但依赖 1 的 CI 才有最大价值。
4. **产品能力扩展**：跨数据源对比、定时报告/订阅、细粒度 RBAC、会话归档与搜索。3 天以上，需要先确认业务优先级。

建议顺序：**1 → 2 → 3**。CI 先把现有能力锁住，再做保留/指标，最后补浏览器层回归。
