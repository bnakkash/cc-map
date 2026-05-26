import { useCallback, useEffect, useRef, useState } from "react";
import type { Layout } from "../canvas/types.js";
import { projectColor } from "../canvas/colors.js";
import type { Transform } from "../canvas/renderer.js";

interface MinimapProps {
  layout: Layout | null;
  viewportWidth: number;
  viewportHeight: number;
  getTransform: () => Transform;
  /** Pan the main view so (lx, ly) is at viewport center. */
  panToLayoutPoint: (lx: number, ly: number) => void;
}

const MM_W = 220;
const MM_H = 150;
const MM_PADDING = 8;

/**
 * Always-visible thumbnail of the full layout with a viewport rectangle.
 *
 * Click anywhere → pan the main view to center there. Drag the viewport rect →
 * pan continuously. Reads the main transform via a polling RAF (transformRef
 * isn't React state, so polling is the simplest cross-component sync).
 */
export function Minimap({
  layout,
  viewportWidth,
  viewportHeight,
  getTransform,
  panToLayoutPoint,
}: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ active: boolean } | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("cc-map-minimap-collapsed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("cc-map-minimap-collapsed", collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);

  // Compute the layout → minimap scale once per (layout, size) change.
  // bounds.minX/minY may be negative; we shift so the layout starts at (0,0)
  // inside the minimap with MM_PADDING border.
  const scaleInfo = useRef<{
    scale: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  useEffect(() => {
    if (!layout) { scaleInfo.current = null; return; }
    const w = layout.bounds.maxX - layout.bounds.minX;
    const h = layout.bounds.maxY - layout.bounds.minY;
    if (w <= 0 || h <= 0) { scaleInfo.current = null; return; }
    const sx = (MM_W - MM_PADDING * 2) / w;
    const sy = (MM_H - MM_PADDING * 2) / h;
    const scale = Math.min(sx, sy);
    scaleInfo.current = {
      scale,
      offsetX: MM_PADDING - layout.bounds.minX * scale,
      offsetY: MM_PADDING - layout.bounds.minY * scale,
    };
  }, [layout]);

  // RAF-driven redraw — polls getTransform() each frame and only repaints if
  // the viewport rect would actually change. Cheap; minimap is tiny.
  useEffect(() => {
    if (collapsed) return;
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MM_W * dpr;
    canvas.height = MM_H * dpr;

    let raf = 0;
    let lastKey = "";

    const draw = () => {
      const info = scaleInfo.current;
      if (!info) { raf = requestAnimationFrame(draw); return; }
      const t = getTransform();
      // Viewport rect in layout coords
      const lx0 = -t.tx / t.scale;
      const ly0 = -t.ty / t.scale;
      const lx1 = (viewportWidth - t.tx) / t.scale;
      const ly1 = (viewportHeight - t.ty) / t.scale;
      const key = `${lx0.toFixed(1)}|${ly0.toFixed(1)}|${lx1.toFixed(1)}|${ly1.toFixed(1)}|${layout.sessionBands.length}`;
      if (key === lastKey) { raf = requestAnimationFrame(draw); return; }
      lastKey = key;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Background
      ctx.fillStyle = "rgba(9, 9, 11, 0.9)";
      ctx.fillRect(0, 0, MM_W, MM_H);
      // Subtle border
      ctx.strokeStyle = "rgba(63, 63, 70, 0.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, MM_W - 1, MM_H - 1);

      // Session bands
      for (const band of layout.sessionBands) {
        const x = band.minX * info.scale + info.offsetX;
        const y = band.minY * info.scale + info.offsetY;
        const w = Math.max(1, (band.maxX - band.minX) * info.scale);
        const h = Math.max(1, (band.maxY - band.minY) * info.scale);
        ctx.fillStyle = projectColor(band.projectSlug);
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x, y, w, h);
      }
      ctx.globalAlpha = 1;

      // Viewport rectangle
      const vx = lx0 * info.scale + info.offsetX;
      const vy = ly0 * info.scale + info.offsetY;
      const vw = (lx1 - lx0) * info.scale;
      const vh = (ly1 - ly0) * info.scale;
      ctx.strokeStyle = "rgba(250, 250, 250, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vx, vy, vw, vh);
      // Faint fill so the box reads even when it overlaps colored bands
      ctx.fillStyle = "rgba(250, 250, 250, 0.08)";
      ctx.fillRect(vx, vy, vw, vh);

      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [layout, viewportWidth, viewportHeight, getTransform, collapsed]);

  // Convert minimap pixel coords → layout coords and pan there.
  const handlePan = useCallback((mmX: number, mmY: number) => {
    const info = scaleInfo.current;
    if (!info) return;
    const lx = (mmX - info.offsetX) / info.scale;
    const ly = (mmY - info.offsetY) / info.scale;
    panToLayoutPoint(lx, ly);
  }, [panToLayoutPoint]);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    handlePan(e.clientX - rect.left, e.clientY - rect.top);
    dragRef.current = { active: true };
    e.stopPropagation();
  }, [handlePan]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current?.active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    handlePan(e.clientX - rect.left, e.clientY - rect.top);
  }, [handlePan]);

  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);

  // Hide when there's nothing meaningful to show
  if (!layout || layout.nodes.size === 0) return null;

  return (
    <div data-tour-id="minimap" className="absolute top-3 right-3 z-20 select-none">
      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          className="bg-zinc-900/90 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 backdrop-blur"
          title="Show minimap"
        >
          minimap
        </button>
      ) : (
        <div className="bg-zinc-900/0">
          <canvas
            ref={canvasRef}
            style={{
              width: `${MM_W}px`,
              height: `${MM_H}px`,
              display: "block",
              cursor: dragRef.current?.active ? "grabbing" : "crosshair",
              borderRadius: 4,
            }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            title="Click or drag to navigate"
          />
          <button
            onClick={() => setCollapsed(true)}
            className="absolute top-1 right-1 w-5 h-5 rounded bg-zinc-900/80 border border-zinc-700 text-zinc-400 text-xs leading-none hover:bg-zinc-800"
            title="Hide minimap"
            aria-label="Hide minimap"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
