import { useEffect, useMemo, useState } from "react";
import { getToken } from "../api.js";
import type { ForestPayload } from "../canvas/types.js";

interface Props {
  /** Click a day → caller decides what to do (e.g. switch to map + apply date filter). */
  onSelectDay: (dateIso: string) => void;
  /** Click a session row → caller decides (open in viewer / jump on map). */
  onSelectSession: (sessionId: string) => void;
}

/**
 * GitHub-style year-grid heatmap of prompts-per-day, sourced from /api/forest.
 * Each cell colored by intensity. Hover for count + project breakdown. Click a
 * day → caller filters the map to that day's sessions.
 */
export function Calendar({ onSelectDay, onSelectSession }: Props) {
  const [forest, setForest] = useState<ForestPayload | null>(null);
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/forest", { headers: { Authorization: `Bearer ${getToken() ?? ""}` } })
      .then((r) => r.json())
      .then(setForest)
      .catch(() => {});
  }, []);

  // For each day: prompt count + tokens + sessionIds touched
  const dayMap = useMemo(() => {
    if (!forest) return new Map<string, { prompts: number; tokens: number; sessions: Set<string> }>();
    const m = new Map<string, { prompts: number; tokens: number; sessions: Set<string> }>();
    for (const n of forest.nodes) {
      if (!(n.role === "user" && n.subtype === "prompt")) continue;
      const day = n.timestamp.slice(0, 10); // YYYY-MM-DD
      let bucket = m.get(day);
      if (!bucket) {
        bucket = { prompts: 0, tokens: 0, sessions: new Set() };
        m.set(day, bucket);
      }
      bucket.prompts += 1;
      bucket.sessions.add(n.sessionId);
    }
    // Add tokens from session totals
    if (forest.sessionTitles) {
      for (const n of forest.nodes) {
        if (n.role !== "assistant") continue;
        const day = n.timestamp.slice(0, 10);
        const bucket = m.get(day);
        if (bucket) bucket.tokens += n.outputTokens ?? 0;
      }
    }
    return m;
  }, [forest]);

  const { maxPrompts, days } = useMemo(() => {
    // Build a year-long grid ending today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    // Align start to Sunday
    while (start.getDay() !== 0) start.setDate(start.getDate() - 1);
    const days: { date: Date; iso: string }[] = [];
    let cur = new Date(start);
    while (cur <= today) {
      const iso = cur.toISOString().slice(0, 10);
      days.push({ date: new Date(cur), iso });
      cur.setDate(cur.getDate() + 1);
    }
    let maxPrompts = 1;
    for (const b of dayMap.values()) if (b.prompts > maxPrompts) maxPrompts = b.prompts;
    return { maxPrompts, days };
  }, [dayMap]);

  // 7 rows (Sun..Sat) × N columns (weeks)
  const weeks: { date: Date; iso: string }[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  // Month labels: detect when the month changes between weeks
  const monthLabels: { col: number; label: string }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, col) => {
    const firstDay = week[0];
    if (!firstDay) return;
    const month = firstDay.date.getMonth();
    if (month !== lastMonth) {
      monthLabels.push({ col, label: firstDay.date.toLocaleString("en", { month: "short" }) });
      lastMonth = month;
    }
  });

  const cellSize = 12;
  const cellGap = 2;
  const totalPrompts = [...dayMap.values()].reduce((s, b) => s + b.prompts, 0);
  const totalDays = dayMap.size;

  const intensityClass = (p: number) => {
    if (p === 0) return "fill-zinc-900";
    const ratio = p / maxPrompts;
    if (ratio < 0.15) return "fill-emerald-950";
    if (ratio < 0.35) return "fill-emerald-800";
    if (ratio < 0.6) return "fill-emerald-600";
    if (ratio < 0.85) return "fill-emerald-400";
    return "fill-emerald-300";
  };

  // Selected day's sessions (when hovered or clicked)
  const focusedDay = hoveredDay;
  const focusedSessions = useMemo(() => {
    if (!focusedDay || !forest) return [];
    const bucket = dayMap.get(focusedDay);
    if (!bucket) return [];
    return [...bucket.sessions].map((sid) => {
      const info = forest.sessionTitles?.[sid];
      const promptCount = forest.nodes.filter(
        (n) => n.sessionId === sid && n.role === "user" && n.subtype === "prompt" && n.timestamp.startsWith(focusedDay),
      ).length;
      return {
        sessionId: sid,
        title: info?.aiTitle ?? sid.slice(0, 8),
        projectSlug: forest.nodes.find((n) => n.sessionId === sid)?.projectSlug ?? "",
        promptsThisDay: promptCount,
      };
    });
  }, [focusedDay, forest, dayMap]);

  if (!forest) {
    return <div className="flex-1 flex items-center justify-center text-zinc-500">loading…</div>;
  }

  return (
    <div className="flex-1 overflow-auto bg-zinc-950 p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h2 className="text-zinc-100 text-xl font-semibold">Activity (last 365 days)</h2>
          <p className="text-zinc-400 text-sm mt-1">
            {totalPrompts.toLocaleString()} prompts across {totalDays} active days. Click a day to filter the map.
          </p>
        </div>

        <div className="relative">
          {/* Month labels */}
          <div className="flex pl-8 text-zinc-500 text-[10px] mb-1 select-none" style={{ height: 14 }}>
            {monthLabels.map((m) => (
              <div
                key={`${m.col}-${m.label}`}
                style={{ position: "absolute", left: 32 + m.col * (cellSize + cellGap) }}
              >
                {m.label}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            {/* Day-of-week labels */}
            <div className="flex flex-col text-zinc-500 text-[10px] select-none" style={{ gap: cellGap, paddingTop: 2 }}>
              {["", "Mon", "", "Wed", "", "Fri", ""].map((d, i) => (
                <div key={i} style={{ height: cellSize, lineHeight: `${cellSize}px` }}>{d}</div>
              ))}
            </div>

            {/* Grid */}
            <svg
              width={weeks.length * (cellSize + cellGap)}
              height={7 * (cellSize + cellGap)}
              style={{ display: "block" }}
            >
              {weeks.map((week, col) =>
                week.map((day, row) => {
                  const bucket = dayMap.get(day.iso);
                  const p = bucket?.prompts ?? 0;
                  return (
                    <rect
                      key={day.iso}
                      x={col * (cellSize + cellGap)}
                      y={row * (cellSize + cellGap)}
                      width={cellSize}
                      height={cellSize}
                      rx={2}
                      className={`${intensityClass(p)} ${p > 0 ? "cursor-pointer" : ""} ${hoveredDay === day.iso ? "stroke-emerald-300" : ""}`}
                      strokeWidth={hoveredDay === day.iso ? 1.5 : 0}
                      onMouseEnter={() => setHoveredDay(day.iso)}
                      onMouseLeave={() => setHoveredDay(null)}
                      onClick={() => p > 0 && onSelectDay(day.iso)}
                    >
                      <title>{`${day.iso}: ${p} prompt${p === 1 ? "" : "s"}${bucket ? `, ${bucket.sessions.size} session${bucket.sessions.size === 1 ? "" : "s"}` : ""}`}</title>
                    </rect>
                  );
                }),
              )}
            </svg>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-2 mt-4 text-[10px] text-zinc-500">
            <span>Less</span>
            {["fill-zinc-900", "fill-emerald-950", "fill-emerald-800", "fill-emerald-600", "fill-emerald-400", "fill-emerald-300"].map((c) => (
              <svg key={c} width={cellSize} height={cellSize}>
                <rect width={cellSize} height={cellSize} rx={2} className={c} />
              </svg>
            ))}
            <span>More</span>
          </div>
        </div>

        {/* Focused day detail */}
        {focusedDay && focusedSessions.length > 0 && (
          <div className="mt-8 border-t border-zinc-800 pt-6">
            <h3 className="text-zinc-200 text-sm font-semibold mb-2">
              {focusedDay} — {focusedSessions.length} session{focusedSessions.length === 1 ? "" : "s"}
            </h3>
            <div className="space-y-1">
              {focusedSessions.map((s) => (
                <button
                  key={s.sessionId}
                  className="w-full text-left px-2 py-1 rounded hover:bg-zinc-900 text-xs flex items-center gap-2"
                  onClick={() => onSelectSession(s.sessionId)}
                >
                  <span className="text-zinc-400">{s.promptsThisDay}p</span>
                  <span className="text-zinc-200 truncate">{s.title}</span>
                  <span className="text-zinc-600 truncate ml-auto" title={s.projectSlug}>
                    {prettySlug(s.projectSlug)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function prettySlug(s: string): string {
  return s.replace(/^C--Users-[^-]+-/, "~/").replace(/-+/g, "/");
}
