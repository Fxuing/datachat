# 测试与验证

> 目标：优先在最靠近边界的层测试；默认测试不依赖真实模型、真实 MySQL/PostgreSQL 或网络。

## 1. 测试分层

| 层 | 位置 | 适合测什么 | 依赖 |
| --- | --- | --- | --- |
| 纯函数/单元 | 同目录 `*.test.ts` | guard、parser、repo、service、prompt | 无 |
| 服务端路由/集成 | `apps/server/test/*.test.ts` | Fastify inject + 内存 SQLite + fake runtime | 无网络 |
| Agent 运行 | `apps/server/test/agent-e2e.test.ts`、`runtime.test.ts`、`event-bridge.test.ts` | 队列、事件、工具、artifact | `FakeAgentSession` |
| Web 组件 | `apps/web/src/**/*.test.tsx` | 渲染、交互、SSE 状态、可访问性 | jsdom + stub fetch |
| 真库集成 | `apps/server/test/**/*.integration.test.ts` | MySQL/PG 方言、guard/executor、introspect | `RUN_DB_TESTS=1` + Docker |
| NL2SQL 金标 | `evals/nl2sql/` | 端到端生成质量 | 模型 API + 数据库 |

## 2. 命令

```bash
# 提交前默认
pnpm verify

# 分项
pnpm lint
pnpm typecheck
pnpm test                         # 根 vitest：server + packages/shared
pnpm --filter @datachat/web test  # web（jsdom）
pnpm -r build

# 单文件
pnpm exec vitest run apps/server/test/query-service.test.ts
pnpm --filter @datachat/web exec vitest run src/components/chat/MessageItem.test.tsx

# 真库集成（会启动 Testcontainers）
RUN_DB_TESTS=1 pnpm exec vitest run apps/server/test/query-service.integration.test.ts

# NL2SQL
pnpm eval:nl2sql -- --dialect both --threshold 0.8
```

注意：根 `vitest.config.ts` 只 include `apps/*/test/**/*.test.ts` 与 `packages/**/test/**/*.test.ts`，不包含 web `src` 测试。

## 3. 服务端路由测试模板

参考 `apps/server/test/conversations-api.test.ts`：

```ts
const root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-test-"));
const handle = createDb(":memory:");
migrateDb(handle.db);
const app = await buildApp({
  config: { ...testConfig, dataDir: root, siliconflowApiKey: "sk-test" },
  db: handle.db,
  enableRateLimit: false,
  agentRuntime: fakeRuntime as unknown as RuntimeManager,
});
const response = await app.inject({
  method: "GET",
  url: "/api/conversations",
  cookies: { dc_session: cookie },
});
```

要点：

- 每个测试用临时 `dataDir`；`afterEach` 删除。
- 用 `createSessionSigner(testConfig.appSecret).sign({ sub, username, role })` 直接生成 cookie，不必走登录。
- 插入用户后如需功能权限，分配角色或依赖 `resolveUserAccess` 的“无角色 = 成员预设”；数据源还要 `replaceGrants`。
- `app.inject()` 不占端口；记得 `await app.close()`。
- 用 `fakeRuntime` 替代真实 `RuntimeManager`，记录 `enqueue`；不要把模型 API 放进单测。
- 断言状态码、错误 `code`、数据库副作用；不要只断言 message 文案。

## 4. Agent / Runtime 测试

- `FakeAgentSession`（`test/helpers/fake-agent-session.ts`）只实现 runtime 用到的方法；`asAgentSession()` 做类型转换。
- 通过 `session.emit(...)` 注入 Pi 事件，验证 `EventBridge` 生成的 `RunEvent`、持久化 `run_events`、SSE 回放。
- 用 `ConversationSessionFactory` 注入假 session；不要调用 `createConversationSession` 去连真实模型。
- 测工具时直接调用 `createXxxTool(ctx).execute(...)`，使用内存 DB + 临时 artifact 目录 + fake pool；断言 `details`/artifact/audit。
- 记忆提取测试用 mock `ModelRuntime`/generator，不调真实模型；断言最多 3 条、秘密过滤、来源 run。

## 5. Prompt / Skill 测试

- `apps/server/test/prompt.test.ts`：占位符渲染、硬规则数量/顺序、方言标签。
- 改 `agent/prompts/system.md` 后跑该测试；若新增硬规则，同步 `HARD_RULES` 与测试数量。
- 技能：`apps/server/test/skills.test.ts` 覆盖 seed 幂等、数据源覆盖、materialize、显式注入；管理页测试覆盖编辑/导入。
- prompt 行为无法单测时，至少手工验证：普通问答、图表、报告、结果引用、Mermaid。

## 6. Web 测试

参考 `apps/web/src/pages/ChatPage.test.tsx`、`ConversationSidebar.test.tsx`。

```tsx
render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={["/chat/c-1"]}>
      <Routes><Route path="/chat/:conversationId" element={<ChatPage />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
```

- 页面测试 stub 全局 `fetch`，按 URL/method 返回 `Response`；未匹配 URL 直接 throw，尽早发现多余请求。
- 组件测试可 `vi.mock("../../lib/api", ...)`（hoisted mocks），避免真实网络。
- `src/test/setup.ts` 已补 `ResizeObserver`、pointer capture、`scrollIntoView`；Radix 组件可直接测。
- 交互用 `userEvent`；异步用 `findBy*`/`waitFor`；不要固定 sleep。
- 断言用户可见的 role/label/text；避免 snapshot 和实现细节。
- 测试结束自动 `cleanup()`；每个测试新建 `QueryClient`，避免缓存串扰。

## 7. 真库集成测试

- 通过 `RUN_DB_TESTS=1` 开启；默认 skip，CI 的 `integration` job 会设置。
- Testcontainers 启动 MySQL/PostgreSQL；需要 Docker 可用。
- 覆盖：方言 introspect、guard 方言、executor 流式/超时/取消、`runGuardedQuery` artifact/audit。
- 不要把集成测试指向生产库；不要提交容器日志/真实数据。

## 8. NL2SQL 金标集

- 位置：`evals/nl2sql/`；用例、fixture、runner、report。
- 命令：`pnpm eval:nl2sql -- --dialect both --threshold 0.8`。
- 需要 `EVAL_API_KEY`（以及可选的 `EVAL_MODEL`/`EVAL_BASE_URL`）；默认 Testcontainers。
- 改 prompt/schema 工具/SQL guard 后，评估结果可能变化；在 PR/提交说明中记录阈值与模型。

## 9. CI

`.github/workflows/ci.yml`：

- `quality`：lint → typecheck → root tests → web tests → build。
- `integration`：`RUN_DB_TESTS=1` 跑全部 server 测试（含真库）。
- `eval`：仅手工/定时，有 API Key 时跑金标集。

提交前至少本地跑 `pnpm verify`；不能跑时说明哪一步、为什么。

## 10. 完成定义

- [ ] 新行为有失败测试 → 实现 → 通过。
- [ ] 目标测试、typecheck、相关 build 通过。
- [ ] `pnpm verify` 通过（或记录未跑原因）。
- [ ] 迁移测试/表清单已更新。
- [ ] 权限、跨用户、错误路径有覆盖。
- [ ] 没有依赖真实模型/生产数据的单测。
- [ ] 测试不依赖执行顺序；临时文件清理。
