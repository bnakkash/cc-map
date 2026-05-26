import { useEffect, useState } from "react";
import type { ForestPayload } from "../canvas/types.js";
import { projectColor } from "../canvas/colors.js";

interface ProjectLegendProps {
  forest: ForestPayload;
  onPickProject: (slug: string) => void;
  activeSlug: string | null;
}

/**
 * Floating legend chip showing each project's color + session count, with
 * click-to-scope. Only meaningful when multiple projects are present. Sits
 * in the top-left where nothing else lives, collapses to a swatch row by
 * default. Persists open/collapsed in localStorage.
 */
export function ProjectLegend({ forest, onPickProject, activeSlug }: ProjectLegendProps) {
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem("cc-map-legend-expanded") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("cc-map-legend-expanded", expanded ? "1" : "0"); } catch {}
  }, [expanded]);

  if (forest.projects.length <= 1) return null;
  const sorted = [...forest.projects].sort((a, b) => b.sessionCount - a.sessionCount);

  return (
    <div className="absolute top-3 left-3 z-20 select-none">
      {expanded ? (
        <div className="bg-zinc-900/95 border border-zinc-700 rounded shadow-xl backdrop-blur p-2 min-w-[200px] max-w-[260px]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Projects</span>
            <button
              onClick={() => setExpanded(false)}
              className="text-zinc-500 hover:text-zinc-200 text-xs"
              title="Collapse legend"
              aria-label="Collapse legend"
            >
              −
            </button>
          </div>
          <div className="space-y-0.5 max-h-[40vh] overflow-y-auto">
            {sorted.map((p) => (
              <button
                key={p.slug}
                onClick={() => onPickProject(p.slug)}
                className={`w-full text-left text-xs px-1.5 py-1 rounded flex items-center gap-2 truncate ${activeSlug === p.slug ? "bg-zinc-800 text-white" : "text-zinc-300 hover:bg-zinc-800/50"}`}
                title={`${p.slug} · ${p.sessionCount} sessions — click to scope`}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ background: projectColor(p.slug) }}
                />
                <span className="truncate flex-1">{prettySlug(p.slug)}</span>
                <span className="text-zinc-600 shrink-0 tabular-nums text-[10px]">{p.sessionCount}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1 bg-zinc-900/85 hover:bg-zinc-900 border border-zinc-800 rounded px-2 py-1 backdrop-blur"
          title={`Legend: ${forest.projects.length} projects — click to expand`}
        >
          {sorted.slice(0, 6).map((p) => (
            <span
              key={p.slug}
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ background: projectColor(p.slug) }}
            />
          ))}
          {sorted.length > 6 && <span className="text-[9px] text-zinc-500 font-mono">+{sorted.length - 6}</span>}
        </button>
      )}
    </div>
  );
}

function prettySlug(slug: string): string {
  return slug.replace(/^C--Users-[^-]+-/, "~/").replace(/-+/g, "/");
}
