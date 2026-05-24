import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type NodeResponse } from "../api.js";
import { buildLayout } from "../canvas/layout.js";
import {
  MAX_SCALE,
  MIN_SCALE,
  type Transform,
  fitTransform,
  hitTest,
  render,
} from "../canvas/renderer.js";
import type { ForestPayload, Layout, ViewMode } from "../canvas/types.js";

const PAN_THRESHOLD_PX = 5;

export function TreeMap({ onClose }: { onClose: () => void }) {
  const [forest, setForest] = useState<ForestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("per-project");
  const [scopeProject, setScopeProject] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<NodeResponse | null>(null);
  const transformRef = useRef<Transform>({ tx: 0, ty: 0, scale: 1 });
  const hoveredRef = useRef<string | null>(null);
  const dirtyRef = useRef(true);

  // Fetch forest once
  useEffect(() => {
    fetch("/api/forest", {
      headers: { Authorization: `Bearer ${localStorage.getItem("cc-map-token") ?? ""}` },
    })
      .then((r) => r.json())
      .then((data: ForestPayload) => {
        setForest(data);
        if (data.projects.length > 0 && !scopeProject) {
          // Default scope: project with most sessions
          const top = [...data.projects].sort((a, b) => b.sessionCount - a.sessionCount)[0]!;
          setScopeProject(top.slug);
        }
      })
      .catch((e) => setError(String(e)));
  }, [scopeProject]);

  // Build layout when forest, mode, or scope changes
  const layout: Layout | null = useMemo(() => {
    if (!forest) return null;
    const t0 = performance.now();
    const l = buildLayout(forest, mode, mode === "per-project" ? scopeProject : null);
    const elapsed = performance.now() - t0;
    console.log(`layout: ${l.nodes.size} nodes in ${elapsed.toFixed(0)}ms`);
    return l;
  }, [forest, mode, scopeProject]);

  // Canvas + size tracking
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const r = e.contentRect;
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
      dirtyRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit on layout change (only first time)
  const fittedKey = useRef<string>("");
  useEffect(() => {
    if (!layout) return;
    const key = `${mode}::${scopeProject}::${size.w}x${size.h}`;
    if (fittedKey.current === key) return;
    if (size.w === 0 || size.h === 0) return;
    transformRef.current = fitTransform(layout, size.w, size.h);
    fittedKey.current = key;
    dirtyRef.current = true;
  }, [layout, mode, scopeProject, size]);

  // RAF render loop — only redraws when dirty
  useEffect(() => {
    if (!layout) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const tick = () => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== size.w * dpr || canvas.height !== size.h * dpr) {
          canvas.width = size.w * dpr;
          canvas.height = size.h * dpr;
          canvas.style.width = `${size.w}px`;
          canvas.style.height = `${size.h}px`;
        }
        render(
          ctx,
          layout,
          {
            transform: transformRef.current,
            selectedId: selected,
            hoveredId: hoveredRef.current,
            mode,
            showLabels: transformRef.current.scale > 1.2,
          },
          size.w,
          size.h,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layout, size, selected, mode]);

  // Pan/zoom/click handlers
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number; moved: boolean } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTx: transformRef.current.tx,
      startTy: transformRef.current.ty,
      moved: false,
    };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > PAN_THRESHOLD_PX) drag.moved = true;
      if (drag.moved) {
        transformRef.current = {
          ...transformRef.current,
          tx: drag.startTx + dx,
          ty: drag.startTy + dy,
        };
        dirtyRef.current = true;
      }
    } else if (layout) {
      const rect = e.currentTarget.getBoundingClientRect();
      const id = hitTest(layout, transformRef.current, e.clientX - rect.left, e.clientY - rect.top);
      if (id !== hoveredRef.current) {
        hoveredRef.current = id;
        e.currentTarget.style.cursor = id ? "pointer" : "grab";
        dirtyRef.current = true;
      }
    }
  }, [layout]);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved) return; // it was a pan
    if (!layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const id = hitTest(layout, transformRef.current, e.clientX - rect.left, e.clientY - rect.top);
    setSelected(id);
    dirtyRef.current = true;
  }, [layout]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const t = transformRef.current;
    const factor = Math.exp(-e.deltaY * 0.001);
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.scale * factor));
    if (newScale === t.scale) return;
    // Zoom around mouse position
    const lx = (sx - t.tx) / t.scale;
    const ly = (sy - t.ty) / t.scale;
    transformRef.current = {
      scale: newScale,
      tx: sx - lx * newScale,
      ty: sy - ly * newScale,
    };
    dirtyRef.current = true;
  }, []);

  // Fetch selected node detail for the side panel
  useEffect(() => {
    if (!selected || !forest) {
      setSelectedDetail(null);
      return;
    }
    const node = forest.nodes.find((n) => n.id === selected);
    if (!node) return;
    let cancelled = false;
    api.node(node.sessionId, node.id).then((r) => {
      if (!cancelled) setSelectedDetail(r);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected, forest]);

  // Fit-to-content keybind
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT") return;
      if (e.key === "f") {
        if (!layout) return;
        transformRef.current = fitTransform(layout, size.w, size.h);
        dirtyRef.current = true;
      } else if (e.key === "Escape") {
        if (selected) setSelected(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, size, selected, onClose]);

  if (error) {
    return <div className="flex-1 flex items-center justify-center text-red-400">{error}</div>;
  }
  if (!forest) {
    return <div className="flex-1 flex items-center justify-center text-zinc-500">loading forest…</div>;
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sidebar */}
      <div className="w-56 border-r border-zinc-800 bg-zinc-950 p-3 space-y-3 text-sm overflow-y-auto">
        <div>
          <div className="text-zinc-500 text-xs mb-1">View</div>
          <div className="flex gap-1">
            <button
              className={`px-2 py-1 rounded text-xs ${mode === "per-project" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
              onClick={() => setMode("per-project")}
            >
              per-project
            </button>
            <button
              className={`px-2 py-1 rounded text-xs ${mode === "all-projects" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
              onClick={() => setMode("all-projects")}
            >
              all
            </button>
          </div>
        </div>
        {mode === "per-project" && (
          <div>
            <div className="text-zinc-500 text-xs mb-1">Project ({forest.projects.length})</div>
            <div className="space-y-0.5 max-h-[60vh] overflow-y-auto">
              {[...forest.projects].sort((a, b) => b.sessionCount - a.sessionCount).map((p) => (
                <button
                  key={p.slug}
                  onClick={() => setScopeProject(p.slug)}
                  className={`w-full text-left px-2 py-1 rounded text-xs truncate ${scopeProject === p.slug ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800"}`}
                  title={p.slug}
                >
                  {prettySlug(p.slug)} <span className="text-zinc-600">({p.sessionCount})</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="text-xs text-zinc-500 pt-2 border-t border-zinc-800 space-y-1">
          <div>{forest.nodes.length.toLocaleString()} nodes · {forest.sessionCount} sessions</div>
          <div>{forest.forks.length} forks</div>
          <div className="pt-2 text-zinc-600">
            <div>drag = pan</div>
            <div>wheel = zoom</div>
            <div>f = fit</div>
            <div>esc = back</div>
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        <canvas
          ref={canvasRef}
          style={{ cursor: "grab", display: "block" }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => { dragRef.current = null; hoveredRef.current = null; dirtyRef.current = true; }}
          onWheel={onWheel}
        />
      </div>

      {/* Side detail panel */}
      {selected && (
        <div className="w-[480px] border-l border-zinc-800 bg-zinc-950 overflow-y-auto">
          <div className="p-3 border-b border-zinc-800 flex items-center gap-2 text-xs">
            <span className="text-zinc-400 font-mono">{selected.slice(0, 8)}</span>
            <button onClick={() => setSelected(null)} className="ml-auto text-zinc-500 hover:text-zinc-300">✕</button>
          </div>
          <div className="p-3 text-sm">
            {selectedDetail ? (
              <RawDetail data={selectedDetail} />
            ) : (
              <div className="text-zinc-500">loading…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function prettySlug(s: string): string {
  return s.replace(/^C--Users-[^-]+-/, "~/").replace(/-+/g, "/");
}

function RawDetail({ data }: { data: NodeResponse }) {
  const raw = data.raw as { message?: { content?: unknown } } | null;
  const content = raw?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b) => {
              if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text);
              if (b && typeof b === "object" && "type" in b) return `[${String((b as { type: unknown }).type)}]`;
              return "";
            })
            .join("\n\n")
        : "";
  return (
    <div>
      <div className="text-xs text-zinc-500 font-mono mb-2 space-y-0.5">
        <div>{data.node.role}{data.node.subtype ? `:${data.node.subtype}` : ""}</div>
        <div>{new Date(data.node.timestamp).toLocaleString()}</div>
        <div className="truncate" title={data.node.projectSlug}>{data.node.projectSlug}</div>
      </div>
      <pre className="whitespace-pre-wrap text-zinc-200 text-xs bg-zinc-900/50 p-2 rounded max-h-[70vh] overflow-y-auto">
        {text.slice(0, 8000)}
        {text.length > 8000 ? "\n\n…truncated…" : ""}
      </pre>
    </div>
  );
}
