import { useEffect, useRef, useState } from "react";
import type { Layout } from "../canvas/types.js";
import type { Transform } from "../canvas/renderer.js";

interface BookmarkGutterProps {
  bookmarks: Set<string>;
  layout: Layout | null;
  viewportHeight: number;
  getTransform: () => Transform;
  /** Pan main canvas so (lx, ly) is centered. */
  panToLayoutPoint: (lx: number, ly: number) => void;
  /** Hover/click also selects the bookmark node (for side panel / inline card). */
  onSelect: (id: string) => void;
}

interface GutterDot {
  id: string;
  /** Layout-Y of the bookmark node, for click → pan. */
  ly: number;
  /** Layout-X (used as the pan target so the bookmark lands centered). */
  lx: number;
  /** Screen-Y where the star is drawn (clamped + clustered). */
  screenY: number;
  /** Preview text for the title attribute. */
  preview: string;
}

const STAR_SIZE = 14;
const MIN_GAP = 18; // vertical px between adjacent stars before clustering

/**
 * Left-edge "table of contents" of bookmarks currently in layout. Each star
 * sits at its bookmark's screen-Y. Stars closer than MIN_GAP get nudged so
 * they don't pile on top of each other (simple linear pass — good enough for
 * the bookmark counts seen in practice).
 */
export function BookmarkGutter({
  bookmarks,
  layout,
  viewportHeight,
  getTransform,
  panToLayoutPoint,
  onSelect,
}: BookmarkGutterProps) {
  const [dots, setDots] = useState<GutterDot[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bookmarks.size === 0 || !layout) {
      setDots([]);
      return;
    }
    let raf = 0;
    let lastKey = "";
    const tick = () => {
      const t = getTransform();
      const raw: { id: string; lx: number; ly: number; preview: string; screenY: number }[] = [];
      for (const id of bookmarks) {
        const ln = layout.nodes.get(id);
        if (!ln) continue;
        const sy = ln.y * t.scale + t.ty;
        raw.push({ id, lx: ln.x, ly: ln.y, preview: ln.preview, screenY: sy });
      }
      raw.sort((a, b) => a.screenY - b.screenY);
      // Cluster nudge: walk top-down, push each star down if it's within MIN_GAP of previous
      const margin = 12;
      let prevY = -Infinity;
      const out: GutterDot[] = [];
      for (const r of raw) {
        const min = Math.max(margin, prevY + MIN_GAP);
        const max = viewportHeight - margin;
        const clamped = Math.min(max, Math.max(min, r.screenY));
        // Skip if it's been pushed off the bottom — viewport too short for all stars
        if (clamped > viewportHeight - margin) continue;
        out.push({ id: r.id, lx: r.lx, ly: r.ly, preview: r.preview, screenY: clamped });
        prevY = clamped;
      }
      // Cheap change-detection so we don't re-render every frame when nothing moves
      const key = out.map((d) => `${d.id}:${d.screenY.toFixed(0)}`).join("|");
      if (key !== lastKey) {
        lastKey = key;
        setDots(out);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bookmarks, layout, viewportHeight, getTransform]);

  if (dots.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute left-0 top-0 bottom-0 z-10 pointer-events-none"
      style={{ width: STAR_SIZE + 8 }}
    >
      {dots.map((d) => (
        <button
          key={d.id}
          className="absolute pointer-events-auto text-amber-400 hover:text-amber-200 hover:scale-110 transition-transform"
          style={{
            left: 4,
            top: d.screenY - STAR_SIZE / 2,
            width: STAR_SIZE,
            height: STAR_SIZE,
            lineHeight: `${STAR_SIZE}px`,
            fontSize: STAR_SIZE,
          }}
          title={d.preview ? `★ ${d.preview.slice(0, 80)}` : "★ bookmark"}
          aria-label={d.preview ? `Bookmark: ${d.preview.slice(0, 80)}` : "Bookmark"}
          onClick={() => {
            onSelect(d.id);
            panToLayoutPoint(d.lx, d.ly);
          }}
        >
          ★
        </button>
      ))}
    </div>
  );
}
