import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { prettySlug } from "../format.js";
import type { ForestPayload } from "../canvas/types.js";

interface Props {
  onSelectDay: (dateIso: string) => void;
  onSelectSession: (sessionId: string) => void;
}

interface DayBucket {
  prompts: number;
  tokens: number;
  sessions: Set<string>;
}

export function Calendar({ onSelectDay, onSelectSession }: Props) {
  const [forest, setForest] = useState<ForestPayload | null>(null);
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.forest()
      .then((payload) => { if (!cancelled) setForest(payload); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const dayMap = useMemo(() => {
    if (!forest) return new Map<string, DayBucket>();
    const m = new Map<string, DayBucket>();
    for (const n of forest.nodes) {
      const day = n.timestamp.slice(0, 10);
      if (n.role === "user" && n.subtype === "prompt") {
        let bucket = m.get(day);
        if (!bucket) {
          bucket = { prompts: 0, tokens: 0, sessions: new Set() };
          m.set(day, bucket);
        }
        bucket.prompts += 1;
        bucket.sessions.add(n.sessionId);
      } else if (n.role === "assistant") {
        const bucket = m.get(day);
        if (bucket) bucket.tokens += n.outputTokens ?? 0;
      }
    }
    return m;
  }, [forest]);

  const { days, weeks, monthLabels, maxPrompts, latestActiveDay } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    while (start.getDay() !== 0) start.setDate(start.getDate() - 1);

    const allDays: { date: Date; iso: string; col: number; row: number }[] = [];
    let cur = new Date(start);
    let col = 0;
    while (cur <= today) {
      allDays.push({ date: new Date(cur), iso: cur.toISOString().slice(0, 10), col, row: cur.getDay() });
      cur.setDate(cur.getDate() + 1);
      if (cur.getDay() === 0) col++;
    }

    const byWeek: typeof allDays[] = [];
    for (const d of allDays) {
      if (!byWeek[d.col]) byWeek[d.col] = [];
      byWeek[d.col]!.push(d);
    }

    const labels: { col: number; label: string }[] = [];
    let lastMonth = -1;
    for (const week of byWeek) {
      const first = week?.[0];
      if (!first) continue;
      const month = first.date.getMonth();
      if (month !== lastMonth) {
        labels.push({ col: first.col, label: first.date.toLocaleString("en", { month: "short" }) });
        lastMonth = month;
      }
    }

    let max = 1;
    let latest: string | null = null;
    for (const [iso, b] of dayMap) {
      if (b.prompts > max) max = b.prompts;
      if (b.prompts > 0 && (!latest || iso > latest)) latest = iso;
    }
    return { days: allDays, weeks: byWeek, monthLabels: labels, maxPrompts: max, latestActiveDay: latest };
  }, [dayMap]);

  const focusedDay = selectedDay ?? hoveredDay ?? latestActiveDay;
  const focusedBucket = focusedDay ? dayMap.get(focusedDay) ?? null : null;
  const totalPrompts = [...dayMap.values()].reduce((sum, b) => sum + b.prompts, 0);
  const totalDays = [...dayMap.values()].filter((b) => b.prompts > 0).length;

  const focusedSessions = useMemo(() => {
    if (!focusedDay || !forest || !focusedBucket) return [];
    return [...focusedBucket.sessions].map((sid) => {
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
    }).sort((a, b) => b.promptsThisDay - a.promptsThisDay || a.title.localeCompare(b.title));
  }, [focusedDay, focusedBucket, forest]);

  if (!forest) {
    return <div className="flex-1 flex items-center justify-center text-zinc-500">loading activity...</div>;
  }

  const cellSize = 14;
  const cellGap = 3;

  return (
    <div className="flex-1 overflow-auto bg-zinc-950 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-zinc-100 text-xl font-semibold">Activity</h2>
            <p className="text-zinc-400 text-sm mt-1">
              {totalPrompts.toLocaleString()} prompts across {totalDays} active days.
            </p>
          </div>
          {focusedDay && (
            <button
              type="button"
              onClick={() => onSelectDay(focusedDay)}
              className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs"
            >
              View selected day on map
            </button>
          )}
        </div>

        <div className="overflow-x-auto pb-2">
          <div className="relative min-w-max pl-8">
            <div className="relative h-4 text-zinc-500 text-[10px] select-none">
              {monthLabels.map((m) => (
                <div
                  key={`${m.col}-${m.label}`}
                  className="absolute"
                  style={{ left: m.col * (cellSize + cellGap) }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            <div className="relative flex">
              <div
                className="absolute -left-8 top-0 grid text-zinc-500 text-[10px] select-none"
                style={{ gridTemplateRows: `repeat(7, ${cellSize}px)`, rowGap: cellGap }}
              >
                {["", "Mon", "", "Wed", "", "Fri", ""].map((d, i) => (
                  <div key={i} className="leading-none flex items-center">{d}</div>
                ))}
              </div>
              <div
                role="grid"
                aria-label="Prompt activity by day"
                className="grid"
                style={{
                  gridTemplateColumns: `repeat(${weeks.length}, ${cellSize}px)`,
                  gridTemplateRows: `repeat(7, ${cellSize}px)`,
                  columnGap: cellGap,
                  rowGap: cellGap,
                }}
              >
                {days.map((day) => {
                  const bucket = dayMap.get(day.iso);
                  const prompts = bucket?.prompts ?? 0;
                  const isSelected = focusedDay === day.iso;
                  return (
                    <button
                      key={day.iso}
                      type="button"
                      role="gridcell"
                      aria-label={`${day.iso}: ${prompts} prompts${bucket ? `, ${bucket.sessions.size} sessions` : ""}`}
                      onMouseEnter={() => setHoveredDay(day.iso)}
                      onMouseLeave={() => setHoveredDay(null)}
                      onFocus={() => setHoveredDay(day.iso)}
                      onBlur={() => setHoveredDay(null)}
                      onClick={() => setSelectedDay(day.iso)}
                      className={`rounded-[3px] outline-none transition-transform hover:scale-125 focus:scale-125 focus:ring-1 focus:ring-emerald-200 ${
                        isSelected ? "ring-1 ring-white" : ""
                      } ${prompts > 0 ? "cursor-pointer" : "cursor-default"}`}
                      style={{
                        background: intensity(prompts, maxPrompts),
                        gridColumn: day.col + 1,
                        gridRow: day.row + 1,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-4 text-[10px] text-zinc-500">
          <span>Less</span>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="inline-block rounded-[3px]" style={{ width: cellSize, height: cellSize, background: intensity(i, 5) }} />
          ))}
          <span>More</span>
        </div>

        <div className="mt-8 border-t border-zinc-800 pt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <section>
            <div className="flex items-center gap-3 mb-3">
              <h3 className="text-zinc-200 text-sm font-semibold">
                {focusedDay ?? "No day selected"}
                {focusedBucket ? ` - ${focusedBucket.sessions.size} session${focusedBucket.sessions.size === 1 ? "" : "s"}` : ""}
              </h3>
              {selectedDay && (
                <button
                  type="button"
                  onClick={() => setSelectedDay(null)}
                  className="ml-auto text-zinc-500 hover:text-zinc-300 text-xs"
                >
                  Clear
                </button>
              )}
            </div>
            {focusedSessions.length === 0 ? (
              <div className="text-sm text-zinc-500">No prompt activity for this day.</div>
            ) : (
              <div className="space-y-1">
                {focusedSessions.map((s) => (
                  <button
                    key={s.sessionId}
                    type="button"
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-zinc-900 text-xs flex items-center gap-2"
                    onClick={() => onSelectSession(s.sessionId)}
                  >
                    <span className="text-zinc-400 w-8 tabular-nums">{s.promptsThisDay}p</span>
                    <span className="text-zinc-200 truncate">{s.title}</span>
                    <span className="text-zinc-500 truncate ml-auto" title={s.projectSlug}>
                      {prettySlug(s.projectSlug)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
          <aside className="border border-zinc-800 rounded-lg p-3 h-fit">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono mb-2">Selected day</div>
            <div className="text-zinc-100 text-lg font-semibold">{focusedDay ?? "-"}</div>
            <dl className="mt-3 space-y-1 text-xs">
              <Stat label="Prompts" value={String(focusedBucket?.prompts ?? 0)} />
              <Stat label="Sessions" value={String(focusedBucket?.sessions.size ?? 0)} />
              <Stat label="Output tokens" value={(focusedBucket?.tokens ?? 0).toLocaleString()} />
            </dl>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-zinc-800/60 pb-1">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-zinc-300 font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function intensity(prompts: number, maxPrompts: number): string {
  if (prompts <= 0) return "rgb(24 24 27)";
  const ratio = prompts / Math.max(1, maxPrompts);
  if (ratio < 0.15) return "rgb(6 78 59)";
  if (ratio < 0.35) return "rgb(4 120 87)";
  if (ratio < 0.6) return "rgb(5 150 105)";
  if (ratio < 0.85) return "rgb(52 211 153)";
  return "rgb(110 231 183)";
}
