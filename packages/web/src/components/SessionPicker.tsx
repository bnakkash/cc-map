import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "../api.js";
import { prettySlug } from "../format.js";
import { useStore } from "../store.js";

export function SessionPicker() {
  const sessions = useStore((s) => s.sessions);
  const selected = useStore((s) => s.selectedSessionId);
  const active = useStore((s) => s.activeSession);
  const selectSession = useStore((s) => s.selectSession);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.sessionId === selected) ?? null,
    [sessions, selected],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sessions.filter((s) => searchableText(s).includes(q))
      : sessions;
    return list.slice(0, 80);
  }, [sessions, query]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onPointer = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const choose = (sessionId: string) => {
    void selectSession(sessionId, { prefer: "last" });
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={wrapRef} className="relative w-full max-w-[720px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-100 px-3 py-1.5 rounded text-sm text-left flex items-center gap-3"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {selectedSession ? (
          <>
            <span className="truncate flex-1">{sessionTitle(selectedSession)}</span>
            <span className="text-zinc-500 text-xs font-mono shrink-0">
              {selectedSession.sessionId.slice(0, 8)} · {prettyTime(selectedSession.lastActivityAt)}
            </span>
          </>
        ) : (
          <span className="text-zinc-500">Search sessions...</span>
        )}
        <span className="text-zinc-600">v</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Session picker"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 bg-zinc-950 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
        >
          <div className="p-2 border-b border-zinc-800">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const first = filtered[0];
                  if (first) choose(first.sessionId);
                }
              }}
              placeholder="Search title, project, path, tool, or session id..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-600"
            />
          </div>
          <div className="max-h-[420px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-zinc-500">No sessions match.</div>
            ) : (
              filtered.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  onClick={() => choose(s.sessionId)}
                  className={`w-full text-left px-3 py-2 flex items-start gap-3 hover:bg-zinc-900 ${
                    s.sessionId === selected ? "bg-zinc-900/80" : ""
                  }`}
                >
                  <span
                    className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
                      active.sessionId === s.sessionId ? "bg-emerald-400 animate-pulse" : "bg-zinc-700"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-zinc-100 truncate">{sessionTitle(s)}</span>
                    <span className="block text-xs text-zinc-500 truncate">
                      {prettySlug(s.projectSlug)}
                      {s.cwd ? ` · ${s.cwd}` : ""}
                    </span>
                    {s.toolsUsed.length > 0 && (
                      <span className="block text-[10px] text-zinc-600 truncate font-mono">
                        {s.toolsUsed.slice(0, 6).join(", ")}
                      </span>
                    )}
                  </span>
                  <span className="text-right text-[10px] text-zinc-500 font-mono shrink-0 leading-5">
                    <span className="block">{prettyTime(s.lastActivityAt)}</span>
                    <span className="block">{s.promptCount}p / {s.nodeCount}n</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function sessionTitle(s: SessionListItem): string {
  return s.aiTitle || s.firstPrompt || s.sessionId.slice(0, 8);
}

function searchableText(s: SessionListItem): string {
  return [
    s.sessionId,
    s.aiTitle,
    s.firstPrompt,
    s.projectSlug,
    s.cwd,
    ...s.toolsUsed,
  ].filter(Boolean).join(" ").toLowerCase();
}

function prettyTime(ts: string | null): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}
