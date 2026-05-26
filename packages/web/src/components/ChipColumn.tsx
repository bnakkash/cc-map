import { useEffect, useMemo, useRef } from "react";
import type { ChipItem } from "../api.js";
import { useStore } from "../store.js";

export function ChipColumn() {
  const chips = useStore((s) => s.chips);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const selected = useStore((s) => s.selectedNodeId);
  const selectNode = useStore((s) => s.selectNode);
  const readNodes = useStore((s) => s.readNodes);
  const sessionId = useStore((s) => s.selectedSessionId);
  const jumpNext = useStore((s) => s.jumpToNextUnread);
  const unreadOnly = useStore((s) => s.unreadOnly);
  const setUnreadOnly = useStore((s) => s.setUnreadOnly);
  const markAllRead = useStore((s) => s.markAllRead);

  const readSet = sessionId ? readNodes.get(sessionId) : undefined;
  const sessionStartChipId = useMemo(() => {
    let first: ChipItem | null = null;
    for (const chip of chips) {
      if (chip.role !== "user" || chip.subtype !== "prompt") continue;
      if (!first || chip.timestamp < first.timestamp) first = chip;
    }
    return first?.id ?? null;
  }, [chips]);

  const visible = useMemo(() => {
    let next = chips;
    if (unreadOnly) {
      next = next.filter((c) => isReadableReply(c) && !(readSet?.has(c.id) ?? false));
    }
    if (!filter) return next;
    const needle = filter.toLowerCase();
    return next.filter((c) => c.preview.toLowerCase().includes(needle));
  }, [chips, filter, readSet, unreadOnly]);

  // Keyboard nav: J/K next/prev assistant, N next unread, / focus filter
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const dir = e.key === "j" ? 1 : -1;
        const idx = selected ? visible.findIndex((c) => c.id === selected) : -1;
        const next = visible[Math.max(0, Math.min(visible.length - 1, idx + dir))];
        if (next) selectNode(next.id);
      } else if (e.key === "n") {
        e.preventDefault();
        jumpNext();
      } else if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selected, selectNode, jumpNext]);

  // Auto-scroll selected chip into view
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    const el = listRef.current?.querySelector(`[data-chip-id="${selected}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const stats = useMemo(() => {
    let prompts = 0;
    let assistants = 0;
    let unreadAssistants = 0;
    for (const c of chips) {
      if (isReadableReply(c)) {
        assistants++;
        if (!readSet?.has(c.id)) unreadAssistants++;
      } else if (c.subtype === "prompt") {
        prompts++;
      }
    }
    return { prompts, assistants, unreadAssistants };
  }, [chips, readSet]);

  return (
    <div className="flex flex-col h-full border-r border-zinc-800 bg-zinc-950 w-[420px] min-w-[280px]">
      <div className="p-2 border-b border-zinc-800 space-y-2">
        <input
          ref={filterRef}
          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm placeholder-zinc-500"
          placeholder="filter prompts/replies   (press / to focus)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="text-xs text-zinc-500 flex flex-wrap items-center gap-2">
          <span>{stats.prompts} prompts</span>
          <span>{stats.assistants} replies</span>
          <button
            type="button"
            onClick={() => setUnreadOnly(!unreadOnly)}
            className={`px-1.5 py-0.5 rounded ${unreadOnly ? "bg-amber-700/40 text-amber-200" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"}`}
            title="Show unread replies only"
          >
            unread only
          </button>
          {stats.unreadAssistants > 0 && (
            <button
              onClick={jumpNext}
              className="text-amber-400 hover:text-amber-300 cursor-pointer"
              title="n = next unread"
            >
              {stats.unreadAssistants} unread → next (n)
            </button>
          )}
          {stats.unreadAssistants > 0 && (
            <button
              onClick={() => markAllRead(sessionId ?? undefined)}
              className="text-zinc-500 hover:text-zinc-300"
              title="Mark all readable replies in this session as read"
            >
              mark all read
            </button>
          )}
          <span className="ml-auto text-zinc-500">j/k = nav</span>
        </div>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto overflow-x-hidden">
        {visible.length === 0 ? (
          <div className="px-4 py-8 text-sm text-zinc-500 text-center">
            {unreadOnly ? "No unread replies match." : "No messages match."}
          </div>
        ) : visible.map((chip) => (
          <Chip
            key={chip.id}
            chip={chip}
            isSelected={chip.id === selected}
            isRead={readSet?.has(chip.id) ?? false}
            isSessionStart={chip.id === sessionStartChipId}
            onSelect={() => selectNode(chip.id)}
          />
        ))}
      </div>
    </div>
  );
}

function Chip({
  chip,
  isSelected,
  isRead,
  isSessionStart,
  onSelect,
}: {
  chip: ChipItem;
  isSelected: boolean;
  isRead: boolean;
  isSessionStart: boolean;
  onSelect: () => void;
}) {
  const roleColor =
    isSessionStart
      ? "border-l-cyan-400"
      : chip.role === "assistant" && chip.subtype === "thinking"
      ? "border-l-violet-500"
      : chip.role === "assistant" && chip.subtype === "tool-only"
        ? "border-l-blue-500"
        : chip.role === "assistant"
      ? "border-l-amber-500"
      : chip.subtype === "prompt"
        ? "border-l-emerald-500"
        : chip.subtype === "tool-result"
          ? "border-l-zinc-700"
          : "border-l-zinc-600";
  const muted = chip.role === "user" && chip.subtype !== "prompt";

  return (
    <button
      data-chip-id={chip.id}
      onClick={onSelect}
      className={[
        "block w-full text-left px-3 py-2 border-l-4 border-b border-b-zinc-900 hover:bg-zinc-900/60 transition-colors",
        roleColor,
        isSelected ? "bg-zinc-800/80" : "",
        muted ? "opacity-50" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 text-xs">
        <span
          className={
            chip.role === "assistant"
              ? chip.subtype === "thinking"
                ? "text-violet-400 font-semibold"
                : chip.subtype === "tool-only"
                  ? "text-blue-400 font-semibold"
                  : "text-amber-400 font-semibold"
              : chip.subtype === "prompt"
                ? "text-emerald-400 font-semibold"
                : "text-zinc-500"
          }
        >
          {chip.role === "assistant"
            ? `${assistantLabel(chip.subtype)}${isRead ? "" : " ●"}`
            : isSessionStart
              ? "new session"
              : (chip.subtype ?? "user")}
        </span>
        {isSessionStart && (
          <span className="text-[10px] uppercase tracking-wide text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 rounded px-1">
            start
          </span>
        )}
        <span className="text-zinc-500 font-mono">
          {new Date(chip.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        {chip.isSidechain && (
          <span className="text-xs text-purple-400 font-mono">subagent</span>
        )}
        {chip.sharedWith.length > 0 && (
          <span className="text-xs text-cyan-400 font-mono" title={`also in ${chip.sharedWith.length} other sessions (--fork-session)`}>
            ⑂{chip.sharedWith.length}
          </span>
        )}
        <span className="ml-auto text-zinc-500 text-xs">{(chip.contentLength / 1000).toFixed(1)}k</span>
      </div>
      <div className="text-sm text-zinc-200 mt-1 line-clamp-3 leading-tight">
        {chip.preview || <span className="italic text-zinc-500">(empty)</span>}
      </div>
    </button>
  );
}

function isReadableReply(c: ChipItem): boolean {
  return c.role === "assistant" && c.subtype !== "tool-only" && c.subtype !== "thinking";
}

function assistantLabel(subtype: string | null): string {
  if (subtype === "tool-only") return "tool call";
  if (subtype === "thinking") return "thinking";
  return "reply";
}
