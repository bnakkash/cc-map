/**
 * Markdown content renderer for a Claude Code message. Heavy: pulls in
 * react-markdown + remark-gfm + rehype-highlight + highlight.js (CSS + lexers).
 * Exported as default so React.lazy() can split it into a separate chunk —
 * the initial app bundle stays light until you click a node.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import type { NodeResponse } from "../api.js";

export default function ContentRender({ data }: { data: NodeResponse }) {
  const raw = data.raw as { message?: { content?: unknown } } | null;
  const content = raw?.message?.content;
  if (typeof content === "string") {
    return (
      <div className="md-body text-zinc-200">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{content}</ReactMarkdown>
      </div>
    );
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2 text-zinc-200">
        {content.map((block, i) => <BlockRender key={i} block={block} />)}
      </div>
    );
  }
  return <div className="text-zinc-500 italic">(empty)</div>;
}

function BlockRender({ block }: { block: unknown }) {
  if (!block || typeof block !== "object") {
    return <pre className="text-xs text-zinc-500">{JSON.stringify(block, null, 2)}</pre>;
  }
  const b = block as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };
  if (b.type === "text" && typeof b.text === "string") {
    return <div className="md-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{b.text}</ReactMarkdown></div>;
  }
  if (b.type === "tool_use") {
    return (
      <details className="border border-blue-900/50 bg-blue-950/20 rounded p-2 text-xs">
        <summary className="cursor-pointer text-blue-400 font-mono">🔧 {b.name ?? "tool"}</summary>
        <pre className="mt-2 overflow-x-auto text-blue-200">{JSON.stringify(b.input, null, 2)}</pre>
      </details>
    );
  }
  if (b.type === "tool_result") {
    const text =
      typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n")
          : "";
    return (
      <details className="border border-zinc-800 bg-zinc-900/40 rounded p-2 text-xs">
        <summary className="cursor-pointer text-zinc-400 font-mono">📨 tool_result</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-zinc-300">{text}</pre>
      </details>
    );
  }
  return <pre className="text-xs text-zinc-500">{JSON.stringify(block, null, 2)}</pre>;
}
