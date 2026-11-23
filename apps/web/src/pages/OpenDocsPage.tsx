import { useState } from "react";
import { Link } from "react-router-dom";
import {
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  FileJson,
  KeyRound,
  Play,
  ShieldCheck,
  Terminal,
  Webhook,
} from "lucide-react";
import { BrandMark } from "../components/BrandMark";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { openApiTryRequest } from "../lib/api";

type CodeLang = "curl" | "ts" | "python";

const TOC_ITEMS = [
  { id: "quickstart", label: "快速开始（3 步接入）" },
  { id: "auth-rls", label: "认证与行级数据权限" },
  { id: "discovery", label: "数据源与语义层 API" },
  { id: "ask", label: "结构化问答 Ask API" },
  { id: "stream", label: "SSE 流式与断线回放" },
  { id: "reports", label: "模板化报告生成 API" },
  { id: "feedback", label: "反馈回流（Few-Shot）" },
  { id: "mcp", label: "远程 MCP Server 接入" },
  { id: "webhook", label: "Webhook 与 HMAC 验签" },
  { id: "errors", label: "错误码与限流规则" },
  { id: "try-it", label: "在线接口试调" },
] as const;

function CodeBlock({
  snippets,
  lang,
  onLangChange,
}: {
  snippets: Partial<Record<CodeLang, string>>;
  lang: CodeLang;
  onLangChange: (next: CodeLang) => void;
}) {
  const [copied, setCopied] = useState(false);
  const available = (["curl", "ts", "python"] as const).filter((k) => Boolean(snippets[k]));
  const activeLang: CodeLang = snippets[lang] ? lang : (available[0] ?? "curl");
  const code = snippets[activeLang] ?? "";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be unavailable in non-HTTPS contexts.
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line bg-subtle px-3 py-1.5">
        <div className="flex gap-1">
          {available.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onLangChange(item)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                activeLang === item
                  ? "bg-brandsoft text-brandtext"
                  : "text-inksoft hover:text-ink"
              }`}
            >
              {item === "curl" ? "cURL" : item === "ts" ? "TypeScript" : "Python"}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => void handleCopy()}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3.5 text-xs leading-relaxed text-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function EndpointBadge({ method, path, scope }: { method: "GET" | "POST"; path: string; scope?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle/60 px-3 py-2 font-mono text-xs">
      <span
        className={`rounded px-1.5 py-0.5 font-semibold ${
          method === "GET"
            ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
            : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        }`}
      >
        {method}
      </span>
      <span className="font-medium text-ink">{path}</span>
      {scope ? (
        <span className="ml-auto rounded bg-surface px-2 py-0.5 font-sans text-[11px] text-inksoft">
          Scope: {scope}
        </span>
      ) : null}
    </div>
  );
}

interface DiscoveredDatasource {
  id: string;
  name: string;
  type: string;
  status: string;
  dataScopeMode: string;
}

export default function OpenDocsPage() {
  const [lang, setLang] = useState<CodeLang>("curl");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [datasourceIdInput, setDatasourceIdInput] = useState("");

  // Try-It-Out state (never persists API key anywhere)
  const [discoveredDs, setDiscoveredDs] = useState<DiscoveredDatasource[]>([]);
  const [tryQuestion, setTryQuestion] = useState("统计最近 30 天核心业务指标趋势");
  const [tryRunning, setTryRunning] = useState(false);
  const [tryOutput, setTryOutput] = useState<{
    title: string;
    status: number;
    headers: Record<string, string>;
    body: unknown;
  } | null>(null);
  const [tryError, setTryError] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8080";
  const keyDisplay = apiKeyInput.trim() || "dc_open_YOUR_API_KEY";
  const dsDisplay = datasourceIdInput.trim() || "<DATASOURCE_ID>";

  const runTry = async (
    title: string,
    path: string,
    opts: { method?: "GET" | "POST"; body?: unknown },
    onSuccess?: (body: unknown) => void,
  ) => {
    if (!apiKeyInput.trim()) {
      setTryError("请先在上方或此处填入管理员签发的 API Key（dc_open_...）");
      return;
    }
    setTryError(null);
    setTryRunning(true);
    try {
      const res = await openApiTryRequest(path, {
        apiKey: apiKeyInput.trim(),
        method: opts.method,
        body: opts.body,
      });
      setTryOutput({ title, ...res });
      if (res.status >= 200 && res.status < 300 && onSuccess) {
        onSuccess(res.body);
      }
    } catch (error) {
      setTryError(error instanceof Error ? error.message : "请求失败，请检查网络或服务地址");
    } finally {
      setTryRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas text-ink">
      {/* Top Header */}
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <BrandMark />
            <div className="h-4 w-px bg-line" />
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-brandtext" />
              <span className="text-sm font-semibold text-ink">开放平台开发者文档</span>
              <span className="rounded bg-brandsoft px-1.5 py-0.5 text-[11px] font-medium text-brandtext">
                v1
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="/api/open/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-inksoft transition-colors hover:bg-subtle hover:text-ink"
            >
              <FileJson className="h-3.5 w-3.5" />
              OpenAPI 3.1 JSON
              <ExternalLink className="h-3 w-3" />
            </a>
            <Link
              to="/chat"
              className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-inksoft transition-colors hover:bg-subtle hover:text-ink"
            >
              进入 DataChat
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-8 px-6 py-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Sticky Left TOC */}
        <aside className="hidden lg:block">
          <nav aria-label="文档目录" className="sticky top-20 space-y-1">
            <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              接入指南
            </p>
            {TOC_ITEMS.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="block rounded-lg px-2.5 py-1.5 text-[13px] text-inksoft transition-colors hover:bg-subtle hover:text-ink"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="min-w-0 space-y-10 pb-20">
          {/* Hero & Inline Configurator */}
          <section className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
            <div className="space-y-2">
              <h1 className="text-2xl font-bold tracking-tight text-ink">
                DataChat 开放平台接入文档
              </h1>
              <p className="text-sm leading-relaxed text-inksoft">
                将 DataChat 的<strong>语义层指标口径</strong>、<strong>AST 只读 SQL 守卫</strong>、
                <strong>行级数据权限（RLS）</strong>与<strong>多步分析报告引擎</strong>
                直接集成到你现有的业务问答、BI 报表、CRM/ERP 或 AI Agent（Dify / Coze / 自研编排）中。
              </p>
            </div>

            <div className="grid gap-3 rounded-xl border border-line bg-subtle/50 p-4 sm:grid-cols-2">
              <label className="block space-y-1 text-xs">
                <span className="flex items-center gap-1 font-medium text-inksoft">
                  <KeyRound className="h-3.5 w-3.5" />
                  填入你的 API Key（仅用于替换下方示例与在线试调，绝不保存）
                </span>
                <Input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="dc_open_..."
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-inksoft">
                  默认 Datasource ID（可选，替换示例代码中的占位符）
                </span>
                <Input
                  value={datasourceIdInput}
                  onChange={(e) => setDatasourceIdInput(e.target.value)}
                  placeholder="例如：550e8400-e29b-41d4-a716-446655440000"
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-2 text-xs text-muted">
              <span>Base URL:</span>
              <code className="rounded bg-subtle px-2 py-0.5 text-ink">{origin}/api/open/v1</code>
              <span>·</span>
              <span>MCP Endpoint:</span>
              <code className="rounded bg-subtle px-2 py-0.5 text-ink">{origin}/api/open/v1/mcp</code>
            </div>
          </section>

          {/* 1. Quick Start */}
          <section id="quickstart" className="scroll-mt-20 space-y-4">
            <h2 className="text-lg font-semibold text-ink">一、快速开始（3 步完成接入）</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {[
                {
                  step: "Step 1",
                  title: "向平台管理员申请 API Key",
                  desc: "管理员在「管理后台 → 开放平台」新建应用、绑定服务账号、授权数据源与能力 Scope，并签发 dc_open_... 密钥。",
                },
                {
                  step: "Step 2",
                  title: "发现数据源与指标口径",
                  desc: "调用 GET /api/open/v1/datasources 获取已授权 datasourceId，必要时读取语义层指标与关联定义。",
                },
                {
                  step: "Step 3",
                  title: "发起问数 / 报告或挂载 MCP",
                  desc: "通过 POST /api/open/v1/ask 或 /reports/generate 获取纯净结构化结果，或直接把 /api/open/v1/mcp 挂入你的 Agent。",
                },
              ].map((card) => (
                <div key={card.step} className="rounded-xl border border-line bg-surface p-4">
                  <span className="rounded bg-brandsoft px-2 py-0.5 text-[11px] font-semibold text-brandtext">
                    {card.step}
                  </span>
                  <h3 className="mt-2 text-sm font-semibold text-ink">{card.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{card.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* 2. Auth & RLS */}
          <section id="auth-rls" className="scroll-mt-20 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-brandtext" />
              <h2 className="text-lg font-semibold text-ink">二、认证与行级数据权限（RLS）透传</h2>
            </div>
            <p className="text-sm text-inksoft">
              所有开放接口（除只读的 <code className="rounded bg-subtle px-1.5 py-0.5 text-xs">/openapi.json</code>）均通过请求头鉴权，不依赖浏览器 Cookie：
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-inksoft">
              <li>
                <code>Authorization: Bearer dc_open_...</code>（推荐）或 <code>X-API-Key: dc_open_...</code>
              </li>
              <li>
                <strong>数据隔离与最小权限</strong>：每个应用绑定一个服务账号并可进一步限制数据源白名单；运行记录、数据集和报告按应用严格隔离，跨应用访问统一返回 <code>404</code>。
              </li>
              <li>
                <strong>终端用户与行级过滤（endUser）</strong>：当管理员为应用开启「允许行级身份透传」后，可在请求体传入 <code>endUser</code>：
                <code>username</code>（映射本系统用户）、<code>departmentCodes</code>（部门编码）或 <code>externalOrgCodes</code>（外部组织映射码）。
                <strong>严格 fail-closed</strong>：任意编码不存在、已归档、缺映射或超出服务账号部门子树时，在建立数据库连接前直接返回 <code>403</code>。
              </li>
            </ul>
            <CodeBlock
              lang={lang}
              onLangChange={setLang}
              snippets={{
                curl: `# 传入外部用户与组织编码，自动触发受控数据源的行级 SQL 改写
curl -X POST "${origin}/api/open/v1/ask" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "datasourceId": "${dsDisplay}",
    "question": "本月各门店营收排名",
    "mode": "sync",
    "endUser": {
      "externalUserId": "crm_u_1024",
      "externalOrgCodes": ["ORG_EAST_SH"]
    }
  }'`,
              }}
            />
          </section>

          {/* 3. Discovery & Semantic */}
          <section id="discovery" className="scroll-mt-20 space-y-3">
            <h2 className="text-lg font-semibold text-ink">三、数据源发现与语义层元数据</h2>
            <EndpointBadge method="GET" path="/api/open/v1/datasources" scope="semantic / ask / report" />
            <EndpointBadge method="GET" path="/api/open/v1/datasources/{id}/semantic" scope="semantic" />
            <p className="text-xs text-muted">
              返回数据源基本信息与语义层指标、表关联及已验证 Few-Shot 示例（绝不暴露数据库主机、账号、密码；当应用关闭 exposeSql 时自动隐藏 SQL 表达式）。
            </p>
            <CodeBlock
              lang={lang}
              onLangChange={setLang}
              snippets={{
                curl: `curl -X GET "${origin}/api/open/v1/datasources" \\
  -H "Authorization: Bearer ${keyDisplay}"`,
                ts: `const res = await fetch("${origin}/api/open/v1/datasources", {
  headers: { Authorization: "Bearer ${keyDisplay}" },
});
const { items } = await res.json();
console.log(items);`,
                python: `import requests

resp = requests.get(
    "${origin}/api/open/v1/datasources",
    headers={"Authorization": "Bearer ${keyDisplay}"},
    timeout=30,
)
resp.raise_for_status()
print(resp.json()["items"])`,
              }}
            />
          </section>

          {/* 4. Structured Ask API */}
          <section id="ask" className="scroll-mt-20 space-y-3">
            <h2 className="text-lg font-semibold text-ink">四、结构化精准问答与取数（Ask API）</h2>
            <EndpointBadge method="POST" path="/api/open/v1/ask" scope="ask" />
            <EndpointBadge method="GET" path="/api/open/v1/runs/{id}" scope="ask / report" />
            <EndpointBadge method="GET" path="/api/open/v1/artifacts/{id}/rows?offset=0&limit=100" scope="ask / report" />
            <p className="text-xs leading-relaxed text-inksoft">
              返回结果自动剔除 DataChat 内部渲染标记，直接交付纯净 <code>answer</code>、结构化 <code>datasets[]</code>（含预览行与分页拉取地址）、<code>charts[]</code>（ECharts Spec）及 <code>lineage</code>（命中的语义指标、行级数据范围与可选 SQL）。传入相同的 <code>externalSessionId</code> 即可无缝实现多轮下钻追问。
            </p>
            <CodeBlock
              lang={lang}
              onLangChange={setLang}
              snippets={{
                curl: `curl -X POST "${origin}/api/open/v1/ask" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "datasourceId": "${dsDisplay}",
    "question": "统计近 30 天各渠道销售额与环比增速",
    "mode": "sync",
    "externalSessionId": "biz-chat-001"
  }'`,
                ts: `const res = await fetch("${origin}/api/open/v1/ask", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${keyDisplay}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    datasourceId: "${dsDisplay}",
    question: "统计近 30 天各渠道销售额与环比增速",
    mode: "sync",
    externalSessionId: "biz-chat-001",
  }),
});
const data = await res.json();
// data.answer, data.datasets, data.charts, data.lineage`,
                python: `import requests

resp = requests.post(
    "${origin}/api/open/v1/ask",
    headers={"Authorization": "Bearer ${keyDisplay}"},
    json={
        "datasourceId": "${dsDisplay}",
        "question": "统计近 30 天各渠道销售额与环比增速",
        "mode": "sync",
        "externalSessionId": "biz-chat-001",
    },
    timeout=120,
)
data = resp.json()
print(data["answer"])
print("datasets:", len(data["datasets"]), "charts:", len(data["charts"]))`,
              }}
            />
          </section>

          {/* 5. SSE Streaming */}
          <section id="stream" className="scroll-mt-20 space-y-3">
            <h2 className="text-lg font-semibold text-ink">五、SSE 流式输出与断线回放</h2>
            <EndpointBadge method="POST" path='/api/open/v1/ask  (body: { "mode": "stream" })' scope="ask" />
            <EndpointBadge method="GET" path="/api/open/v1/runs/{id}/stream" scope="ask / report" />
            <p className="text-xs leading-relaxed text-inksoft">
              流式响应采用标准 <code>text/event-stream</code>，依次推送 <code>run_start</code>、<code>tool_start</code>、<code>tool_end</code>、<code>sql</code>（受 <code>exposeSql</code> 控制）、<code>result</code>、<code>chart</code>、<code>text_delta</code>、<code>run_end</code>，并在结束时附加一条完整的 <code>open_result</code> 结构化事件。断线重连时传 <code>Last-Event-ID</code> 请求头或 <code>?after=&lt;seq&gt;</code> 即可无重复补全。
            </p>
            <CodeBlock
              lang={lang}
              onLangChange={setLang}
              snippets={{
                curl: `curl -N -X POST "${origin}/api/open/v1/ask" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "datasourceId": "${dsDisplay}",
    "question": "分析本月退单率异常原因",
    "mode": "stream"
  }'`,
              }}
            />
          </section>

          {/* 6. Report Generation */}
          <section id="reports" className="scroll-mt-20 space-y-3">
            <h2 className="text-lg font-semibold text-ink">六、模板化精准报告生成（Report API）</h2>
            <EndpointBadge method="POST" path="/api/open/v1/reports/generate" scope="report" />
            <EndpointBadge method="GET" path="/api/open/v1/reports/{id}" scope="report" />
            <p className="text-xs leading-relaxed text-inksoft">
              支持指定报告标题（<code>title</code>）、章节大纲（<code>sections</code>）、模板（<code>template</code>）和业务参数（<code>parameters</code>）。建议耗时较长的多章节报告使用 <code>mode: &quot;async&quot;</code>，系统会在生成完成后自动通过 Webhook 推送完整报告。
            </p>
            <CodeBlock
              lang={lang}
              onLangChange={setLang}
              snippets={{
                curl: `curl -X POST "${origin}/api/open/v1/reports/generate" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "datasourceId": "${dsDisplay}",
    "title": "华东区月度经营分析报告",
    "prompt": "结合销售额、订单量与退单率生成月度经营总结",
    "sections": ["核心指标概览", "分渠道趋势分析", "异常波动与改进建议"],
    "parameters": { "period": "2026-10", "region": "华东" },
    "mode": "async"
  }'`,
                python: `import requests

resp = requests.post(
    "${origin}/api/open/v1/reports/generate",
    headers={"Authorization": "Bearer ${keyDisplay}"},
    json={
        "datasourceId": "${dsDisplay}",
        "title": "华东区月度经营分析报告",
        "prompt": "结合销售额、订单量与退单率生成月度经营总结",
        "sections": ["核心指标概览", "分渠道趋势分析", "异常波动与改进建议"],
        "parameters": {"period": "2026-10", "region": "华东"},
        "mode": "async",
    },
    timeout=30,
)
print(resp.status_code, resp.json())  # 202 + runId`,
              }}
            />
          </section>

          {/* 7. Feedback Loop */}
          <section id="feedback" className="scroll-mt-20 space-y-3">
            <h2 className="text-lg font-semibold text-ink">七、反馈回流（越用越准飞轮）</h2>
            <EndpointBadge method="POST" path="/api/open/v1/feedback" scope="feedback" />
            <p className="text-xs text-inksoft">
              将外部业务前端的点赞（<code>1</code>）/ 点踩（<code>-1</code>）与纠错意见回传至 DataChat，管理员可在「数据源 → 语义层 → 问答反馈」中一键沉淀为 Few-Shot 验证 SQL 示例。
            </p>
            <CodeBlock
              lang={lang}
              onLangChange={setLang}
              snippets={{
                curl: `curl -X POST "${origin}/api/open/v1/feedback" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "runId": "<RUN_ID>",
    "rating": 1,
    "comment": "销售额口径与财务报表完全一致",
    "externalUserId": "crm_u_1024"
  }'`,
              }}
            />
          </section>

          {/* 8. Remote MCP Server */}
          <section id="mcp" className="scroll-mt-20 space-y-3">
            <div className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-brandtext" />
              <h2 className="text-lg font-semibold text-ink">八、远程 MCP Server（Dify / Coze / Agent 直连）</h2>
            </div>
            <EndpointBadge method="POST" path="/api/open/v1/mcp" scope="mcp" />
            <p className="text-xs leading-relaxed text-inksoft">
              如果其他业务已有 AI Agent 编排框架（如 Dify、Coze、Cursor、Claude 或自研工作流），无需手写胶水代码，直接以 Streamable HTTP MCP 方式挂载即可获得 <code>list_datasources</code>、<code>get_semantic_layer</code>、<code>ask_data</code>、<code>generate_report</code> 四个工具。
            </p>
            <CodeBlock
              lang={lang}
              onLangChange={setLang}
              snippets={{
                curl: `# MCP 客户端通用配置（JSON）
{
  "mcpServers": {
    "datachat": {
      "type": "http",
      "url": "${origin}/api/open/v1/mcp",
      "headers": {
        "Authorization": "Bearer ${keyDisplay}"
      }
    }
  }
}

# 手动测试 tools/list
curl -X POST "${origin}/api/open/v1/mcp" \\
  -H "Authorization: Bearer ${keyDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
              }}
            />
          </section>

          {/* 9. Webhook HMAC */}
          <section id="webhook" className="scroll-mt-20 space-y-3">
            <div className="flex items-center gap-2">
              <Webhook className="h-5 w-5 text-brandtext" />
              <h2 className="text-lg font-semibold text-ink">九、Webhook 异步回调与 HMAC-SHA256 验签</h2>
            </div>
            <p className="text-xs leading-relaxed text-inksoft">
              异步问答或报告完成/失败时，DataChat 会向应用配置的 <code>webhookUrl</code> 发起 POST 回调（事件：<code>ask.completed</code>、<code>ask.failed</code>、<code>report.completed</code>、<code>report.failed</code>），并附带请求头：<code>X-DataChat-Event</code>、<code>X-DataChat-Delivery</code>、<code>X-DataChat-Timestamp</code> 与 <code>X-DataChat-Signature: t=&lt;ts&gt;,v1=&lt;hex&gt;</code>。
            </p>
            <CodeBlock
              lang={lang}
              onLangChange={setLang}
              snippets={{
                ts: `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyDataChatWebhook(
  secret: string,
  timestampHeader: string,
  signatureHeader: string,
  rawBody: string,
): boolean {
  const expected = "t=" + timestampHeader + ",v1=" +
    createHmac("sha256", secret).update(timestampHeader + "." + rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}`,
                python: `import hashlib, hmac

def verify_datachat_webhook(secret: str, timestamp: str, signature: str, raw_body: str) -> bool:
    digest = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.{raw_body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    expected = f"t={timestamp},v1={digest}"
    return hmac.compare_digest(expected, signature)`,
              }}
            />
          </section>

          {/* 10. Error Codes & Rate Limits */}
          <section id="errors" className="scroll-mt-20 space-y-3">
            <h2 className="text-lg font-semibold text-ink">十、错误码与限流说明</h2>
            <p className="text-xs text-inksoft">
              所有错误统一返回 <code>{"{ error: { code, message, details? } }"}</code>；每次响应均附带 <code>X-RateLimit-Limit</code> 与 <code>X-RateLimit-Remaining</code>，触发 429 时附带 <code>Retry-After</code>（秒）。
            </p>
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line bg-subtle text-inksoft">
                  <tr>
                    <th className="px-3 py-2 font-medium">HTTP</th>
                    <th className="px-3 py-2 font-medium">错误码</th>
                    <th className="px-3 py-2 font-medium">含义与排查方式</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line text-inksoft">
                  {[
                    ["401", "API_KEY_REQUIRED / INVALID / REVOKED / EXPIRED", "检查请求头 Bearer / X-API-Key 是否正确或已吊销/过期"],
                    ["403", "APP_DISABLED / SERVICE_USER_DISABLED", "应用或绑定的服务账号已被管理员停用"],
                    ["403", "SCOPE_DENIED / DATASOURCE_FORBIDDEN", "应用未开通对应能力 Scope 或无权访问目标数据源"],
                    ["403", "END_USER_OVERRIDE_DISABLED", "传入了 endUser 但应用未开启「允许行级身份透传」"],
                    ["403", "DATA_SCOPE_INVALID_DEPARTMENT / MAPPING_MISSING / OUT_OF_BOUNDS", "部门码无效、未配置外部组织映射或超出服务账号部门子树（fail-closed）"],
                    ["404", "NOT_FOUND / SESSION_NOT_FOUND", "目标运行/数据集/报告不存在或不属于当前应用"],
                    ["429", "RATE_LIMITED", "超出应用每分钟 RPM 配额，请按 Retry-After 退避重试"],
                  ].map(([http, code, desc]) => (
                    <tr key={code}>
                      <td className="px-3 py-2 font-mono font-semibold text-ink">{http}</td>
                      <td className="px-3 py-2 font-mono text-ink">{code}</td>
                      <td className="px-3 py-2">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 11. Interactive Try-It-Out */}
          <section id="try-it" className="scroll-mt-20 space-y-4 rounded-2xl border border-line bg-surface p-6">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-ink">十一、在线接口试调（免登录，使用你的 API Key）</h2>
              <p className="text-xs text-muted">
                粘贴管理员提供的 API Key 后，即可直接验证数据源权限、发起精准问数或探测 MCP 工具列表。
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={tryRunning}
                onClick={() =>
                  void runTry(
                    "GET /api/open/v1/datasources",
                    "/api/open/v1/datasources",
                    { method: "GET" },
                    (body) => {
                      const items = (body as { items?: DiscoveredDatasource[] })?.items;
                      if (Array.isArray(items)) {
                        setDiscoveredDs(items);
                        if (!datasourceIdInput && items[0]?.id) {
                          setDatasourceIdInput(items[0].id);
                        }
                      }
                    },
                  )
                }
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                1. 获取可用数据源
              </Button>

              <Button
                size="sm"
                variant="outline"
                disabled={tryRunning}
                onClick={() =>
                  void runTry("POST /api/open/v1/mcp (tools/list)", "/api/open/v1/mcp", {
                    method: "POST",
                    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
                  })
                }
              >
                <Terminal className="mr-1.5 h-3.5 w-3.5" />
                2. 探测 MCP 工具列表
              </Button>
            </div>

            {discoveredDs.length > 0 ? (
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-inksoft">已发现数据源（点击自动填入 Datasource ID）</span>
                <select
                  aria-label="试调数据源选择"
                  value={datasourceIdInput}
                  onChange={(e) => setDatasourceIdInput(e.target.value)}
                  className="w-full max-w-md rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
                >
                  {discoveredDs.map((ds) => (
                    <option key={ds.id} value={ds.id}>
                      {ds.name} ({ds.type}) — {ds.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="space-y-2">
              <label className="block space-y-1 text-xs">
                <span className="font-medium text-inksoft">试调问题（POST /api/open/v1/ask）</span>
                <Textarea
                  rows={2}
                  value={tryQuestion}
                  onChange={(e) => setTryQuestion(e.target.value)}
                />
              </label>
              <Button
                size="sm"
                disabled={tryRunning || !datasourceIdInput.trim() || !tryQuestion.trim()}
                onClick={() =>
                  void runTry("POST /api/open/v1/ask", "/api/open/v1/ask", {
                    method: "POST",
                    body: {
                      datasourceId: datasourceIdInput.trim(),
                      question: tryQuestion.trim(),
                      mode: "sync",
                    },
                  })
                }
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                {tryRunning ? "请求执行中…" : "3. 发送结构化问数请求"}
              </Button>
            </div>

            {tryError ? (
              <p role="alert" className="rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
                {tryError}
              </p>
            ) : null}

            {tryOutput ? (
              <div className="space-y-2 rounded-xl border border-line bg-subtle/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-mono font-medium text-ink">{tryOutput.title}</span>
                  <span
                    className={`rounded px-2 py-0.5 font-mono font-semibold ${
                      tryOutput.status >= 200 && tryOutput.status < 300
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "bg-dangersoft text-danger"
                    }`}
                  >
                    HTTP {tryOutput.status}
                  </span>
                </div>
                <pre className="max-h-80 overflow-auto rounded-lg bg-surface p-3 text-xs text-ink">
                  {typeof tryOutput.body === "string"
                    ? tryOutput.body
                    : JSON.stringify(tryOutput.body, null, 2)}
                </pre>
              </div>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}
