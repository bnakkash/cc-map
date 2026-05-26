import { useCallback, useEffect, useState } from "react";
import { getToken, type ChipItem } from "./api.js";
import { Calendar } from "./components/Calendar.js";
import { ChipColumn } from "./components/ChipColumn.js";
import { MessagePane } from "./components/MessagePane.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { TreeMap } from "./components/TreeMap.js";
import { useSse } from "./sse.js";
import { useStore } from "./store.js";

type ViewName = "viewer" | "map" | "calendar";
const VIEW_KEY = "cc-map-current-view";

const VIEW_DESC: Record<ViewName, string> = {
  viewer: "read one session's prompts & replies",
  map: "pan & zoom every session as a forest",
  calendar: "daily activity heatmap",
};

export default function App() {
  const loadSessions = useStore((s) => s.loadSessions);
  const pushDeltaChips = useStore((s) => s.pushDeltaChips);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const error = useStore((s) => s.error);
  const [view, setViewState] = useState<ViewName>(() => {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      if (raw === "viewer" || raw === "map" || raw === "calendar") return raw;
    } catch {}
    return "map";
  });

  const setView = useCallback((next: ViewName) => {
    setViewState(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch {}
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const onSseEvent = useCallback(
    (e: import("./sse.js").SseEvent) => {
      if (e.type === "delta" && selectedSessionId) {
        const filtered = e.added
          .filter((n) => n.sessionId === selectedSessionId)
          .map((n) => ({
            id: n.id,
            parentId: (n as { parentId?: string | null }).parentId ?? null,
            role: (n as { classification?: { role?: "user" | "assistant" } }).classification?.role ?? "assistant",
            subtype:
              (n as { classification?: { subtype?: string } }).classification?.subtype ?? null,
            timestamp: String((n as { timestamp?: string }).timestamp ?? ""),
            preview: String((n as { preview?: string }).preview ?? ""),
            contentLength: Number((n as { contentLength?: number }).contentLength ?? 0),
            isSidechain: Boolean((n as { isSidechain?: boolean }).isSidechain),
            sharedWith: [],
          })) satisfies ChipItem[];
        if (filtered.length > 0) pushDeltaChips(selectedSessionId, filtered);
      } else if (e.type === "active-session") {
        setActiveSession({ sessionId: e.sessionId, at: e.at });
      }
    },
    [selectedSessionId, pushDeltaChips, setActiveSession],
  );
  useSse(onSseEvent);

  const token = getToken();
  if (!token) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-300 text-sm p-8">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-xl font-semibold">cc-map</h1>
          <p className="text-zinc-400">
            Missing auth token. Append <code className="bg-zinc-800 px-1 rounded">?token=YOUR_TOKEN</code> to the URL.
          </p>
          <p className="text-xs text-zinc-500">
            The server prints a ready-to-click URL on startup. Or read the token from{" "}
            <code className="bg-zinc-800 px-1 rounded">~/.cc-map/token</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-zinc-800 bg-zinc-900/50 px-4 py-2 flex items-center gap-4">
        <div className="font-mono text-sm font-semibold text-zinc-300">cc-map</div>
        <div className="flex gap-1" role="tablist" aria-label="View">
          {(["viewer", "map", "calendar"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              title={VIEW_DESC[v]}
              className={`px-2 py-1 rounded text-xs ${view === v ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
            >
              {v}
            </button>
          ))}
        </div>
        {view === "viewer" && <SessionPicker />}
        <div className="ml-auto text-xs text-zinc-500">
          {error && <span className="text-red-400 mr-3">{error}</span>}
          {VIEW_DESC[view]}
        </div>
      </header>
      <main className="flex-1 flex overflow-hidden">
        {view === "viewer" ? (
          <>
            <ChipColumn />
            <MessagePane />
          </>
        ) : view === "map" ? (
          <TreeMap onClose={() => setView("viewer")} />
        ) : (
          <Calendar
            onSelectDay={(iso) => {
              // Pre-set the map's date filter so it lands on just that day
              try {
                const cur = JSON.parse(localStorage.getItem("cc-map-filter") ?? "{}");
                localStorage.setItem(
                  "cc-map-filter",
                  JSON.stringify({ ...cur, startDate: iso, endDate: iso }),
                );
              } catch {}
              setView("map");
            }}
            onSelectSession={(sid) => {
              void useStore.getState().selectSession(sid);
              setView("viewer");
            }}
          />
        )}
      </main>
    </div>
  );
}
