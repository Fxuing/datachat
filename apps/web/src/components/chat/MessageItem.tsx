import { Bot } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../../lib/api";
import { ResultTable } from "./ResultTable";
import { SqlCard } from "./SqlCard";
import { ToolCard } from "./ToolCard";

export function MarkdownText({ content }: { content: string }) {
  return (
    <div className="markdown text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function UserBubble({ content, pending = false }: { content: string; pending?: boolean }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-neutral-900 px-4 py-2.5 text-sm text-neutral-50">
        {content}
        {pending ? <span className="ml-2 text-[10px] text-neutral-400">发送中…</span> : null}
      </div>
    </div>
  );
}

export function MessageItem({ message }: { message: ChatMessage }) {
  const assistantText = message.assistant?.content ?? "";

  return (
    <div className="flex flex-col gap-3">
      <UserBubble content={message.user.content} />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-neutral-400">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-neutral-200 text-neutral-600">
            <Bot className="h-3.5 w-3.5" />
          </span>
          DataChat
        </div>
        {message.tools.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {message.tools.map((tool) => (
              <ToolCard key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        ) : null}
        {message.sqls.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {message.sqls.map((sql) => (
              <SqlCard key={sql.auditId} sql={sql} />
            ))}
          </div>
        ) : null}
        {message.results.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {message.results.map((result) => (
              <ResultTable key={result.artifactId} {...result} />
            ))}
          </div>
        ) : null}
        {assistantText ? <MarkdownText content={assistantText} /> : null}
        {message.status === "aborted" ? (
          <p className="text-xs text-neutral-500">已停止生成</p>
        ) : null}
        {message.status === "error" && !assistantText ? (
          <p className="text-xs text-red-600">
            {message.error ?? "本次回答失败，请重试。"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
