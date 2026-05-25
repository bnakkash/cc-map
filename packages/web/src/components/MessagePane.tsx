import { lazy, Suspense, useEffect, useState } from "react";
import { api, type NodeResponse } from "../api.js";
import { useStore } from "../store.js";

// Reuse the map's renderer (react-markdown + rehype-highlight). Lazy so the
// highlight.js bundle only loads once a message is actually opened.
const ContentRender = lazy(() => import("./ContentRender.js"));

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
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        Click a chip on the left to read the message.
        <br />
        Hint: <kbd className="px-1 mx-1 bg-zinc-800 rounded text-zinc-300">n</kbd> jumps to next unread reply.
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

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-950">
      <div className="max-w-4xl mx-auto px-6 py-6">
        <Header data={data} />
        <div className="mt-4">
          <Suspense fallback={<div className="text-zinc-500 italic">loading renderer…</div>}>
            <ContentRender data={data} />
          </Suspense>
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
