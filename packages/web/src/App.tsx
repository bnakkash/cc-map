import { useCallback, useEffect, useState } from "react";
import { getToken, type ChipItem } from "./api.js";
import { ChipColumn } from "./components/ChipColumn.js";
import { MessagePane } from "./components/MessagePane.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { TreeMap } from "./components/TreeMap.js";
import { useSse } from "./sse.js";
import { useStore } from "./store.js";

type ViewName = "viewer" | "map";

export default function App() {
  const loadSessions = useStore((s) => s.loadSessions);
  const pushDeltaChips = useStore((s) => s.pushDeltaChips);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const error = useStore((s) => s.error);
  const [view, setView] = useState<ViewName>("viewer");

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
        <div className="flex gap-1">
          <button
            onClick={() => setView("viewer")}
            className={`px-2 py-1 rounded text-xs ${view === "viewer" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
          >
            viewer
          </button>
          <button
            onClick={() => setView("map")}
            className={`px-2 py-1 rounded text-xs ${view === "map" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
          >
            map
          </button>
        </div>
        {view === "viewer" && <SessionPicker />}
        <div className="ml-auto text-xs text-zinc-500">
          {error && <span className="text-red-400 mr-3">{error}</span>}
          {view === "viewer" ? "phase 1 · viewer" : "phase 2 · tree-map"}
        </div>
      </header>
      <main className="flex-1 flex overflow-hidden">
        {view === "viewer" ? (
          <>
            <ChipColumn />
            <MessagePane />
          </>
        ) : (
          <TreeMap onClose={() => setView("viewer")} />
        )}
      </main>
    </div>
  );
}
