import { useEffect, useState } from "react";
import type { Layout, BackgroundStyle, ColorMode, LayoutDirection, NodeStyle, ViewMode } from "../canvas/types.js";
import type { Transform } from "../canvas/renderer.js";

interface StatusBarProps {
  mode: ViewMode;
  scopeLabel: string | null; // pre-formatted scope summary
  direction: LayoutDirection;
  nodeStyle: NodeStyle;
  colorMode: ColorMode;
  backgroundStyle: BackgroundStyle;
  selectedCount: number;
  multiSelectedCount: number;
  followLive: boolean;
  liveSessionId: string | null;
  liveTipTs: string | null;
  layout: Layout | null;
  getTransform: () => Transform;
}

/**
 * Thin always-visible status bar at the bottom of the canvas. Pulls together
 * info that was scattered across the LOD badge, scope pills, sidebar stats,
 * and various overlays into one VS-Code-style strip. Pointer-events on the
 * outer div are off so it doesn't block panning; individual chips opt back in.
 */
export function StatusBar({
  mode,
  scopeLabel,
  direction,
  nodeStyle,
  colorMode,
  backgroundStyle,
  selectedCount,
  multiSelectedCount,
  followLive,
  liveSessionId,
  liveTipTs,
  layout,
  getTransform,
}: StatusBarProps) {
  // RAF-poll the transform so the zoom% reads correctly (transformRef isn't React state).
  const [zoomPct, setZoomPct] = useState<number>(100);
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const tick = () => {
      const z = Math.round(getTransform().scale * 100);
      if (z !== last) { last = z; setZoomPct(z); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getTransform]);

  // Time-since-live ticks every 2s — cheap; nobody cares about sub-second precision here
  const [liveAgo, setLiveAgo] = useState<string>("");
  useEffect(() => {
    if (!liveTipTs) { setLiveAgo(""); return; }
    const update = () => {
      const ms = Date.now() - new Date(liveTipTs).getTime();
      if (!Number.isFinite(ms) || ms < 0) { setLiveAgo(""); return; }
      setLiveAgo(formatAgo(ms));
    };
    update();
    const id = window.setInterval(update, 2000);
    return () => window.clearInterval(id);
  }, [liveTipTs]);

  const totalVisible = layout?.nodes.size ?? 0;
  const totalSessions = layout?.sessionBands.length ?? 0;

  return (
    <div data-tour-id="status-bar" className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
      <div className="bg-zinc-950/90 border-t border-zinc-800 px-3 py-1 backdrop-blur flex items-center gap-3 text-[10px] text-zinc-400 font-mono">
        <Chip>{zoomPct}%</Chip>
        <Sep />
        <Chip muted>{mode}{scopeLabel ? ` · ${scopeLabel}` : ""}</Chip>
        <Sep />
        <Chip muted>{direction} · {nodeStyle} · {colorMode}{backgroundStyle !== "none" ? ` · ${backgroundStyle} bg` : ""}</Chip>
        <Sep />
        <Chip muted>{totalSessions}s · {totalVisible}n</Chip>
        {multiSelectedCount > 0 && (
          <>
            <Sep />
            <Chip color="text-cyan-300">{multiSelectedCount} selected</Chip>
          </>
        )}
        {selectedCount > 0 && multiSelectedCount === 0 && (
          <>
            <Sep />
            <Chip color="text-amber-300">1 node</Chip>
          </>
        )}
        <div className="flex-1" />
        {liveSessionId && (
          <Chip color={followLive ? "text-emerald-300" : "text-zinc-400"}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${followLive ? "bg-emerald-400 animate-pulse" : "bg-emerald-700"}`} />
            {followLive ? "follow live" : "live"}{liveAgo ? ` · ${liveAgo} ago` : ""}
          </Chip>
        )}
      </div>
    </div>
  );
}

function Chip({ children, muted = false, color }: { children: React.ReactNode; muted?: boolean; color?: string }) {
  const cls = color ?? (muted ? "text-zinc-500" : "text-zinc-300");
  return <span className={`pointer-events-auto ${cls} tabular-nums`}>{children}</span>;
}

function Sep() {
  return <span className="text-zinc-700">·</span>;
}

function formatAgo(ms: number): string {
  if (ms < 5000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h`;
  return `${Math.floor(ms / 86400_000)}d`;
}
