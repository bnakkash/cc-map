import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type NodeResponse } from "../api.js";
import { useStore } from "../store.js";

export function MessagePane() {
  const sessionId = useStore((s) => s.selectedSessionId);
  const nodeId = useStore((s) => s.selectedNodeId);
  const [data, setData] = useState<NodeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !nodeId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .node(sessionId, nodeId)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, nodeId]);

  if (!nodeId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
        Click a chip on the left to read the message.
        <br />
        Hint: <kbd className="px-1 mx-1 bg-zinc-800 rounded">n</kbd> jumps to next unread reply.
      </div>
    );
  }
  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-zinc-500">loading…</div>;
  }
  if (error) {
    return <div className="flex-1 flex items-center justify-center text-red-400">{error}</div>;
  }
  if (!data) return null;

  const raw = data.raw as { message?: { content?: unknown } } | null;
  const content = raw?.message?.content;

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-950">
      <div className="max-w-4xl mx-auto px-6 py-6">
        <Header data={data} />
        <div className="mt-4 md-body text-zinc-200">
          <ContentRender content={content} />
        </div>
      </div>
    </div>
  );
}

function Header({ data }: { data: NodeResponse }) {
  const { node } = data;
  return (
    <div className="border-b border-zinc-800 pb-3 mb-3 text-xs text-zinc-500 font-mono flex flex-wrap gap-x-4 gap-y-1">
      <span className={node.role === "assistant" ? "text-amber-400" : "text-emerald-400"}>
        {node.role}
        {node.subtype ? `:${node.subtype}` : ""}
      </span>
      <span>{new Date(node.timestamp).toLocaleString()}</span>
      {node.gitBranch && <span>branch={node.gitBranch}</span>}
      {node.cwd && <span className="truncate max-w-md" title={node.cwd}>cwd={node.cwd}</span>}
      <span className="ml-auto text-zinc-600">{node.id.slice(0, 8)}</span>
    </div>
  );
}

function ContentRender({ content }: { content: unknown }) {
  if (typeof content === "string") {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    );
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-3">
        {content.map((block, i) => (
          <BlockRender key={i} block={block} />
        ))}
      </div>
    );
  }
  return <div className="text-zinc-500 italic">(empty)</div>;
}

function BlockRender({ block }: { block: unknown }) {
  if (!block || typeof block !== "object") {
    return <pre className="text-xs text-zinc-500">{JSON.stringify(block, null, 2)}</pre>;
  }
  const b = block as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string };
  if (b.type === "text" && typeof b.text === "string") {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown>;
  }
  if (b.type === "tool_use") {
    return (
      <details className="border border-blue-900/50 bg-blue-950/20 rounded p-2 text-sm">
        <summary className="cursor-pointer text-blue-400 font-mono">
          🔧 {b.name ?? "tool"}
        </summary>
        <pre className="mt-2 text-xs overflow-x-auto text-blue-200">
          {JSON.stringify(b.input, null, 2)}
        </pre>
      </details>
    );
  }
  if (b.type === "tool_result") {
    const text =
      typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content
              .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
              .join("\n")
          : "";
    return (
      <details className="border border-zinc-800 bg-zinc-900/40 rounded p-2 text-sm">
        <summary className="cursor-pointer text-zinc-400 font-mono">
          📨 tool_result
        </summary>
        <pre className="mt-2 text-xs overflow-x-auto whitespace-pre-wrap text-zinc-300">
          {text}
        </pre>
      </details>
    );
  }
  return <pre className="text-xs text-zinc-500">{JSON.stringify(block, null, 2)}</pre>;
}
