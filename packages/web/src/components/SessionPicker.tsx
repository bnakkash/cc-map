import { useMemo } from "react";
import { useStore } from "../store.js";

export function SessionPicker() {
  const sessions = useStore((s) => s.sessions);
  const selected = useStore((s) => s.selectedSessionId);
  const active = useStore((s) => s.activeSession);
  const selectSession = useStore((s) => s.selectSession);

  // Group by projectSlug for the dropdown
  const grouped = useMemo(() => {
    const m = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const arr = m.get(s.projectSlug) ?? [];
      arr.push(s);
      m.set(s.projectSlug, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions]);

  return (
    <select
      className="w-full max-w-[640px] bg-zinc-900 border border-zinc-800 text-zinc-100 px-3 py-1.5 rounded text-sm font-mono"
      value={selected ?? ""}
      onChange={(e) => selectSession(e.target.value)}
    >
      <option value="" disabled>
        Select session…
      </option>
      {grouped.map(([project, list]) => (
        <optgroup key={project} label={prettyProject(project)}>
          {list.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.sessionId.slice(0, 8)} · {prettyTime(s.lastActivityAt)} · {s.promptCount}p / {s.nodeCount}n
              {active.sessionId === s.sessionId ? "  ← active" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function prettyProject(slug: string): string {
  // C--Users-bnakk-OneDrive-Project-Phoenix → ~/OneDrive/Project Phoenix
  return slug
    .replace(/^C--Users-[^-]+-/, "~/")
    .replace(/-+/g, "/");
}

function prettyTime(ts: string | null): string {
  if (!ts) return "—";
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
