import { useState } from "react";
import type { RunMemory } from "@datachat/shared";
import type { ChatResult, ChatSql } from "../lib/api";
import type { QueryPair } from "../lib/pair-queries";
import type { RunStatusValue } from "../lib/run-events";
import { TurnFooter } from "../components/chat/TurnFooter";
import { TurnTrace } from "../components/chat/TurnTrace";
import type { TurnTool } from "../components/chat/turn-trace-model";
import { Button } from "../components/ui/button";

const SQL: ChatSql = {
  sql: "select channel, count(*) as orders\nfrom public.orders\nwhere created_at >= now() - interval '30 days'\ngroup by channel\norder by orders desc",
  auditId: "audit_dev",
  status: "ok",
};

const FAILED_SQL: ChatSql = { ...SQL, auditId: "audit_dev_failed", status: "error" };

const RESULT: ChatResult = {
  artifactId: "artifact_dev",
  columns: [
    { name: "channel", type: "string" },
    { name: "orders", type: "number" },
  ],
  rows: [
    ["app", 21],
    ["web", 14],
    ["store", 7],
  ],
  rowCount: 42,
  truncated: false,
  sql: SQL.sql,
};

/** One stretch of reasoning per gap between tool calls, as the stream splits it. */
const THINKING_1 =
  "用户想看近 30 天各渠道的订单量。先确认 orders 表上有没有 channel 字段，" +
  "再决定是直接 group by，还是要 join channels 维表。";
const THINKING_2 = "orders 上没有 channel，渠道在 channels 表里，按 channel_id join 就行。";
const THINKING_3 =
  "结果有了：App 21 单、Web 14 单、门店 7 单。用柱状图按渠道对比，再写一份报告。";

/** A finished stretch long enough to overflow the detail box: opening it has to
 * land on the first line, not at the bottom of the transcript. */
const THINKING_LONG = [
  "用户问的是 8 月份的订单情况，先确认 orders 表里有没有月份字段，没有就用 created_at 截断。",
  "口径上还要先问清楚：是按支付时间还是下单时间？先按 created_at 给一版，回答里说明口径。",
  "字段确认完再看渠道——orders 上只有 channel_id，需要 join channels 维表拿名字。",
  "聚合完要检查一下总数对不对：42 单和明细行数应该能对上，差太多说明 join 放大了行数。",
  "最后一步是给结论，先把环比算出来，再决定用柱状图还是折线图呈现。",
  "再补一层校验：42 单里有没有退款、有没有跨月订单，跨月的按 created_at 归到 8 月还是按支付时间归到 9 月。",
  "顺便看一下渠道字段的取值：App、Web、门店，还有没有空值或者历史上的英文写法，需要统一成中文再展示。",
  "报告里的口径要写清楚：金额是 GMV 还是实收、是否含运费，这两句话不写进去，数字对了也会被追问。",
  "最后再核一遍单位和量级，同比环比都按月算，不用按天摊，避免把大促的两天放大成整体趋势。",
].join("\n\n");

const SCHEMA_TOOL: TurnTool = {
  toolCallId: "tool-schema",
  name: "db_schema",
  status: "ok",
  args: { table: "orders" },
  durationMs: 420,
  summary: "public.orders · public.channels",
};

/** A long run: enough rows to overflow the step list and pin the newest one. */
const CHAIN_TOOLS: TurnTool[] = Array.from({ length: 7 }, (_, index) => ({
  toolCallId: `tool-chain-${index}`,
  name: "db_schema",
  status: "ok",
  args: { table: index % 2 === 0 ? "orders" : "channels" },
  durationMs: 300 + index * 40,
  summary: index % 2 === 0 ? "public.orders" : "public.channels",
}));
const CHAIN_THINKING = Array.from(
  { length: 8 },
  (_, index) =>
    `第 ${index + 1} 次推理：用户要的是近 30 天的渠道分布，先确认第 ${index + 1} 张表的字段与口径，` +
    "再看能不能直接 group by 出环比，如果缺维度就退回明细再自己聚合，最后把结论写进报告。",
);

type Scenario = "start" | "running" | "long" | "done" | "error";

interface ScenarioData {
  status: RunStatusValue;
  thinkingSegments: string[];
  tools: TurnTool[];
  queries: QueryPair<ChatResult>[];
  durationMs: number | null;
  memories?: RunMemory[];
}

/** The two memories the mock user has: one global preference, one fact. */
const DEV_MEMORIES: RunMemory[] = [
  {
    id: "mem-1",
    kind: "preference",
    content: "报表默认按渠道拆分，不要合并成总数；没指定日期就按近 30 天。",
    core: true,
    scope: "全局",
  },
  {
    id: "mem-2",
    kind: "fact",
    content: "我们只统计已支付订单，退款与取消不计入。",
    core: false,
    scope: "数据源 订单库",
  },
];

const SCENARIOS: Record<Scenario, ScenarioData> = {
  start: {
    status: "running",
    // Nothing has happened yet: the one line that is still being written.
    thinkingSegments: [THINKING_1],
    tools: [],
    queries: [],
    durationMs: null,
  },
  running: {
    status: "running",
    // The trailing empty entry is the boundary the query left behind: nothing is
    // being reasoned right now, so no line claims to be "思考中".
    thinkingSegments: [THINKING_1, THINKING_2, ""],
    memories: DEV_MEMORIES.slice(0, 2),
    tools: [
      SCHEMA_TOOL,
      { toolCallId: "tool-query", name: "db_query", status: "running", args: { sql: SQL.sql } },
    ],
    queries: [],
    durationMs: null,
  },
  long: {
    status: "running",
    thinkingSegments: CHAIN_THINKING,
    tools: [
      ...CHAIN_TOOLS,
      { toolCallId: "tool-last", name: "db_query", status: "running", args: { sql: SQL.sql } },
    ],
    queries: [],
    durationMs: null,
  },
  done: {
    status: "ok",
    thinkingSegments: [THINKING_LONG, THINKING_2, THINKING_3],
    memories: DEV_MEMORIES,
    tools: [
      SCHEMA_TOOL,
      { toolCallId: "tool-query", name: "db_query", status: "ok", durationMs: 1_240 },
      {
        toolCallId: "tool-chart",
        name: "make_chart",
        status: "ok",
        durationMs: 610,
        summary: "柱状图 · 按渠道",
        args: { chart_type: "bar" },
      },
      {
        toolCallId: "tool-report",
        name: "create_report",
        status: "ok",
        durationMs: 2_100,
        summary: "近 30 天渠道订单报告",
        url: "/reports/dev-demo",
      },
    ],
    // One result carrying the SQL it came from is what `pairQueries` matches on.
    queries: [{ sql: SQL, result: RESULT }],
    durationMs: 23_400,
  },
  error: {
    status: "error",
    thinkingSegments: [THINKING_1, THINKING_2],
    tools: [
      SCHEMA_TOOL,
      {
        toolCallId: "tool-query",
        name: "db_query",
        status: "error",
        durationMs: 890,
        summary: 'ERROR: column "channel" does not exist',
      },
    ],
    queries: [{ sql: FAILED_SQL }],
    durationMs: 9_800,
  },
};

const SCENARIO_LABELS: Record<Scenario, string> = {
  start: "刚开始",
  running: "执行中",
  long: "步骤很多",
  done: "已完成",
  error: "失败",
};

/** Dev-only page: the real `TurnTrace` with mock data, one per run state. */
const DEV_USAGE = { input: 20_000, output: 6_800, cacheRead: 12_000, cacheWrite: 900 };

export default function DevTracePage() {
  const [scenario, setScenario] = useState<Scenario>("running");
  const data = SCENARIOS[scenario];

  return (
    <div className="min-h-full bg-canvas px-6 py-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Trace</h1>
          <p className="text-xs text-muted">
            仅 `/dev/trace` 可见。用假数据驱动真实的 `TurnTrace`：执行中与失败默认展开，完成后收起。
          </p>
        </header>

        <div className="flex items-center gap-2">
          {(["start", "running", "long", "done", "error"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={scenario === value ? "primary" : "secondary"}
              onClick={() => setScenario(value)}
            >
              {SCENARIO_LABELS[value]}
            </Button>
          ))}
        </div>

        <section className="group/turn flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-line text-muted">
              AI
            </span>
            DataChat
          </div>
          <TurnTrace
            status={data.status}
            thinkingSegments={data.thinkingSegments}
            tools={data.tools}
            queries={data.queries}
            durationMs={data.durationMs}
            usage={DEV_USAGE}
            memories={data.memories}
          />
          <p className="text-sm text-ink">
            {scenario === "error"
              ? "查询没有跑通：orders 表上没有 channel 字段，需要先确认渠道字段在哪张表。"
              : "近 30 天共 42 单：App 21 单、Web 14 单、门店 7 单，其中 App 环比增长 12%。"}
          </p>
          <TurnFooter
            runId={null}
            status={data.status === "ok" ? "ok" : data.status}
            usage={null}
          />
        </section>

        <section className="group/turn flex flex-col gap-1 rounded-lg border border-line bg-surface p-4">
          <p className="text-[11px] text-muted">没有 trace 的普通回答：耗时留在页脚，读作「13s / 26.8k tokens」</p>
          <TurnFooter
            runId={null}
            status="ok"
            durationMs={13_000}
            usage={{ input: 20_000, output: 6_800, cacheRead: 12_000, cacheWrite: 900 }}
          />
        </section>

        <p className="text-[11px] leading-relaxed text-muted">
          检查点：① 思考按工具调用切段，形成「思考 → 执行 → 思考 → 执行」的链路；
          ② 执行中只有当前一步转圈，其余带勾；推理行显示模型原文摘要（单行省略）且默认折叠；
          ③ 失败时整条 trace 自动展开，红色标题就是失败原因；④ 完成后收成一行「本轮完成 · N 步 · 耗时」，
          「步骤很多」演示步骤超出 max-height（18rem）后列表内部滚动、最新一步自动吸底；
          展开「执行查询」能看到 SQL 与结果行数；⑤ token 数读到摘要行末尾（「7 步 · 23s · 26.8k tokens」），
          点赞/点踩悬浮这一轮才出现；没有 trace 的轮次耗时与 token 留在页脚，读作「13s / 26.8k tokens」。
        </p>
      </div>
    </div>
  );
}
