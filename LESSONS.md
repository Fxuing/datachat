# 教训

这里记录 DataChat 真实发生过的回归和险情。改代码前，先找与当前区域匹配的规则。bug 上线或评审中发现后新增一条：写清“本可提前发现它的规则”，不要只写症状。

## Prompt 与技能

**改了内置技能源文件，不会更新已有数据库。**
`seedSkills` 只在该名称不存在时导入 `agent/skills/<name>/SKILL.md`
（[skills.ts](apps/server/src/agent/skills.ts)）；已有记录会被跳过，数据源覆盖也一样。改源文件只影响新安装。
规则：已有部署要通过 `/admin/skills`、迁移或带版本的同步来更新；在这些动作执行前，不要说“内置技能已改”。

**新增在旁边的一个能力，可能让原来的 prompt 规则变成假话。**
prompt 原来写“只有 `[[chart:<id>]]` 能把图表放进正文”；加入 Mermaid 代码块后，这句话就误导了。修复把数据图表（`make_chart`）和结构示意图（Mermaid）分开，并重新检查了改动附近所有“只有/始终”表述（[system.md](agent/prompts/system.md)，提交 `91485e0`、`43b5773`）。
规则：新增一种渲染通道或占位符时，先在 prompt 里搜绝对化表述并合并语义，不要只在后面追加一段。

**一个行内占位符有四个消费端，不是一个。**
聊天专用的 `[[result:<id>]]` 必须由聊天文本、流式文本、报告和公开分享共同解析；报告保持字面量，聊天负责解析
（[report-markdown.ts](apps/web/src/lib/report-markdown.ts)、
[MessageItem.tsx](apps/web/src/components/chat/MessageItem.tsx)、
[MessageList.tsx](apps/web/src/components/chat/MessageList.tsx)）。漏掉一个就会显示原始语法或丢内容。
规则：解析器和所有消费端一起改；补一个“流式收到半个标记”的测试。

**技能文件存在，不代表它已经在 prompt 里。**
技能只有在具备 `skill.use` 时才按会话从数据库物化，模型再用沙箱 `read` 工具读取。显式 `/skill` 还会通过 `composeSkillInstruction` 注入正文。
规则：排查模型行为前，先确认权限、物化目录和显式注入路径（[resources.ts](apps/server/src/agent/resources.ts)、
[skills.ts](apps/server/src/agent/skills.ts)）。

## 测试与验证

**根目录的测试命令不是完整测试集。**
`pnpm test` 只跑 `apps/*/test` 和 `packages/**/test`；Web 测试在 `apps/web/src/**/*.test.tsx`。根目录全绿时，Web 仍可能是坏的。
规则：用 `pnpm verify`，或单独跑 Web 命令
（[vitest.config.ts](vitest.config.ts)、[Web vitest 配置](apps/web/vitest.config.ts)）。

**新增表或索引后，`db.test.ts` 不知道就不算完成。**
`APP_TABLES` 和 `INTEGRITY_INDEXES` 是 schema 守卫，不是文档。迁移后不更新它们，守卫仍会基于不完整的图景通过
（[db.test.ts](apps/server/test/db.test.ts)）。
规则：两处列表都更新；行为变化时再加一个升级/幂等用例。

**前端 mutation 回调收到的是 `(variables, context)`。**
React Query v5 会传第二个参数；只断言一个参数的测试会失败，更糟的是漏掉真实的调用形状。记忆页测试不得不写成
`toHaveBeenCalledWith(false, expect.anything())`。
规则：断言你关心的变量，同时允许 context 参数。

## 运行时与数据

**结果是文件，不是行。**
`db_query` 把行流式写入 artifact（JSONL + 元数据）；SQLite 只存 artifact 记录，不存完整结果。把几千行塞进 SQLite、`run_events` 或 prompt，会破坏分页、导出和分享投影
（[artifacts.ts](apps/server/src/services/artifacts.ts)）。
规则：数据路径以 artifact 为先；行数据通过结果弹窗/表格展示。

**SSE 有两条路径。**
实时事件走 `RunEventBus`；断线重连按 `seq` 回放 `run_events`。只发布不持久化的事件刷新后消失；只持久化不发布的事件会让已打开页面卡住
（[event-bridge.ts](apps/server/src/agent/event-bridge.ts)、
[runs.ts](apps/server/src/routes/runs.ts)）。
规则：追加 + 发布 + 回放 + 消费，所有终止路径都以 `run_end` 结束。

**`runId` 是执行状态，不是构造参数。**
工具上下文在会话的多个 run 之间共享；runtime 在每次 prompt 前更新 `toolContext.runId`，这样 artifact 和审计行才属于当前 run
（[runtime.ts](apps/server/src/agent/runtime.ts)）。
规则：不要在工具工厂里捕获一次 `runId` 然后跨 prompt 复用。

**权限按请求重读，但会话资源是快照。**
`resolveUserAccess` 每个 HTTP 请求都会执行，排队/定时任务也会重查数据库。但技能/MCP/报告工具是在创建会话时装配进去的；撤销角色不会重写已经打开的会话。
规则：尽量在执行时再校验；如果权限变更必须立即生效，重建会话/runtime，不要假设旧工具集会变。

## 部署与界面

**`APP_ORIGIN` 必须包含公开端口。**
CSRF/cookie 校验比较浏览器 origin；少了 `:9528`（或部署端口）就会拒绝登录。`COOKIE_SECURE` 默认跟随 origin 协议，除非显式覆盖。HTTP + IP 部署直到 `21cc5d5` 修正推导后才恢复登录。
规则：用真实公开 URL 测试，不要只测 `localhost`；compose/env 示例保持一致。

**对已加载页做过滤，不等于对会话列表做过滤。**
侧栏只加载 30 行；只过滤这个数组会隐藏用户本应看到的会话。列表 API 现在接收 `q`，仓储用 `instr(lower(...))`，让 `%`/`_` 保持字面量
（[conversations.ts](apps/server/src/db/repositories/conversations.ts)）。
规则：列表筛选要同时进入 query key 和服务端查询，不能只放在组件 state 里。

**空筛选框失焦后，不应该留下一个死输入框。**
把“新建对话”换成筛选输入框后，只有“空且失焦时恢复主操作、有内容时保持展开”才好用。这是状态机细节，不是样式细节
（[ConversationSidebar.tsx](apps/web/src/components/chat/ConversationSidebar.tsx)）。
规则：明确 open/empty/querying/closed 状态，并测试 blur、Escape 和清除。

## 改动纪律

**一个修复要覆盖所有同类位置。**
同一个占位符会在聊天/报告/分享中解析；同一个权限门禁在 HTTP 和工具上都需要；同一套模型解析被会话、定时任务和记忆提取共用。只改一个调用点，其他位置就会埋雷
（[架构参考](docs/subsystems/README.md)）。
规则：用谓词/解析器/门禁的名称全局搜索，在同一个 commit 改完所有调用方。

**提交前拿文件清单对照目标。**
push 前先读 `git show --stat HEAD`。如果出现本次目标之外的文件，或工作树是旧的，先停下来 rebase，不要顺手推不相关的改动。
规则：一个 commit 只做一个目标；在正文写明跑了什么验证。
