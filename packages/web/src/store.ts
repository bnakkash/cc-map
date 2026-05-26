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
  lastNodeBySession: Map<string, string>;
  // UI state
  filter: string;
  unreadOnly: boolean;
  loading: boolean;
  error: string | null;

  // Actions
  loadSessions: () => Promise<void>;
  selectSession: (sessionId: string, opts?: { nodeId?: string; prefer?: "last" | "unread" | "latest" | "first" }) => Promise<void>;
  selectNode: (uuid: string | null) => void;
  setFilter: (f: string) => void;
  setUnreadOnly: (on: boolean) => void;
  markRead: (sessionId: string, uuid: string) => void;
  markAllRead: (sessionId?: string) => void;
  pushDeltaChips: (sessionId: string, newChips: ChipItem[]) => void;
  setActiveSession: (info: ActiveSessionInfo) => void;
  jumpToNextUnread: () => void;
}

const READ_STATE_KEY = "cc-map-read";
const LAST_NODE_KEY = "cc-map-last-node";
const UNREAD_ONLY_KEY = "cc-map-viewer-unread-only";

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

function loadLastNodeState(): Map<string, string> {
  try {
    const raw = localStorage.getItem(LAST_NODE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj).filter(([, v]) => typeof v === "string"));
  } catch {
    return new Map();
  }
}

function saveLastNodeState(m: Map<string, string>) {
  try {
    localStorage.setItem(LAST_NODE_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch {
    // ignore quota errors
  }
}

function isReadableReply(c: ChipItem): boolean {
  return c.role === "assistant" && c.subtype !== "tool-only" && c.subtype !== "thinking";
}

function pickInitialNode(
  chips: ChipItem[],
  read: Set<string>,
  remembered: string | undefined,
  opts?: { nodeId?: string; prefer?: "last" | "unread" | "latest" | "first" },
): string | null {
  if (opts?.nodeId && chips.some((c) => c.id === opts.nodeId)) return opts.nodeId;
  const prefer = opts?.prefer ?? "last";
  if (prefer === "last" && remembered && chips.some((c) => c.id === remembered)) return remembered;
  if (prefer === "first") return chips[0]?.id ?? null;

  const readable = chips.filter((c) => c.subtype === "prompt" || isReadableReply(c));
  const unreadReplies = readable.filter((c) => isReadableReply(c) && !read.has(c.id));
  if (prefer === "unread" || unreadReplies.length > 0) {
    const latestUnread = unreadReplies[unreadReplies.length - 1];
    if (latestUnread) return latestUnread.id;
  }
  const latestReadable = readable[readable.length - 1];
  return latestReadable?.id ?? chips[chips.length - 1]?.id ?? null;
}

export const useStore = create<State>((set, get) => ({
  sessions: [],
  activeSession: { sessionId: null, at: null },
  selectedSessionId: null,
  chips: [],
  sessionMeta: null,
  selectedNodeId: null,
  readNodes: loadReadState(),
  lastNodeBySession: loadLastNodeState(),
  filter: "",
  unreadOnly: (() => {
    try { return localStorage.getItem(UNREAD_ONLY_KEY) === "1"; } catch { return false; }
  })(),
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

  async selectSession(sessionId, opts) {
    set({ selectedSessionId: sessionId, chips: [], sessionMeta: null, selectedNodeId: null });
    try {
      const res = await api.chips(sessionId);
      const read = get().readNodes.get(sessionId) ?? new Set<string>();
      const remembered = get().lastNodeBySession.get(sessionId);
      const selectedNodeId = pickInitialNode(res.chips, read, remembered, opts);
      set({ chips: res.chips, sessionMeta: res.meta, selectedNodeId });
      if (selectedNodeId) get().selectNode(selectedNodeId);
    } catch (err) {
      set({ error: String(err) });
    }
  },

  selectNode(uuid) {
    set({ selectedNodeId: uuid });
    const sid = get().selectedSessionId;
    if (sid && uuid) {
      const next = new Map(get().lastNodeBySession);
      next.set(sid, uuid);
      set({ lastNodeBySession: next });
      saveLastNodeState(next);
      get().markRead(sid, uuid);
    }
  },

  setFilter(f) {
    set({ filter: f });
  },

  setUnreadOnly(on) {
    set({ unreadOnly: on });
    try { localStorage.setItem(UNREAD_ONLY_KEY, on ? "1" : "0"); } catch {}
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

  markAllRead(sessionId) {
    const sid = sessionId ?? get().selectedSessionId;
    if (!sid) return;
    const cur = get().readNodes;
    const next = new Map(cur);
    const set2 = new Set(next.get(sid) ?? []);
    for (const c of get().chips) {
      if (isReadableReply(c)) set2.add(c.id);
    }
    next.set(sid, set2);
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
      if (isReadableReply(c) && !read.has(c.id)) {
        get().selectNode(c.id);
        return;
      }
    }
  },
}));
