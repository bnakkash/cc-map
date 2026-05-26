import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteItem {
  id: string;
  label: string;
  category: string;
  hint?: string;
  kbd?: string;
  action: () => void;
  /** Optional rich preview shown on the right pane when focused. Keep it
   *  cheap — strings only, no JSX (built in the parent each render). */
  preview?: {
    title?: string;
    subtitle?: string;
    body?: string;
    facts?: { label: string; value: string }[];
  };
}

interface CommandPaletteProps {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
}

/**
 * Cmd/Ctrl+K command palette. Lists every navigable destination + actionable
 * setting in the app, filtered by case-insensitive substring match. Arrow
 * keys navigate, Enter runs, Esc closes.
 *
 * Items are recomputed on every parent render — caller controls what shows up
 * and what each one does (no business logic in this component).
 */
export function CommandPalette({ open, items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset query + cursor whenever the palette opens
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items.slice(0, 200);
    const q = query.toLowerCase();
    return items
      .filter((it) => it.label.toLowerCase().includes(q) || it.category.toLowerCase().includes(q))
      .slice(0, 200);
  }, [items, query]);

  // Clamp cursor when filtered changes
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLButtonElement>(`[data-cmd-idx="${cursor}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  // Group filtered items by category (preserving order)
  const groups: { category: string; items: PaletteItem[] }[] = [];
  for (const it of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.category === it.category) last.items.push(it);
    else groups.push({ category: it.category, items: [it] });
  }

  // Build a flat index map so cursor (counted across the flat filtered list)
  // matches what we render per group.
  let flatIdx = 0;
  const focused = filtered[cursor];
  const showPreview = !!focused?.preview;

  return (
    <div
      className="absolute inset-0 z-50 bg-zinc-950/70 backdrop-blur flex items-start justify-center pt-24"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={`bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-full flex flex-col overflow-hidden ${showPreview ? "max-w-3xl" : "max-w-xl"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          type="text"
          placeholder="jump to session, switch mode, run action…"
          className="bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none px-4 py-3 border-b border-zinc-800"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
            else if (e.key === "Enter") {
              e.preventDefault();
              const it = filtered[cursor];
              if (it) { it.action(); onClose(); }
            }
          }}
        />
        <div className="flex flex-1 overflow-hidden">
          <div ref={listRef} className={`overflow-y-auto max-h-96 text-sm ${showPreview ? "w-2/5 border-r border-zinc-800" : "w-full"}`}>
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-zinc-500 text-center">No matches.</div>
            ) : (
              groups.map((g) => (
                <div key={g.category}>
                  <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
                    {g.category}
                  </div>
                  {g.items.map((it) => {
                    const myIdx = flatIdx++;
                    const active = myIdx === cursor;
                    return (
                      <button
                        key={it.id}
                        data-cmd-idx={myIdx}
                        onMouseEnter={() => setCursor(myIdx)}
                        onClick={() => { it.action(); onClose(); }}
                        className={`w-full text-left px-4 py-1.5 flex items-center gap-2 ${active ? "bg-zinc-800 text-white" : "text-zinc-300 hover:bg-zinc-800/50"}`}
                      >
                        <span className="flex-1 truncate">{it.label}</span>
                        {it.hint && <span className="text-zinc-500 text-[10px] truncate max-w-[180px]">{it.hint}</span>}
                        {it.kbd && <span className="text-zinc-600 text-[10px] font-mono">{it.kbd}</span>}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          {showPreview && focused && (
            <PreviewPane item={focused} />
          )}
        </div>
        <div className="px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-500 font-mono flex items-center gap-3">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

/** Right-pane preview for the focused palette item (Raycast/Linear style).
 *  Pure presentation — caller builds the preview data into each PaletteItem. */
function PreviewPane({ item }: { item: PaletteItem }) {
  const p = item.preview!;
  return (
    <div className="w-3/5 overflow-y-auto max-h-96 p-4 text-sm space-y-3 bg-zinc-950/40">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">{item.category}</div>
      {p.title && <div className="text-zinc-100 font-semibold text-base leading-tight">{p.title}</div>}
      {p.subtitle && <div className="text-zinc-400 text-xs leading-snug">{p.subtitle}</div>}
      {p.body && (
        <div className="text-zinc-200 text-xs leading-snug line-clamp-[8] bg-zinc-900/60 border border-zinc-800 rounded p-2">
          {p.body}
        </div>
      )}
      {p.facts && p.facts.length > 0 && (
        <div className="space-y-1 text-[11px]">
          {p.facts.map((f, i) => (
            <div key={i} className="flex justify-between gap-2 border-b border-zinc-800/60 pb-1">
              <span className="text-zinc-500">{f.label}</span>
              <span className="text-zinc-300 font-mono tabular-nums text-right">{f.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
