/**
 * Loading skeleton shown until the forest data arrives. Mirrors the actual
 * shipped layout (sidebar + canvas + status bar) with shimmer placeholders
 * so the page doesn't flash from a centered "loading…" message into the real
 * UI. Drastically improves perceived speed.
 */
export function LoadingSkeleton() {
  return (
    <div className="flex-1 flex overflow-hidden relative bg-zinc-950">
      {/* Sidebar skeleton */}
      <div className="w-56 border-r border-zinc-800 bg-zinc-950 p-3 space-y-4 text-sm shrink-0">
        <div className="flex justify-end">
          <div className="h-3 w-16 rounded shimmer" />
        </div>
        {[
          { lines: 2, h: 7 },
          { lines: 3, h: 7 },
          { lines: 2, h: 7 },
          { lines: 1, h: 32 },
          { lines: 4, h: 5 },
        ].map((g, gi) => (
          <div key={gi} className="space-y-2 pb-3 border-b border-zinc-800/70">
            <div className="h-3 w-24 rounded shimmer" />
            {Array.from({ length: g.lines }).map((_, i) => (
              <div key={i} className={`rounded shimmer`} style={{ height: g.h * 4 }} />
            ))}
          </div>
        ))}
      </div>
      {/* Canvas skeleton */}
      <div className="flex-1 relative bg-zinc-950">
        {/* Faint band-shaped placeholders to hint at "the map" */}
        <div className="absolute inset-0 p-8 flex flex-col gap-6">
          {[0.7, 0.55, 0.85, 0.4, 0.65, 0.3].map((w, i) => (
            <div
              key={i}
              className="rounded-md shimmer"
              style={{ width: `${w * 100}%`, height: 28 + (i % 3) * 6 }}
            />
          ))}
        </div>
        {/* Minimap placeholder top-right */}
        <div
          className="absolute top-3 right-3 rounded shimmer border border-zinc-800"
          style={{ width: 220, height: 150 }}
        />
        {/* Status bar placeholder bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-6 border-t border-zinc-800 bg-zinc-950/90 flex items-center px-3 gap-2">
          <div className="h-2 w-10 rounded shimmer" />
          <div className="h-2 w-32 rounded shimmer" />
          <div className="h-2 w-24 rounded shimmer" />
          <div className="flex-1" />
          <div className="h-2 w-20 rounded shimmer" />
        </div>
        {/* Centered text */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-zinc-500 text-sm font-mono">loading sessions…</div>
        </div>
      </div>
      <style>{`
        .shimmer {
          background: linear-gradient(90deg, rgba(63,63,70,0.35) 0%, rgba(82,82,91,0.55) 50%, rgba(63,63,70,0.35) 100%);
          background-size: 200% 100%;
          animation: cc-map-shimmer 1.6s ease-in-out infinite;
        }
        @keyframes cc-map-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
