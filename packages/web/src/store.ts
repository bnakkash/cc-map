import { create } from "zustand";
import { api, type ActiveSessionInfo, type ChipItem, type SessionListItem, type SessionMeta } from "./api.js";

interface State {
  // Data
  sessions: SessionListItem[];
  activeSession: ActiveSessionInfo;
  selectedSessionId: string | null;
  chips: ChipItem[];
  sessionMeta: SessionMeta | null;
  selectedNodeId: string | null;
  // Read state, per-session
  readNodes: Map<string, Set<string>>; // sessionId -> set of read uuids
  // UI state
  filter: string;
  loading: boolean;
  error: string | null;

  // Actions
  loadSessions: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  selectNode: (uuid: string | null) => void;
  setFilter: (f: string) => void;
  markRead: (sessionId: string, uuid: string) => void;
  pushDeltaChips: (sessionId: string, newChips: ChipItem[]) => void;
  setActiveSession: (info: ActiveSessionInfo) => void;
  jumpToNextUnread: () => void;
}

const READ_STATE_KEY = "cc-map-read";

function loadReadState(): Map<string, Set<string>> {
  try {
    const raw = localStorage.getItem(READ_STATE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, string[]>;
    const map = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(obj)) map.set(k, new Set(v));
    return map;
  } catch {
    return new Map();
  }
}

function saveReadState(m: Map<string, Set<string>>) {
  try {
    const obj: Record<string, string[]> = {};
    for (const [k, v] of m) obj[k] = [...v];
    localStorage.setItem(READ_STATE_KEY, JSON.stringify(obj));
  } catch {
    // ignore quota errors
  }
}

export const useStore = create<State>((set, get) => ({
  sessions: [],
  activeSession: { sessionId: null, at: null },
  selectedSessionId: null,
  chips: [],
  sessionMeta: null,
  selectedNodeId: null,
  readNodes: loadReadState(),
  filter: "",
  loading: false,
  error: null,

  async loadSessions() {
    set({ loading: true, error: null });
    try {
      const res = await api.sessions();
      set({
        sessions: res.sessions,
        activeSession: res.activeSession,
        loading: false,
      });
      // Auto-select: active session if set, else most recent
      const cur = get().selectedSessionId;
      if (!cur) {
        const target = res.activeSession.sessionId ?? res.sessions[0]?.sessionId ?? null;
        if (target) await get().selectSession(target);
      }
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  async selectSession(sessionId) {
    set({ selectedSessionId: sessionId, chips: [], sessionMeta: null, selectedNodeId: null });
    try {
      const res = await api.chips(sessionId);
      set({ chips: res.chips, sessionMeta: res.meta });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  selectNode(uuid) {
    set({ selectedNodeId: uuid });
    const sid = get().selectedSessionId;
    if (sid && uuid) get().markRead(sid, uuid);
  },

  setFilter(f) {
    set({ filter: f });
  },

  markRead(sessionId, uuid) {
    const cur = get().readNodes;
    const next = new Map(cur);
    const set2 = new Set(next.get(sessionId) ?? []);
    set2.add(uuid);
    next.set(sessionId, set2);
    set({ readNodes: next });
    saveReadState(next);
  },

  pushDeltaChips(sessionId, newChips) {
    if (get().selectedSessionId !== sessionId) return;
    const existing = new Set(get().chips.map((c) => c.id));
    const toAdd = newChips.filter((c) => !existing.has(c.id));
    if (toAdd.length === 0) return;
    const combined = [...get().chips, ...toAdd].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
    set({ chips: combined });
  },

  setActiveSession(info) {
    set({ activeSession: info });
  },

  jumpToNextUnread() {
    const { chips, selectedNodeId, readNodes, selectedSessionId } = get();
    if (!selectedSessionId) return;
    const read = readNodes.get(selectedSessionId) ?? new Set<string>();
    const startIdx = selectedNodeId ? chips.findIndex((c) => c.id === selectedNodeId) + 1 : 0;
    for (let i = startIdx; i < chips.length; i++) {
      const c = chips[i];
      if (!c) continue;
      if (c.role === "assistant" && !read.has(c.id)) {
        get().selectNode(c.id);
        return;
      }
    }
  },
}));
