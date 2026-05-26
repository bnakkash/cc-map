import { useEffect, useRef, useState } from "react";
import type { Layout, Space } from "../canvas/types.js";
import type { Transform } from "../canvas/renderer.js";

interface NodeContextToolbarProps {
  layout: Layout;
  selectedId: string;
  viewportWidth: number;
  viewportHeight: number;
  getTransform: () => Transform;
  isBookmarked: boolean;
  spaces: Space[];
  /** Whether the node's session is already in the named space. */
  isInSpace: (spaceId: string) => boolean;
  onToggleBookmark: () => void;
  onResumeCLI: (fork: boolean) => void;
  onContinueInMap: () => void;
  onAddToSpace: (spaceId: string) => void;
}

const TOOLBAR_H = 30;
const TOOLBAR_OFFSET = 10;

/**
 * Mini floating toolbar above the selected node (Figma/Notion style).
 * 4 actions: ★ bookmark / ↻ resume / ⤴ fork / + add-to-Space (dropdown).
 * RAF-poll the transform so the toolbar follows pan/zoom. Anchors above the
 * node when there's room, below when there isn't.
 */
export function NodeContextToolbar({
  layout,
  selectedId,
  viewportWidth,
  viewportHeight,
  getTransform,
  isBookmarked,
  spaces,
  isInSpace,
  onToggleBookmark,
  onResumeCLI,
  onContinueInMap,
  onAddToSpace,
}: NodeContextToolbarProps) {
  const [pos, setPos] = useState<{ left: number; top: number; placement: "above" | "below" }>({
    left: -9999, top: -9999, placement: "above",
  });
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const node = layout.nodes.get(selectedId);
      if (node) {
        const t = getTransform();
        const sx = node.x * t.scale + t.tx;
        const sy = node.y * t.scale + t.ty;
        const cw = containerRef.current?.offsetWidth ?? 220;
        // Center horizontally above the node, clamp into viewport
        let left = sx - cw / 2;
        const margin = 8;
        if (left < margin) left = margin;
        if (left + cw > viewportWidth - margin) left = viewportWidth - cw - margin;
        // Prefer above; fall back to below if there's no room
        let top = sy - TOOLBAR_H - TOOLBAR_OFFSET;
        let placement: "above" | "below" = "above";
        if (top < margin) {
          top = sy + TOOLBAR_OFFSET;
          placement = "below";
        }
        if (top + TOOLBAR_H > viewportHeight - margin) {
          top = viewportHeight - TOOLBAR_H - margin;
        }
        setPos((prev) =>
          prev.left === left && prev.top === top && prev.placement === placement
            ? prev
            : { left, top, placement },
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layout, selectedId, viewportWidth, viewportHeight, getTransform]);

  // Close space menu when clicking outside
  useEffect(() => {
    if (!spaceMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setSpaceMenuOpen(false);
    };
    const id = window.setTimeout(() => document.addEventListener("click", onDoc), 0);
    return () => { window.clearTimeout(id); document.removeEventListener("click", onDoc); };
  }, [spaceMenuOpen]);

  if (!layout.nodes.has(selectedId)) return null;

  return (
    <div
      ref={containerRef}
      className="absolute z-20 flex items-center gap-0.5 px-1 py-1 rounded-lg bg-zinc-900/95 border border-zinc-700 shadow-xl backdrop-blur"
      style={{ left: pos.left, top: pos.top, height: TOOLBAR_H }}
      onClick={(e) => e.stopPropagation()}
    >
      <ToolbarButton
        title={isBookmarked ? "Remove bookmark (b)" : "Bookmark (b)"}
        onClick={onToggleBookmark}
        active={isBookmarked}
      >
        ★
      </ToolbarButton>
      <ToolbarSep />
      <ToolbarButton title="Continue this session in the map" onClick={onContinueInMap}>
        ✦
      </ToolbarButton>
      <ToolbarButton title="Resume in new terminal" onClick={() => onResumeCLI(false)}>
        ↻
      </ToolbarButton>
      <ToolbarButton title="Fork with --fork-session" onClick={() => onResumeCLI(true)}>
        ⤴
      </ToolbarButton>
      <ToolbarSep />
      <div className="relative">
        <ToolbarButton
          title={spaces.length === 0 ? "Create a Space first" : "Add to Space"}
          onClick={() => setSpaceMenuOpen((v) => !v)}
          disabled={spaces.length === 0}
        >
          + Space
        </ToolbarButton>
        {spaceMenuOpen && spaces.length > 0 && (
          <div
            className={`absolute ${pos.placement === "above" ? "bottom-full mb-1" : "top-full mt-1"} right-0 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1 min-w-[180px]`}
          >
            {spaces.map((sp) => {
              const already = isInSpace(sp.id);
              return (
                <button
                  key={sp.id}
                  className={`w-full text-left px-2 py-1 text-xs flex items-center gap-1.5 ${already ? "text-zinc-600" : "text-zinc-200 hover:bg-zinc-800"}`}
                  onClick={() => { if (!already) { onAddToSpace(sp.id); setSpaceMenuOpen(false); } }}
                  disabled={already}
                  title={already ? "Already in this space" : `Add session to "${sp.name}"`}
                >
                  <span
                    className="inline-block w-2 h-2 rounded-sm shrink-0"
                    style={{ background: `hsl(${sp.hue}, 60%, 55%)` }}
                  />
                  <span className="truncate">{sp.name}</span>
                  {already && <span className="ml-auto text-[9px]">✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
  active = false,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2 h-7 rounded text-xs ${
        disabled
          ? "text-zinc-700 cursor-not-allowed"
          : active
            ? "bg-amber-700/40 text-amber-300 hover:bg-amber-700/60"
            : "text-zinc-300 hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarSep() {
  return <span className="w-px h-4 bg-zinc-700 mx-0.5" />;
}
