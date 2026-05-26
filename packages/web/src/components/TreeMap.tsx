import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Markdown rendering (react-markdown + rehype-highlight + highlight.js) is
// ~200KB of the initial bundle. Lazy-load so the first paint is the canvas,
// not a Markdown lexer. Loads when the user first opens a node's detail.
const ContentRender = lazy(() => import("./ContentRender.js"));
import { api, type NodeResponse } from "../api.js";
import { useSse, type SseEvent } from "../sse.js";
import { useStore } from "../store.js";
import { buildLayout, timelineNowY } from "../canvas/layout.js";
import {
  MAX_SCALE,
  MIN_SCALE,
  type Transform,
  fitToBounds,
  fitTransform,
  getOffscreenLiveArrowBox,
  getSubagentBadgeAt,
  hitTest,
  lodOf,
  render,
} from "../canvas/renderer.js";
import { buildColorContext, projectColor } from "../canvas/colors.js";
import { prettySlug } from "../format.js";
import { Minimap } from "./Minimap.js";
import { setUnreadBadge } from "../faviconBadge.js";
import { BookmarkGutter } from "./BookmarkGutter.js";
import { CommandPalette, type PaletteItem } from "./CommandPalette.js";
import { StatusBar } from "./StatusBar.js";
import { NodeContextToolbar } from "./NodeContextToolbar.js";
import { OnboardingTour } from "./OnboardingTour.js";
import { LoadingSkeleton } from "./LoadingSkeleton.js";
import { DEFAULT_FILTER, DEFAULT_VISIBILITY, type BackgroundStyle, type ColorMode, type ForestNode, type ForestPayload, type Layout, type LayoutDirection, type NodeStyle, type SessionFilter, type Space, type ViewMode, type VisibilityFilter } from "../canvas/types.js";

const PAN_THRESHOLD_PX = 5;

export function TreeMap({ onClose }: { onClose: () => void }) {
  const [forest, setForest] = useState<ForestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // URL state takes priority over localStorage so deep-links land you on the
  // exact view someone shared. After mount, any state change is mirrored back
  // to the URL hash via replaceState (no history spam).
  const urlInit = useMemo(() => parseUrlState(), []);
  const [mode, setMode] = useState<ViewMode>(urlInit.mode ?? "per-project");
  const [scopeProject, setScopeProject] = useState<string | null>(urlInit.scopeProject ?? null);
  const [selected, setSelected] = useState<string | null>(urlInit.selected ?? null);
  // Multi-select set: ctrl/cmd+click toggles a node in/out. Used for bulk
  // bookmark and bulk add-to-Space actions. Separate from `selected` (single).
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  // Pinned inline card (cards mode only). When set, the inline expand stays
  // open on that card even as you click around. Snapshots the detail at pin
  // time so subsequent selections don't overwrite its content.
  const [pinnedCardId, setPinnedCardId] = useState<string | null>(null);
  const [pinnedDetail, setPinnedDetail] = useState<NodeResponse | null>(null);
  // Browser-style selection history. User picks (click, search step, keyboard
  // nav, etc.) push entries; alt+left/right walk back and forward through them.
  const selectionHistoryRef = useRef<{ entries: string[]; cursor: number }>({ entries: [], cursor: -1 });
  // True for one tick when we're driving setSelected from a history nav, so
  // the push effect doesn't immediately push the same id back.
  const navigatingHistoryRef = useRef(false);
  const [selectedDetail, setSelectedDetail] = useState<NodeResponse | null>(null);
  const [hovered, setHovered] = useState<{ kind: "node" | "session"; id: string } | null>(null);
  // Hover-tooltip grace period: don't flash the tooltip until cursor has rested
  // on a node for 200ms. Once tooltip is showing, swapping to a different node
  // shows immediately (no flicker). Reset to delayed when hover ends.
  const [tooltipReady, setTooltipReady] = useState(false);
  useEffect(() => {
    if (!hovered) { setTooltipReady(false); return; }
    if (tooltipReady) return; // already shown — swap immediately
    const id = window.setTimeout(() => setTooltipReady(true), 200);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    target: { kind: "node" | "session" | "empty"; id?: string };
  } | null>(null);
  const selectSessionInViewer = useStore((s) => s.selectSession);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Recent searches (last 10) — shown as suggestions when search opens empty.
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("cc-map-recent-searches");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter((s) => typeof s === "string").slice(0, 10);
      }
    } catch {}
    return [];
  });
  const pushRecentSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setRecentSearches((prev) => {
      const next = [t, ...prev.filter((x) => x !== t)].slice(0, 10);
      try { localStorage.setItem("cc-map-recent-searches", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const removeRecentSearch = useCallback((q: string) => {
    setRecentSearches((prev) => {
      const next = prev.filter((x) => x !== q);
      try { localStorage.setItem("cc-map-recent-searches", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Sidebar collapse-all / expand-all. We re-key the sidebar so every
  // SidebarGroup re-mounts and reads its (just-updated) localStorage flag.
  // Cheaper than threading a forceOpen prop into every group.
  const SIDEBAR_GROUP_IDS = ["scope", "display", "live", "filter", "live-card", "saved", "activity"];
  const [sidebarKey, setSidebarKey] = useState(0);
  const setAllGroupsOpen = useCallback((open: boolean) => {
    for (const gid of SIDEBAR_GROUP_IDS) {
      try { localStorage.setItem(`cc-map-sb-${gid}`, open ? "1" : "0"); } catch {}
    }
    setSidebarKey((k) => k + 1);
  }, []);
  // Welcome modal shown on first visit (no localStorage flag yet).
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    try { return localStorage.getItem("cc-map-seen-welcome") !== "1"; } catch { return false; }
  });
  const [inputMode, setInputMode] = useState<"auto" | "mouse" | "trackpad">(() => {
    try {
      const raw = localStorage.getItem("cc-map-input-mode");
      if (raw === "mouse" || raw === "trackpad" || raw === "auto") return raw;
    } catch {}
    return "auto";
  });
  useEffect(() => {
    try { localStorage.setItem("cc-map-input-mode", inputMode); } catch {}
  }, [inputMode]);
  // Spawn modal state — defined here so context menu handlers below can open it.
  // The submit handler is wired further down after addSessionToSpace is defined.
  const [spawnModal, setSpawnModal] = useState<
    | null
    | { mode: "new"; cwd: string; prompt: string; targetSpaceId: string | null }
    | { mode: "continue"; sessionId: string; cwd: string; prompt: string }
  >(null);

  // In-app replacements for window.prompt / window.confirm / alert so naming a
  // Space, confirming a delete, or surfacing an error doesn't fire a jarring,
  // unstyled native dialog that blocks the whole tab.
  const [textPrompt, setTextPrompt] = useState<
    | null
    | { title: string; label?: string; initial: string; placeholder?: string; confirmLabel?: string; onSubmit: (value: string) => void }
  >(null);
  const [confirmDialog, setConfirmDialog] = useState<
    | null
    | { title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }
  >(null);
  const [toast, setToast] = useState<{ id: number; message: string; kind: "error" | "info" } | null>(null);
  const showToast = useCallback((message: string, kind: "error" | "info" = "info") => {
    const id = Date.now();
    setToast({ id, message, kind });
    window.setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 5000);
  }, []);

  // ───── Spaces (top-level workspaces) ─────
  // A Space is a curated subset of the forest. Switching INTO a space filters
  // the map to its member sessions. Spaces are persisted to localStorage.
  // Phase 3c will let you spawn new CC sessions directly into a space.
  const [spaces, setSpaces] = useState<Space[]>(() => {
    try {
      const raw = localStorage.getItem("cc-map-spaces-v2");
      if (raw) return JSON.parse(raw) as Space[];
    } catch {}
    return [];
  });
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(() => {
    if (urlInit.activeSpaceId !== undefined) return urlInit.activeSpaceId;
    try {
      return localStorage.getItem("cc-map-active-space") || null;
    } catch { return null; }
  });
  useEffect(() => {
    try {
      if (activeSpaceId) localStorage.setItem("cc-map-active-space", activeSpaceId);
      else localStorage.removeItem("cc-map-active-space");
    } catch {}
  }, [activeSpaceId]);
  const persistSpaces = useCallback((arr: Space[]) => {
    setSpaces(arr);
    try { localStorage.setItem("cc-map-spaces-v2", JSON.stringify(arr)); } catch {}
  }, []);
  const upsertSpace = useCallback((sp: Space) => {
    setSpaces((prev) => {
      const next = prev.some((p) => p.id === sp.id)
        ? prev.map((p) => (p.id === sp.id ? sp : p))
        : [...prev, sp];
      try { localStorage.setItem("cc-map-spaces-v2", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const deleteSpace = useCallback((id: string) => {
    setSpaces((prev) => {
      const next = prev.filter((p) => p.id !== id);
      try { localStorage.setItem("cc-map-spaces-v2", JSON.stringify(next)); } catch {}
      return next;
    });
    setActiveSpaceId((cur) => (cur === id ? null : cur));
  }, []);
  const activeSpace = activeSpaceId ? spaces.find((s) => s.id === activeSpaceId) ?? null : null;

  // Drag-to-Space state. Shift+drag a node on canvas → drags its session as a
  // chip. Hovering a Space chip in the sidebar highlights it; release drops
  // the session into that space.
  const [dragSession, setDragSession] = useState<{ sessionId: string; label: string; x: number; y: number } | null>(null);
  const [dragOverSpaceId, setDragOverSpaceId] = useState<string | null>(null);
  // Global drag tracker: while dragSession is active, follow the cursor and
  // detect which space chip is under it. On release, drop into that space.
  useEffect(() => {
    if (!dragSession) return;
    const onMove = (e: MouseEvent) => {
      setDragSession((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const chip = el?.closest("[data-space-id]") as HTMLElement | null;
      setDragOverSpaceId(chip ? chip.dataset.spaceId ?? null : null);
    };
    const onUp = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const chip = el?.closest("[data-space-id]") as HTMLElement | null;
      const targetId = chip?.dataset.spaceId ?? null;
      if (targetId) {
        const sp = spaces.find((s) => s.id === targetId);
        if (sp && !sp.sessionIds.includes(dragSession.sessionId)) {
          upsertSpace({ ...sp, sessionIds: [...sp.sessionIds, dragSession.sessionId] });
        }
      }
      setDragSession(null);
      setDragOverSpaceId(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragSession, spaces, upsertSpace]);
  // Add/remove a session from the active space
  const addSessionToSpace = useCallback((sid: string, targetSpaceId?: string) => {
    const id = targetSpaceId ?? activeSpaceId;
    if (!id) return;
    const sp = spaces.find((s) => s.id === id);
    if (!sp) return;
    if (sp.sessionIds.includes(sid)) return;
    upsertSpace({ ...sp, sessionIds: [...sp.sessionIds, sid] });
  }, [spaces, activeSpaceId, upsertSpace]);
  const removeSessionFromSpace = useCallback((sid: string, targetSpaceId?: string) => {
    const id = targetSpaceId ?? activeSpaceId;
    if (!id) return;
    const sp = spaces.find((s) => s.id === id);
    if (!sp) return;
    upsertSpace({ ...sp, sessionIds: sp.sessionIds.filter((x) => x !== sid) });
  }, [spaces, activeSpaceId, upsertSpace]);
  void persistSpaces; // exposed for future bulk ops

  // Submit the spawn modal — POST to server, then auto-add the new sessionId
  // to the target space (if "new" mode) so it shows up in the space's filter.
  // After "new" submit: auto-transitions into "continue" mode for that session,
  // so the same modal stays open as a chat-like back-and-forth.
  // After "continue" submit: clears the prompt, keeps modal open for next turn.
  const submitSpawn = useCallback(async () => {
    if (!spawnModal) return;
    if (!spawnModal.prompt.trim()) return;
    const token = localStorage.getItem("cc-map-token") ?? "";
    const path = spawnModal.mode === "new" ? "/api/spawn-session" : "/api/continue-session";
    const body = spawnModal.mode === "new"
      ? { prompt: spawnModal.prompt, cwd: spawnModal.cwd }
      : { sessionId: spawnModal.sessionId, prompt: spawnModal.prompt, cwd: spawnModal.cwd };
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { ok?: boolean; sessionId?: string; error?: string };
      if (!r.ok || !j.ok) {
        showToast(`Spawn failed: ${j.error ?? r.statusText}`, "error");
        return;
      }
      // For "new" mode: add session to space + transition modal to "continue" mode
      if (spawnModal.mode === "new") {
        if (spawnModal.targetSpaceId && j.sessionId) {
          addSessionToSpace(j.sessionId, spawnModal.targetSpaceId);
        }
        if (j.sessionId) {
          setSpawnModal({
            mode: "continue",
            sessionId: j.sessionId,
            cwd: spawnModal.cwd,
            prompt: "",
          });
        }
      } else {
        // continue mode: keep modal open, clear prompt for next turn
        setSpawnModal({ ...spawnModal, prompt: "" });
      }
    } catch (e) {
      showToast(`Spawn failed: ${e}`, "error");
    }
  }, [spawnModal, addSessionToSpace, showToast]);

  // ───── Bookmarks (per-uuid) ─────
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("cc-map-bookmarks");
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {}
    return new Set();
  });
  const toggleBookmark = useCallback((id: string) => {
    setBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem("cc-map-bookmarks", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const [nodeStyle, setNodeStyle] = useState<NodeStyle>(() => {
    if (urlInit.nodeStyle) return urlInit.nodeStyle;
    try {
      const raw = localStorage.getItem("cc-map-nodestyle");
      if (raw === "cards" || raw === "dots") return raw;
    } catch {}
    return "dots";
  });
  useEffect(() => {
    try { localStorage.setItem("cc-map-nodestyle", nodeStyle); } catch {}
  }, [nodeStyle]);

  const [direction, setDirection] = useState<LayoutDirection>(() => {
    if (urlInit.direction) return urlInit.direction;
    try {
      const raw = localStorage.getItem("cc-map-direction");
      if (raw === "grid" || raw === "column" || raw === "timeline") return raw;
    } catch {}
    return "grid";
  });
  useEffect(() => {
    try { localStorage.setItem("cc-map-direction", direction); } catch {}
  }, [direction]);
  // Mark that direction or node style changed so the next layout build triggers an auto-refit.
  const directionChangedRef = useRef(false);
  useEffect(() => {
    directionChangedRef.current = true;
  }, [direction, nodeStyle]);
  const [filter, setFilter] = useState<SessionFilter>(() => {
    try {
      const raw = localStorage.getItem("cc-map-filter");
      if (raw) return { ...DEFAULT_FILTER, ...JSON.parse(raw) };
    } catch {}
    return DEFAULT_FILTER;
  });
  const updateFilter = useCallback((patch: Partial<SessionFilter>) => {
    setFilter((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem("cc-map-filter", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const [visibility, setVisibility] = useState<VisibilityFilter>(() => {
    try {
      const raw = localStorage.getItem("cc-map-visibility");
      if (raw) return { ...DEFAULT_VISIBILITY, ...JSON.parse(raw) };
    } catch {}
    return DEFAULT_VISIBILITY;
  });
  const toggleVisibility = useCallback((key: keyof VisibilityFilter) => {
    setVisibility((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem("cc-map-visibility", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Saved views: a named snapshot of (mode, scopeProject, filter, visibility,
  // nodeStyle, direction, colorMode). Stored in localStorage. Persists across
  // sessions so power users can hop between curated views.
  interface SavedView {
    id: string;
    name: string;
    mode: ViewMode;
    scopeProject: string | null;
    filter: SessionFilter;
    visibility: VisibilityFilter;
    nodeStyle: NodeStyle;
    direction: LayoutDirection;
    colorMode: ColorMode;
  }
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => {
    try {
      const raw = localStorage.getItem("cc-map-views");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch {}
    return [];
  });
  const persistViews = useCallback((next: SavedView[]) => {
    setSavedViews(next);
    try { localStorage.setItem("cc-map-views", JSON.stringify(next)); } catch {}
  }, []);

  const [colorMode, setColorMode] = useState<ColorMode>(() => {
    if (urlInit.colorMode) return urlInit.colorMode;
    try {
      const raw = localStorage.getItem("cc-map-color-mode");
      if (raw === "role" || raw === "recency" || raw === "cost") return raw;
    } catch {}
    return "role";
  });

  const [backgroundStyle, setBackgroundStyle] = useState<BackgroundStyle>(() => {
    try {
      const raw = localStorage.getItem("cc-map-background");
      if (raw === "none" || raw === "grid" || raw === "dots") return raw;
    } catch {}
    return "none";
  });
  useEffect(() => {
    try { localStorage.setItem("cc-map-background", backgroundStyle); } catch {}
  }, [backgroundStyle]);
  useEffect(() => {
    try { localStorage.setItem("cc-map-color-mode", colorMode); } catch {}
  }, [colorMode]);

  // Mirror current view state to the URL hash so it's shareable + bookmarkable.
  // Uses replaceState so we don't pile up history entries on every toggle.
  useEffect(() => {
    writeUrlState({ mode, scopeProject, direction, nodeStyle, colorMode, activeSpaceId, selected });
  }, [mode, scopeProject, direction, nodeStyle, colorMode, activeSpaceId, selected]);

  // Follow Live: when on, auto-pan to keep the live tip centered as new
  // messages land. Persists per-device. Auto-disengages on manual pan/zoom
  // so the user doesn't fight the camera.
  const [followLive, setFollowLive] = useState<boolean>(() => {
    try { return localStorage.getItem("cc-map-follow-live") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("cc-map-follow-live", followLive ? "1" : "0"); } catch {}
  }, [followLive]);

  const transformRef = useRef<Transform>({ tx: 0, ty: 0, scale: 1 });
  const dirtyRef = useRef(true);
  // Pan inertia — on mouse-drag or WASD release with velocity, the camera
  // keeps gliding for ~350ms with exponential decay. Cancelled on any new
  // user input (mousedown, wheel, key). Feels like Mac trackpad scroll.
  const inertiaRef = useRef<{ vx: number; vy: number; startMs: number; lastMs: number } | null>(null);
  // Spotlight ping timestamp — bumped on each selection change so the renderer
  // can draw a one-shot expanding ring at the selected node (350ms).
  const selectionPingMsRef = useRef<number | null>(null);
  // WASD smooth-pan: track which keys are held; the RAF loop reads this and
  // advances the camera each frame. Separate from arrow-key node cycling.
  // shift = faster (~2.1×). Cleared on blur to avoid stuck keys.
  const wasdKeysRef = useRef<Set<string>>(new Set());
  const wasdShiftRef = useRef<boolean>(false);
  const wasdLastFrameMsRef = useRef<number>(0);
  // Per-ms velocity from the most recent WASD frame; consumed on release to
  // hand off to the inertia system so the camera glides to a stop.
  const wasdLastVxVyRef = useRef<{ vx: number; vy: number } | null>(null);
  // Morph state: when the layout changes shape (direction or nodeStyle), we
  // smoothly interpolate node and band positions from prev → new over ~450ms
  // so the spatial transition is readable instead of a jarring snap.
  const prevLayoutRef = useRef<Layout | null>(null);
  const lastShapeRef = useRef<{ direction: LayoutDirection; nodeStyle: NodeStyle } | null>(null);
  const morphRef = useRef<{
    startMs: number;
    durationMs: number;
    oldNodes: Map<string, { x: number; y: number; cardHeight?: number }>;
    targetNodes: Map<string, { x: number; y: number; cardHeight?: number }>;
    oldBands: Map<string, { minX: number; maxX: number; minY: number; maxY: number }>;
    targetBands: Map<string, { minX: number; maxX: number; minY: number; maxY: number }>;
  } | null>(null);
  // Animated transitions: when set, RAF interpolates from `from` to `to`.
  const transitionRef = useRef<{ from: Transform; to: Transform; startMs: number; durationMs: number } | null>(null);

  // ───── Forest load ─────
  // Re-fetch is exposed as fetchForest() so the SSE onConnect handler can call
  // it whenever the stream (re-)opens — that backfills any deltas missed
  // during a disconnect window (e.g. when the server restarts).
  const fetchForest = useCallback(async () => {
    try {
      const r = await fetch("/api/forest", {
        headers: { Authorization: `Bearer ${localStorage.getItem("cc-map-token") ?? ""}` },
      });
      const data = (await r.json()) as ForestPayload;
      setForest(data);
      setScopeProject((prev) => {
        if (prev) return prev;
        if (data.projects.length === 0) return null;
        const activeNode = data.activeSessionId
          ? data.nodes.find((n) => n.sessionId === data.activeSessionId)
          : null;
        return (
          activeNode?.projectSlug ??
          [...data.projects].sort((a, b) => b.sessionCount - a.sessionCount)[0]!.slug
        );
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void fetchForest();
  }, [fetchForest]);

  // ───── Live updates via SSE ─────
  // The same SSE stream the viewer uses. On each delta we mutate the forest in place
  // (no full refetch — keeps viewport stable). Layout recomputes via useMemo since
  // we replace the `forest` reference. Throttled to coalesce rapid bursts.
  const pendingNodesRef = useRef<ForestNode[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  // Recent activity toasts — popups in the bottom-right for new messages
  // arriving in OTHER sessions (not the one you're currently watching).
  // Auto-prune after TOAST_TTL_MS so they don't pile up.
  interface ActivityToast {
    nodeId: string;
    sessionId: string;
    projectSlug: string;
    role: "user" | "assistant";
    subtype: string | null;
    preview: string;
    receivedMs: number;
  }
  const [activityToasts, setActivityToasts] = useState<ActivityToast[]>([]);
  const TOAST_TTL_MS = 6000;
  // Background-tab unread counter — badged on favicon + title until refocus.
  const [unreadCount, setUnreadCount] = useState(0);
  // Keep a ref to the currently-watched session id so the SSE callback (which
  // is stable across renders) can read it without re-binding.
  const activeWatchedRef = useRef<string | null>(null);
  const onSse = useCallback((e: SseEvent) => {
    if (e.type === "delta") {
      // eslint-disable-next-line no-console
      console.log("[cc-map] sse delta", { added: e.added.length, sessions: e.sessionsTouched.length });
      // Convert server's delta nodes into the lighter ForestNode shape
      for (const rawAny of e.added) {
        const raw = rawAny as unknown as Record<string, unknown>;
        const cls = (raw["classification"] as { role?: "user" | "assistant"; subtype?: string } | undefined);
        const role: "user" | "assistant" = cls?.role ?? "assistant";
        const subtype = role === "user" ? (cls?.subtype ?? null) : null;
        pendingNodesRef.current.push({
          id: String(raw["id"] ?? ""),
          parentId: (raw["parentId"] ?? null) as string | null,
          sessionId: String(raw["sessionId"] ?? ""),
          projectSlug: String(raw["projectSlug"] ?? ""),
          role,
          subtype,
          isSidechain: Boolean(raw["isSidechain"]),
          timestamp: String(raw["timestamp"] ?? ""),
          preview: String(raw["preview"] ?? "").slice(0, 80),
          outputTokens: typeof raw["outputTokens"] === "number" ? (raw["outputTokens"] as number) : 0,
          sessionsIn: 1,
        });
      }
      if (flushTimerRef.current == null) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          const toAdd = pendingNodesRef.current;
          pendingNodesRef.current = [];
          if (toAdd.length === 0) return;
          setForest((prev) => {
            if (!prev) return prev;
            // Dedup by id (new nodes win, in case of revision)
            const existing = new Map(prev.nodes.map((n) => [n.id, n]));
            for (const n of toAdd) existing.set(n.id, n);
            return { ...prev, nodes: [...existing.values()] };
          });
          // Build toasts for "interesting" new nodes in OTHER sessions.
          // Skip noise: tool-only assistant turns, tool-results, system messages.
          const watched = activeWatchedRef.current;
          const isInteresting = (n: ForestNode) => {
            if (n.role === "assistant") return n.subtype === "text";
            return n.subtype === "prompt";
          };
          const newToasts: ActivityToast[] = [];
          const seenSessions = new Set<string>();
          // Iterate newest first; only one toast per session per flush
          for (let i = toAdd.length - 1; i >= 0; i--) {
            const n = toAdd[i]!;
            if (!isInteresting(n)) continue;
            if (n.sessionId === watched) continue;
            if (seenSessions.has(n.sessionId)) continue;
            seenSessions.add(n.sessionId);
            newToasts.push({
              nodeId: n.id,
              sessionId: n.sessionId,
              projectSlug: n.projectSlug,
              role: n.role,
              subtype: n.subtype,
              preview: n.preview,
              receivedMs: Date.now(),
            });
            if (newToasts.length >= 3) break;
          }
          if (newToasts.length > 0) {
            setActivityToasts((prev) => [...newToasts, ...prev].slice(0, 5));
            // Background-tab unread badge — bump favicon/title counter ONLY
            // when the tab is hidden. We need ALL interesting messages, not
            // just other-session ones, so count from toAdd directly.
            if (document.hidden) {
              const interestingDelta = toAdd.filter((n) =>
                (n.role === "assistant" && n.subtype === "text") ||
                (n.role === "user" && n.subtype === "prompt")
              ).length;
              if (interestingDelta > 0) setUnreadCount((c) => c + interestingDelta);
            }
          }
        }, 250);
      }
    } else if (e.type === "active-session") {
      setForest((prev) => prev ? { ...prev, activeSessionId: e.sessionId, activeSessionAt: e.at } : prev);
    }
  }, []);
  useSse(onSse, fetchForest);

  // Reset unread count when tab regains focus.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) setUnreadCount(0); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // Apply favicon + title badge whenever unreadCount changes (or scope changes).
  useEffect(() => {
    const scope = activeSpace ? activeSpace.name
      : (mode === "per-project" && scopeProject ? prettySlug(scopeProject) : null);
    setUnreadBadge(unreadCount, scope);
  }, [unreadCount, activeSpace, mode, scopeProject]);

  // Prune activity toasts that have aged out (TOAST_TTL_MS).
  useEffect(() => {
    if (activityToasts.length === 0) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setActivityToasts((prev) => prev.filter((t) => now - t.receivedMs < TOAST_TTL_MS));
    }, 500);
    return () => window.clearInterval(id);
  }, [activityToasts.length]);

  // ───── Allowed sessions from facet filter + active space ─────
  // null means "no filter active" — buildLayout treats this as everything allowed.
  const allowedSessions = useMemo(() => {
    if (!forest) return null;
    const hasActiveFilter =
      filter.startDate || filter.endDate || filter.requiredTools.length > 0 || filter.bookmarkedOnly;
    const hasActiveSpace = activeSpace !== null;
    if (!hasActiveFilter && !hasActiveSpace) return null;
    const bookmarkedSessions = new Set<string>();
    if (filter.bookmarkedOnly) {
      for (const n of forest.nodes) if (bookmarks.has(n.id)) bookmarkedSessions.add(n.sessionId);
    }
    const startMs = filter.startDate ? new Date(filter.startDate + "T00:00:00").getTime() : -Infinity;
    const endMs = filter.endDate ? new Date(filter.endDate + "T23:59:59").getTime() : Infinity;
    const allowed = new Set<string>();
    for (const [sid, info] of Object.entries(forest.sessionTitles ?? {})) {
      // Date filter — overlap test
      const startedMs = info.startedAt ? new Date(info.startedAt).getTime() : 0;
      const endedMs = info.lastActivityAt ? new Date(info.lastActivityAt).getTime() : startedMs;
      if (endedMs < startMs || startedMs > endMs) continue;
      // Tool filter — at least one required tool must be present
      if (filter.requiredTools.length > 0) {
        const has = filter.requiredTools.some((t) => info.toolsUsed.includes(t));
        if (!has) continue;
      }
      // Bookmark filter
      if (filter.bookmarkedOnly && !bookmarkedSessions.has(sid)) continue;
      // Active space filter — must be a member
      if (activeSpace && !activeSpace.sessionIds.includes(sid)) continue;
      allowed.add(sid);
    }
    return allowed;
  }, [forest, filter, bookmarks, activeSpace]);

  // ───── Layout ─────
  const layout: Layout | null = useMemo(() => {
    if (!forest) return null;
    const t0 = performance.now();
    const l = buildLayout(forest, mode, mode === "per-project" ? scopeProject : null, visibility, direction, allowedSessions, nodeStyle);
    console.log(`layout: ${l.nodes.size} nodes, ${l.sessionBands.length} sessions in ${(performance.now() - t0).toFixed(0)}ms`);
    return l;
  }, [forest, mode, scopeProject, visibility, direction, allowedSessions, nodeStyle]);

  // Morph trigger: capture old positions from prevLayoutRef → animate them
  // toward the just-computed layout's positions. Fires on direction/nodeStyle
  // shape changes only (filter changes shouldn't morph — they add/remove nodes
  // and morph there looks weird).
  useEffect(() => {
    if (!layout) return;
    const lastShape = lastShapeRef.current;
    const shapeChanged = lastShape && (lastShape.direction !== direction || lastShape.nodeStyle !== nodeStyle);
    const prevLayout = prevLayoutRef.current;
    if (shapeChanged && prevLayout && prevLayout.nodes.size > 0 && layout.nodes.size > 0) {
      const oldNodes = new Map<string, { x: number; y: number; cardHeight?: number }>();
      const targetNodes = new Map<string, { x: number; y: number; cardHeight?: number }>();
      for (const [id, ln] of prevLayout.nodes) {
        const entry: { x: number; y: number; cardHeight?: number } = { x: ln.x, y: ln.y };
        if (ln.cardHeight !== undefined) entry.cardHeight = ln.cardHeight;
        oldNodes.set(id, entry);
      }
      for (const [id, ln] of layout.nodes) {
        const entry: { x: number; y: number; cardHeight?: number } = { x: ln.x, y: ln.y };
        if (ln.cardHeight !== undefined) entry.cardHeight = ln.cardHeight;
        targetNodes.set(id, entry);
      }
      const oldBands = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
      const targetBands = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
      for (const b of prevLayout.sessionBands) oldBands.set(b.sessionId, { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY });
      for (const b of layout.sessionBands) targetBands.set(b.sessionId, { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY });
      morphRef.current = { startMs: performance.now(), durationMs: 450, oldNodes, targetNodes, oldBands, targetBands };
      dirtyRef.current = true;
    }
    prevLayoutRef.current = layout;
    lastShapeRef.current = { direction, nodeStyle };
  }, [layout, direction, nodeStyle]);

  // Union of tools across all sessions in the current scope — what we offer in the filter UI
  const availableTools = useMemo(() => {
    if (!forest?.sessionTitles) return [] as string[];
    const tools = new Set<string>();
    for (const [, info] of Object.entries(forest.sessionTitles)) {
      for (const t of info.toolsUsed) tools.add(t);
    }
    return [...tools].sort();
  }, [forest]);

  // ───── Search matches ─────
  const matches = useMemo(() => {
    if (!searchQuery.trim() || !forest) return null;
    const q = searchQuery.toLowerCase();
    const ids = new Set<string>();
    for (const n of forest.nodes) {
      if (n.preview.toLowerCase().includes(q)) ids.add(n.id);
    }
    return ids;
  }, [searchQuery, forest]);
  // Ordered list of matches (by timestamp) so n/N can step through them in a
  // predictable order. Filtered to ids that actually exist in the current
  // layout (visibility filters might hide some matches).
  const matchList = useMemo(() => {
    if (!matches || !forest || !layout) return [] as string[];
    const arr: { id: string; ts: string }[] = [];
    for (const n of forest.nodes) {
      if (matches.has(n.id) && layout.nodes.has(n.id)) arr.push({ id: n.id, ts: n.timestamp });
    }
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
    return arr.map((x) => x.id);
  }, [matches, forest, layout]);
  // Cursor into matchList: which match is currently focused (panned to).
  const [matchIndex, setMatchIndex] = useState(0);
  useEffect(() => { setMatchIndex(0); }, [searchQuery]);

  // ───── Canvas sizing ─────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // State-backed ref signal so the wheel useEffect (and others) re-run
  // when the canvas DOM node finally mounts. Without this, on first page load
  // the wheel handler is attached BEFORE the canvas exists and never re-attaches.
  const [canvasReady, setCanvasReady] = useState(false);
  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    setCanvasReady(el !== null);
  }, []);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const r = e.contentRect;
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      dirtyRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ───── Active session = session with the most-recent node ─────
  // Recomputed on every forest update (which includes SSE deltas) so it stays
  // in sync as you type. We ignore the server's activeSessionId (it's only
  // reliable if the SessionStart hook is installed and is one-shot at fetch time).
  const effectiveActiveSession = useMemo(() => {
    if (!forest) return null;
    let latestTs = "";
    let latestSessionId: string | null = null;
    for (const n of forest.nodes) {
      if (n.timestamp > latestTs) {
        latestTs = n.timestamp;
        latestSessionId = n.sessionId;
      }
    }
    return latestSessionId;
  }, [forest]);

  // Keep the toast-filter watched-session ref in sync with what the user is
  // focused on (selection > active session). Toasts skip the watched session
  // since the user's already looking at it.
  useEffect(() => {
    activeWatchedRef.current = selected
      ? forest?.nodes.find((n) => n.id === selected)?.sessionId ?? null
      : effectiveActiveSession ?? null;
  }, [selected, forest, effectiveActiveSession]);

  // Live tip = latest "meaningful" node in the active session: only prompts or
  // assistant turns, not tool-results / slash / system-reminders. If only noise
  // is visible, fall back to any visible node so you still see something.
  const liveTipId = useMemo(() => {
    if (!layout || !forest || !effectiveActiveSession) return null;
    const isMeaningful = (n: { role: "user" | "assistant"; subtype: string | null }) =>
      n.role === "assistant" || (n.role === "user" && n.subtype === "prompt");
    let bestTs = "";
    let bestId: string | null = null;
    let fallbackTs = "";
    let fallbackId: string | null = null;
    for (const n of forest.nodes) {
      if (n.sessionId !== effectiveActiveSession) continue;
      if (!layout.nodes.has(n.id)) continue;
      if (isMeaningful(n)) {
        if (n.timestamp > bestTs) { bestTs = n.timestamp; bestId = n.id; }
      }
      if (n.timestamp > fallbackTs) { fallbackTs = n.timestamp; fallbackId = n.id; }
    }
    return bestId ?? fallbackId;
  }, [layout, forest, effectiveActiveSession]);

  // ───── Command palette items ─────
  // Built fresh each render so labels reflect current state. Categories are
  // grouped and rendered in order; keep "Jump to session" first so the
  // most-common use (find a session by content) is at top of the empty query.
  const paletteItems = useMemo<PaletteItem[]>(() => {
    if (!forest || !layout) return [];
    const items: PaletteItem[] = [];

    // Jump to session — first prompt as a friendly title
    const sessionsSeen = new Set<string>();
    for (const band of layout.sessionBands) {
      if (sessionsSeen.has(band.sessionId)) continue;
      sessionsSeen.add(band.sessionId);
      const info = forest.sessionTitles?.[band.sessionId];
      const title = info?.aiTitle || band.firstPrompt || "(untitled)";
      const projSlug = forest.nodes.find((n) => n.sessionId === band.sessionId)?.projectSlug ?? "";
      const facts: { label: string; value: string }[] = [
        { label: "session", value: band.sessionId.slice(0, 8) },
        { label: "project", value: prettySlug(projSlug) },
        { label: "messages", value: String(band.nodeCount) },
      ];
      if (info?.tokens) {
        const tot = info.tokens.input + info.tokens.output + info.tokens.cacheRead;
        if (tot > 0) facts.push({ label: "tokens", value: `${(tot / 1000).toFixed(1)}k` });
      }
      if (info?.startedAt) facts.push({ label: "started", value: new Date(info.startedAt).toLocaleDateString() });
      if (info?.lastActivityAt) facts.push({ label: "last activity", value: new Date(info.lastActivityAt).toLocaleString() });
      if (info?.toolsUsed && info.toolsUsed.length > 0) {
        facts.push({ label: "tools", value: info.toolsUsed.slice(0, 5).join(", ") + (info.toolsUsed.length > 5 ? "…" : "") });
      }
      items.push({
        id: `jump-session-${band.sessionId}`,
        category: "Jump to session",
        label: title.slice(0, 80),
        hint: `${band.sessionId.slice(0, 8)} · ${band.nodeCount} nodes`,
        action: () => { animateTo(fitToBounds(band, size.w, size.h, 80)); },
        preview: {
          title: title.slice(0, 200),
          ...(info?.aiTitle && band.firstPrompt ? { subtitle: `First prompt: ${band.firstPrompt}` } : {}),
          facts,
        },
      });
    }

    // Bookmarks
    for (const bid of bookmarks) {
      const n = forest.nodes.find((x) => x.id === bid);
      if (!n) continue;
      items.push({
        id: `jump-bookmark-${bid}`,
        category: "Bookmarks",
        label: `★ ${n.preview.slice(0, 80) || bid.slice(0, 8)}`,
        hint: bid.slice(0, 8),
        action: () => {
          setSelected(bid);
          const ln = layout.nodes.get(bid);
          if (ln) {
            const t = transformRef.current;
            animateTo({ scale: t.scale, tx: size.w / 2 - ln.x * t.scale, ty: size.h / 2 - ln.y * t.scale }, 350);
          }
        },
        preview: {
          title: n.preview || bid.slice(0, 8),
          subtitle: `${n.role}${n.subtype ? ` · ${n.subtype}` : ""} · ${prettySlug(n.projectSlug)}`,
          ...(n.preview ? { body: n.preview } : {}),
          facts: [
            { label: "node", value: bid.slice(0, 8) },
            { label: "session", value: n.sessionId.slice(0, 8) },
            { label: "timestamp", value: new Date(n.timestamp).toLocaleString() },
          ],
        },
      });
    }

    // Spaces
    items.push({
      id: "space-all",
      category: "Switch space",
      label: "All sessions",
      hint: `${forest.sessionCount} total`,
      action: () => setActiveSpaceId(null),
    });
    for (const sp of spaces) {
      items.push({
        id: `space-${sp.id}`,
        category: "Switch space",
        label: `✦ ${sp.name}`,
        hint: `${sp.sessionIds.length} sessions`,
        action: () => setActiveSpaceId(sp.id),
      });
    }

    // Saved views
    for (const v of savedViews) {
      const vFacts: { label: string; value: string }[] = [
        { label: "view scope", value: v.mode },
        { label: "project", value: v.scopeProject ? prettySlug(v.scopeProject) : "all" },
        { label: "layout", value: v.direction },
        { label: "nodes", value: v.nodeStyle },
        { label: "color", value: v.colorMode },
      ];
      if (v.filter.startDate || v.filter.endDate) {
        vFacts.push({ label: "date", value: `${v.filter.startDate ?? "…"} → ${v.filter.endDate ?? "…"}` });
      }
      if (v.filter.requiredTools.length > 0) vFacts.push({ label: "tools", value: v.filter.requiredTools.join(", ") });
      if (v.filter.bookmarkedOnly) vFacts.push({ label: "bookmarks", value: "★ only" });
      items.push({
        id: `view-${v.id}`,
        category: "Apply saved view",
        label: v.name,
        hint: `${v.direction} · ${v.nodeStyle} · ${v.colorMode}`,
        action: () => {
          setMode(v.mode);
          setScopeProject(v.scopeProject);
          setFilter(v.filter);
          setVisibility(v.visibility);
          setNodeStyle(v.nodeStyle);
          setDirection(v.direction);
          setColorMode(v.colorMode);
        },
        preview: {
          title: v.name,
          subtitle: "Saved view — applies all settings below at once",
          facts: vFacts,
        },
      });
    }

    // Mode toggles
    for (const d of ["grid", "column", "timeline"] as const) {
      items.push({
        id: `dir-${d}`,
        category: "Switch layout",
        label: `Layout: ${d}${direction === d ? " (current)" : ""}`,
        action: () => setDirection(d),
      });
    }
    for (const s of ["dots", "cards"] as const) {
      items.push({
        id: `style-${s}`,
        category: "Switch nodes",
        label: `Nodes: ${s}${nodeStyle === s ? " (current)" : ""}`,
        action: () => setNodeStyle(s),
      });
    }
    for (const c of ["role", "recency", "cost"] as const) {
      items.push({
        id: `color-${c}`,
        category: "Switch color",
        label: `Color: ${c}${colorMode === c ? " (current)" : ""}`,
        action: () => setColorMode(c),
      });
    }
    for (const m of ["per-project", "all-projects"] as const) {
      items.push({
        id: `mode-${m}`,
        category: "Switch view",
        label: `View: ${m}${mode === m ? " (current)" : ""}`,
        action: () => setMode(m),
      });
    }

    // Project scope quick switch
    for (const p of forest.projects) {
      items.push({
        id: `scope-${p.slug}`,
        category: "Scope to project",
        label: prettySlug(p.slug),
        hint: `${p.sessionCount} sessions`,
        action: () => { setMode("per-project"); setScopeProject(p.slug); },
      });
    }

    // Actions
    items.push({
      id: "fit-all",
      category: "Actions",
      label: "Fit all to viewport",
      kbd: "f / 0",
      action: () => { if (layout) animateTo(fitTransform(layout, size.w, size.h)); },
    });
    if (liveTipId) {
      items.push({
        id: "jump-live",
        category: "Actions",
        label: "Jump to live tip",
        kbd: "space",
        action: () => {
          const ln = layout.nodes.get(liveTipId);
          if (ln) {
            const t = transformRef.current;
            const sc = Math.max(t.scale, 1.5);
            animateTo({ scale: sc, tx: size.w / 2 - ln.x * sc, ty: size.h / 2 - ln.y * sc }, 250);
            setSelected(liveTipId);
          }
        },
      });
    }
    items.push({
      id: "toggle-follow-live",
      category: "Actions",
      label: followLive ? "Turn off follow-live" : "Turn on follow-live",
      action: () => setFollowLive((v) => !v),
    });
    items.push({
      id: "open-search",
      category: "Actions",
      label: "Search messages…",
      kbd: "/",
      action: () => setSearchOpen(true),
    });

    return items;
  }, [forest, layout, bookmarks, spaces, savedViews, direction, nodeStyle, colorMode, mode, liveTipId, followLive, size.w, size.h]);

  // ───── Initial fit + re-fit when direction changes ─────
  // Prefer the ACTIVE session (the one you're typing in right now) so the live
  // pulse is in view. Falls back to most-recent, then fit-all.
  // Direction switches (grid ↔ column) also force a re-fit to re-orient the user.
  const fittedKey = useRef<string>("");
  useEffect(() => {
    if (!layout || !forest) return;
    const key = `${mode}::${scopeProject}::${size.w}x${size.h}::${direction}::${nodeStyle}`;
    if (fittedKey.current === key) return;
    if (size.w < 50 || size.h < 50) return;
    const activeBand = effectiveActiveSession
      ? layout.sessionBands.find((b) => b.sessionId === effectiveActiveSession)
      : null;
    const target = activeBand ?? mostRecentSessionBand(layout, forest);
    // First fit = direct (no animation). Subsequent direction-change fits = animated.
    if (directionChangedRef.current && fittedKey.current !== "") {
      directionChangedRef.current = false;
      if (target) animateTo(fitToBounds(target, size.w, size.h, 80), 400);
      else animateTo(fitTransform(layout, size.w, size.h), 400);
    } else {
      if (target) transformRef.current = fitToBounds(target, size.w, size.h, 80);
      else transformRef.current = fitTransform(layout, size.w, size.h);
      directionChangedRef.current = false;
    }
    fittedKey.current = key;
    dirtyRef.current = true;
  }, [layout, mode, scopeProject, size, forest, effectiveActiveSession, direction, nodeStyle]);

  // ───── RAF render loop ─────
  useEffect(() => {
    if (!layout) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const tick = () => {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const needResize = canvas.width !== cw * dpr || canvas.height !== ch * dpr;
      if (needResize) {
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        dirtyRef.current = true;
        if (cw > 0 && ch > 0 && (cw !== size.w || ch !== size.h)) {
          setSize({ w: cw, h: ch });
        }
      }
      // Pan inertia — gliding after a mouse drag or WASD release. Exponential
      // decay (half-life ~110ms) so it settles within ~350ms and feels native.
      const inertia = inertiaRef.current;
      if (inertia && wasdKeysRef.current.size === 0) {
        const nowMs = performance.now();
        const dt = nowMs - inertia.lastMs;
        inertia.lastMs = nowMs;
        const decay = Math.pow(0.5, dt / 110); // half-life 110ms
        inertia.vx *= decay;
        inertia.vy *= decay;
        if (Math.hypot(inertia.vx, inertia.vy) < 0.02) {
          inertiaRef.current = null;
        } else {
          transformRef.current = {
            ...transformRef.current,
            tx: transformRef.current.tx + inertia.vx * dt,
            ty: transformRef.current.ty + inertia.vy * dt,
          };
          dirtyRef.current = true;
        }
      }
      // WASD smooth pan — applied before camera transition so a press cancels
      // any in-flight animateTo cleanly. On release with velocity, hand off to
      // the inertia system so the camera glides to a stop.
      const heldKeys = wasdKeysRef.current;
      const wasHeld = wasdLastFrameMsRef.current !== 0;
      if (heldKeys.size > 0) {
        const nowMs = performance.now();
        const last = wasdLastFrameMsRef.current || nowMs;
        const dt = Math.min(64, nowMs - last) / 1000; // clamp dt so a tab unfreeze doesn't jump
        wasdLastFrameMsRef.current = nowMs;
        const SPEED_BASE = 800; // px/sec (screen-space, before transform)
        const speed = (wasdShiftRef.current ? 2.1 : 1) * SPEED_BASE * dt;
        let dx = 0;
        let dy = 0;
        if (heldKeys.has("w")) dy += 1;
        if (heldKeys.has("s")) dy -= 1;
        if (heldKeys.has("a")) dx += 1;
        if (heldKeys.has("d")) dx -= 1;
        if (dx !== 0 || dy !== 0) {
          // Normalize diagonal so W+D moves at the same speed as W alone
          const mag = Math.hypot(dx, dy);
          dx = (dx / mag) * speed;
          dy = (dy / mag) * speed;
          transitionRef.current = null; // any active animateTo defers to user input
          inertiaRef.current = null;
          transformRef.current = {
            ...transformRef.current,
            tx: transformRef.current.tx + dx,
            ty: transformRef.current.ty + dy,
          };
          // Stash the per-ms velocity so release can hand off to inertia
          wasdLastVxVyRef.current = { vx: dx / (dt * 1000), vy: dy / (dt * 1000) };
          dirtyRef.current = true;
        }
      } else {
        if (wasHeld) {
          // Just released — kick off inertia from last frame's velocity
          const v = wasdLastVxVyRef.current;
          if (v && Math.hypot(v.vx, v.vy) > 0.3) {
            const nowMs = performance.now();
            inertiaRef.current = { vx: v.vx, vy: v.vy, startMs: nowMs, lastMs: nowMs };
            dirtyRef.current = true;
          }
        }
        wasdLastFrameMsRef.current = 0;
        wasdLastVxVyRef.current = null;
      }
      // Animation: camera transform
      const tr = transitionRef.current;
      if (tr) {
        const elapsed = performance.now() - tr.startMs;
        const t = Math.min(1, elapsed / tr.durationMs);
        const eased = easeOutCubic(t);
        transformRef.current = {
          tx: tr.from.tx + (tr.to.tx - tr.from.tx) * eased,
          ty: tr.from.ty + (tr.to.ty - tr.from.ty) * eased,
          scale: tr.from.scale + (tr.to.scale - tr.from.scale) * eased,
        };
        dirtyRef.current = true;
        if (t >= 1) transitionRef.current = null;
      }
      // Animation: node/band position morph (direction or nodeStyle change)
      const m = morphRef.current;
      if (m && layout) {
        const t = Math.min(1, (performance.now() - m.startMs) / m.durationMs);
        const e = easeOutCubic(t);
        for (const [id, ln] of layout.nodes) {
          const target = m.targetNodes.get(id);
          if (!target) continue;
          const old = m.oldNodes.get(id);
          if (old) {
            ln.x = old.x + (target.x - old.x) * e;
            ln.y = old.y + (target.y - old.y) * e;
            if (target.cardHeight !== undefined && old.cardHeight !== undefined) {
              ln.cardHeight = old.cardHeight + (target.cardHeight - old.cardHeight) * e;
            }
          } else {
            ln.x = target.x; ln.y = target.y;
            if (target.cardHeight !== undefined) ln.cardHeight = target.cardHeight;
          }
        }
        for (const band of layout.sessionBands) {
          const target = m.targetBands.get(band.sessionId);
          if (!target) continue;
          const old = m.oldBands.get(band.sessionId);
          if (old) {
            band.minX = old.minX + (target.minX - old.minX) * e;
            band.maxX = old.maxX + (target.maxX - old.maxX) * e;
            band.minY = old.minY + (target.minY - old.minY) * e;
            band.maxY = old.maxY + (target.maxY - old.maxY) * e;
          }
        }
        dirtyRef.current = true;
        if (t >= 1) morphRef.current = null;
      }
      // Continuously dirty when there's anything animated (live pulse, transition, morph, wasd pan, spotlight, inertia)
      const pingActive = selectionPingMsRef.current !== null && performance.now() - selectionPingMsRef.current < 400;
      if (transitionRef.current || morphRef.current || liveTipId || effectiveActiveSession || wasdKeysRef.current.size > 0 || pingActive || inertiaRef.current) {
        dirtyRef.current = true;
      }
      if (dirtyRef.current && cw > 0 && ch > 0) {
        dirtyRef.current = false;
        render(
          ctx,
          layout,
          {
            transform: transformRef.current,
            selectedId: selected,
            hoveredId: hovered?.kind === "node" ? hovered.id : null,
            hoveredSessionId: hovered?.kind === "session" ? hovered.id : null,
            highlightedNodeIds: matches,
            mode,
            activeSessionId: effectiveActiveSession,
            liveTipId,
            nowMs: performance.now(),
            nodeStyle,
            colorMode,
            subagentsCollapsed: !visibility.subagent,
            multiSelectedIds: multiSelected.size > 0 ? multiSelected : null,
            selectionPingMs: selectionPingMsRef.current,
            backgroundStyle,
          },
          cw,
          ch,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layout, size, selected, hovered, mode, matches, forest, liveTipId, effectiveActiveSession, nodeStyle, colorMode, visibility.subagent, multiSelected, backgroundStyle]);

  // ───── Mouse interactions ─────
  const dragRef = useRef<{
    startX: number; startY: number;
    startTx: number; startTy: number;
    moved: boolean;
    // Sample buffer for velocity-on-release: keep the last few frames'
    // (x, y, ts) so we can compute average velocity over ~80ms (smoother
    // than just last-frame, which can be 0 if the cursor stopped briefly).
    samples: { x: number; y: number; ts: number }[];
  } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    // Shift+click on a node/session band starts a drag-to-Space gesture.
    if (e.shiftKey && layout) {
      const rect = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const hit = hitTest(layout, transformRef.current, sx, sy, nodeStyle);
      if (hit) {
        const sid = hit.kind === "node"
          ? layout.nodes.get(hit.id)?.sessionId
          : hit.id;
        if (sid) {
          const band = layout.sessionBands.find((b) => b.sessionId === sid);
          const label = band?.firstPrompt?.slice(0, 60) || sid.slice(0, 8);
          setDragSession({ sessionId: sid, label, x: e.clientX, y: e.clientY });
          return;
        }
      }
    }
    if (layout) {
      const rect = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Subagent "+N" badge → expand subagents globally
      const badgeParent = getSubagentBadgeAt(
        layout,
        transformRef.current,
        !visibility.subagent,
        nodeStyle,
        sx,
        sy,
      );
      if (badgeParent) {
        toggleVisibility("subagent");
        return;
      }
    }
    // Off-screen live arrow takes priority over pan when the user clicks on it.
    if (layout && liveTipId) {
      const rect = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const box = getOffscreenLiveArrowBox(layout, transformRef.current, liveTipId, size.w, size.h);
      if (box && sx >= box.x && sx <= box.x + box.w && sy >= box.y && sy <= box.y + box.h) {
        const tip = layout.nodes.get(liveTipId);
        if (tip) {
          const t = transformRef.current;
          transitionRef.current = {
            from: { ...t },
            to: { scale: t.scale, tx: size.w / 2 - tip.x * t.scale, ty: size.h / 2 - tip.y * t.scale },
            startMs: performance.now(),
            durationMs: 400,
          };
        }
        return;
      }
    }
    transitionRef.current = null;
    inertiaRef.current = null; // mousedown cancels any in-flight inertia
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTx: transformRef.current.tx,
      startTy: transformRef.current.ty,
      moved: false,
      samples: [{ x: e.clientX, y: e.clientY, ts: performance.now() }],
    };
  }, [layout, liveTipId, size.w, size.h, visibility.subagent, nodeStyle, toggleVisibility]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (drag) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > PAN_THRESHOLD_PX) drag.moved = true;
      if (drag.moved) {
        transformRef.current = {
          ...transformRef.current,
          tx: drag.startTx + dx,
          ty: drag.startTy + dy,
        };
        dirtyRef.current = true;
      }
      // Sample for inertia velocity. Keep only the most recent ~80ms of samples
      // so a brief pause before release doesn't poison the velocity calculation.
      const now = performance.now();
      drag.samples.push({ x: e.clientX, y: e.clientY, ts: now });
      while (drag.samples.length > 2 && now - drag.samples[0]!.ts > 80) drag.samples.shift();
    } else if (layout) {
      const hit = hitTest(layout, transformRef.current, e.clientX - rect.left, e.clientY - rect.top, nodeStyle);
      const next = hit ? { kind: hit.kind, id: hit.id } : null;
      const same = next && hovered && next.kind === hovered.kind && next.id === hovered.id;
      // Cursor coaching:
      //   shift+hover over node → copy   (shift+drag adds to a Space)
      //   ctrl/cmd+hover over node → cell (multi-select toggle)
      //   plain hover over node → pointer
      //   else → grab
      let cursor = "grab";
      if (hit) {
        if (e.shiftKey) cursor = "copy";
        else if (e.ctrlKey || e.metaKey) cursor = "cell";
        else cursor = "pointer";
      }
      e.currentTarget.style.cursor = cursor;
      if (!same) {
        setHovered(next);
        dirtyRef.current = true;
      }
    }
  }, [layout, hovered, nodeStyle]);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved) {
      // Compute average velocity over the sampled window. Skip inertia for
      // tiny motions (mouse barely moved) and for paused releases (samples
      // span a long time but no recent motion).
      const samples = drag.samples;
      if (samples.length >= 2) {
        const first = samples[0]!;
        const last = samples[samples.length - 1]!;
        const dt = last.ts - first.ts;
        if (dt > 0 && performance.now() - last.ts < 50) {
          const vx = (last.x - first.x) / dt; // px/ms
          const vy = (last.y - first.y) / dt;
          // Only kick inertia if release velocity > ~0.3 px/ms (= 300px/sec)
          if (Math.hypot(vx, vy) > 0.3) {
            inertiaRef.current = { vx, vy, startMs: performance.now(), lastMs: performance.now() };
            dirtyRef.current = true;
          }
        }
      }
      return;
    }
    if (!layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = hitTest(layout, transformRef.current, e.clientX - rect.left, e.clientY - rect.top, nodeStyle);
    if (!hit) return;
    if (hit.kind === "node") {
      // Ctrl/Cmd+click → toggle in multi-select set (doesn't disturb `selected`)
      if (e.ctrlKey || e.metaKey) {
        setMultiSelected((prev) => {
          const next = new Set(prev);
          if (next.has(hit.id)) next.delete(hit.id);
          else next.add(hit.id);
          return next;
        });
      } else {
        setSelected(hit.id);
      }
    } else {
      // session band click → zoom to that session
      const band = layout.sessionBands.find((b) => b.sessionId === hit.id);
      if (band) animateTo(fitToBounds(band, size.w, size.h, 80));
    }
    dirtyRef.current = true;
  }, [layout, size, nodeStyle]);

  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    // Google-Maps-style: double-click zooms in 2× at the cursor.
    // Use right-click → "Zoom to session" if you want the band-fit behavior.
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const t = transformRef.current;
    const newScale = Math.min(MAX_SCALE, t.scale * 2);
    if (newScale === t.scale) return;
    const lx = (sx - t.tx) / t.scale;
    const ly = (sy - t.ty) / t.scale;
    animateTo({ scale: newScale, tx: sx - lx * newScale, ty: sy - ly * newScale }, 250);
  }, []);

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = hitTest(layout, transformRef.current, sx, sy, nodeStyle);
    setContextMenu({
      x: sx,
      y: sy,
      target: hit ? { kind: hit.kind, id: hit.id } : { kind: "empty" },
    });
  }, [layout, nodeStyle]);

  // Dismiss context menu on any click outside it
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const id = window.setTimeout(() => {
      window.addEventListener("click", dismiss, { once: true });
    }, 0);
    return () => { window.clearTimeout(id); window.removeEventListener("click", dismiss); };
  }, [contextMenu]);

  // ───── Animation helper ─────
  function animateTo(to: Transform, durationMs = 350) {
    transitionRef.current = {
      from: { ...transformRef.current },
      to,
      startMs: performance.now(),
      durationMs,
    };
  }

  // Pan (preserving scale) to put a layout-coord point at the viewport center.
  const panToLayoutPoint = useCallback((lx: number, ly: number, durationMs = 350) => {
    const t = transformRef.current;
    animateTo(
      { scale: t.scale, tx: size.w / 2 - lx * t.scale, ty: size.h / 2 - ly * t.scale },
      durationMs,
    );
  }, [size.w, size.h]);

  // Step the search cursor by ±1 (with wrap-around) and pan to that match.
  // Successfully stepping a query also commits it to recent-searches so the
  // next time you open search empty, you can re-run prior queries with a click.
  const stepMatch = useCallback((dir: 1 | -1) => {
    if (matchList.length === 0 || !layout) return;
    pushRecentSearch(searchQuery);
    const next = ((matchIndex + dir) % matchList.length + matchList.length) % matchList.length;
    setMatchIndex(next);
    const id = matchList[next]!;
    const ln = layout.nodes.get(id);
    if (ln) {
      setSelected(id);
      const t = transformRef.current;
      const targetScale = Math.max(t.scale, 1.2);
      animateTo({ scale: targetScale, tx: size.w / 2 - ln.x * targetScale, ty: size.h / 2 - ln.y * targetScale }, 250);
    }
  }, [matchList, matchIndex, layout, size.w, size.h, searchQuery, pushRecentSearch]);

  // Follow-live: when the live tip changes (and follow is on), re-center on it.
  // Skips the animation if the tip is already on-screen with comfortable margin.
  useEffect(() => {
    if (!followLive || !liveTipId || !layout) return;
    const tip = layout.nodes.get(liveTipId);
    if (!tip) return;
    const t = transformRef.current;
    const sx = tip.x * t.scale + t.tx;
    const sy = tip.y * t.scale + t.ty;
    const margin = 80;
    if (sx >= margin && sx <= size.w - margin && sy >= margin && sy <= size.h - margin) return;
    panToLayoutPoint(tip.x, tip.y, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followLive, liveTipId, layout, size.w, size.h]);

  // ───── Wheel + pinch ─────
  // Bind on the CANVAS ELEMENT (not document/window). Chromium silently forces
  // document/window wheel listeners to be passive, so preventDefault() is ignored
  // there. Canvas-element listener with explicit passive:false works.
  // (tldraw, Excalidraw, react-flow all do this.)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      transitionRef.current = null;
      inertiaRef.current = null; // wheel cancels inertia
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const t = transformRef.current;

      // Decide zoom vs pan based on inputMode + modifier keys.
      // Trackpad pinch sets ctrlKey automatically in Chromium/Edge/Firefox — so
      // checking ctrlKey covers both real Ctrl+wheel AND trackpad pinch.
      let zoom: boolean;
      if (e.ctrlKey || e.metaKey || e.altKey) {
        zoom = true;
      } else if (inputMode === "mouse") {
        zoom = true; // plain wheel always zooms
      } else if (inputMode === "trackpad") {
        zoom = false; // plain wheel always pans; ctrl+wheel still zooms above
      } else {
        // auto: magnitude heuristic
        zoom = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 25);
      }

      if (zoom) {
        // tldraw-style: clamp |deltaY| to MAX_ZOOM_STEP=10 then exp(−d/100)
        const MAX_STEP = 10;
        const dy = Math.abs(e.deltaY) > MAX_STEP ? MAX_STEP * Math.sign(e.deltaY) : e.deltaY;
        const factor = Math.exp(-dy / 100);
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.scale * factor));
        if (newScale === t.scale) return;
        const lx = (sx - t.tx) / t.scale;
        const ly = (sy - t.ty) / t.scale;
        transformRef.current = {
          scale: newScale,
          tx: sx - lx * newScale,
          ty: sy - ly * newScale,
        };
      } else {
        transformRef.current = {
          scale: t.scale,
          tx: t.tx - e.deltaX,
          ty: t.ty - e.deltaY,
        };
      }
      dirtyRef.current = true;
    };

    let gestureStartScale = 1;
    const onGestureStart = (e: Event) => {
      if (e.target !== canvas) return;
      e.preventDefault();
      gestureStartScale = transformRef.current.scale;
    };
    const onGestureChange = (e: Event) => {
      if (e.target !== canvas) return;
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      const rect = canvas.getBoundingClientRect();
      const sx = ge.clientX - rect.left;
      const sy = ge.clientY - rect.top;
      const t = transformRef.current;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, gestureStartScale * ge.scale));
      const lx = (sx - t.tx) / t.scale;
      const ly = (sy - t.ty) / t.scale;
      transformRef.current = {
        scale: newScale,
        tx: sx - lx * newScale,
        ty: sy - ly * newScale,
      };
      dirtyRef.current = true;
    };
    const onGestureEnd = (e: Event) => {
      if (e.target !== canvas) return;
      e.preventDefault();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Safari pinch uses gestureevents at the canvas level too
    canvas.addEventListener("gesturestart", onGestureStart, { passive: false });
    canvas.addEventListener("gesturechange", onGestureChange, { passive: false });
    canvas.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      canvas.removeEventListener("gestureend", onGestureEnd);
    };
    // canvasReady triggers re-run when the canvas DOM node finally appears
    // (the early-loading branch renders no canvas, so first mount sees null).
  }, [inputMode, canvasReady]);

  // ───── Fetch selected node detail ─────
  useEffect(() => {
    if (!selected || !forest) {
      setSelectedDetail(null);
      return;
    }
    const node = forest.nodes.find((n) => n.id === selected);
    if (!node) return;
    let cancelled = false;
    api.node(node.sessionId, node.id).then((r) => {
      if (!cancelled) setSelectedDetail(r);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected, forest]);

  // Push selection changes into the back/forward history. Skips the push when
  // navigatingHistoryRef is true so alt+left/right doesn't recursively re-push.
  // Capped at 50 entries to bound memory.
  useEffect(() => {
    if (selected == null) return;
    if (navigatingHistoryRef.current) { navigatingHistoryRef.current = false; return; }
    const h = selectionHistoryRef.current;
    if (h.entries[h.cursor] === selected) return; // no-op selection of same
    h.entries = h.entries.slice(0, h.cursor + 1);
    h.entries.push(selected);
    if (h.entries.length > 50) h.entries = h.entries.slice(-50);
    h.cursor = h.entries.length - 1;
  }, [selected]);

  // Spotlight ping on every new selection — renderer reads this from state.
  useEffect(() => {
    if (selected == null) { selectionPingMsRef.current = null; return; }
    selectionPingMsRef.current = performance.now();
    dirtyRef.current = true;
  }, [selected]);

  const navigateHistory = useCallback((dir: -1 | 1) => {
    const h = selectionHistoryRef.current;
    const next = h.cursor + dir;
    if (next < 0 || next >= h.entries.length) return;
    h.cursor = next;
    const id = h.entries[next]!;
    navigatingHistoryRef.current = true;
    setSelected(id);
    const ln = layout?.nodes.get(id);
    if (ln) {
      const t = transformRef.current;
      animateTo({ scale: t.scale, tx: size.w / 2 - ln.x * t.scale, ty: size.h / 2 - ln.y * t.scale }, 250);
    }
  }, [layout, size.w, size.h]);

  // Gmail-style chord state: when `g` is pressed, the next key within 1.5s is interpreted as a chord
  const chordRef = useRef<{ pending: boolean; timer: number | null }>({ pending: false, timer: null });

  // ───── Keyboard ─────
  useEffect(() => {
    // Find the visible nodes in a session, sorted by timestamp.
    const visibleInSession = (sid: string) =>
      (forest?.nodes ?? [])
        .filter((n) => n.sessionId === sid && layout?.nodes.has(n.id))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const panToNode = (id: string) => {
      const ln = layout?.nodes.get(id);
      if (!ln) return;
      const t = transformRef.current;
      animateTo({
        scale: t.scale,
        tx: size.w / 2 - ln.x * t.scale,
        ty: size.h / 2 - ln.y * t.scale,
      }, 200);
    };

    const navigateBy = (dir: 1 | -1) => {
      // Cycle through visible nodes in the selected node's session (or the live session).
      let sid: string | null = null;
      if (selected) {
        sid = forest?.nodes.find((n) => n.id === selected)?.sessionId ?? null;
      }
      if (!sid) sid = effectiveActiveSession;
      if (!sid) return;
      const list = visibleInSession(sid);
      if (list.length === 0) return;
      let idx = selected ? list.findIndex((n) => n.id === selected) : -1;
      // Start at the live tip if nothing selected
      if (idx < 0) idx = dir > 0 ? -1 : list.length;
      const next = list[Math.max(0, Math.min(list.length - 1, idx + dir))];
      if (next) {
        setSelected(next.id);
        panToNode(next.id);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K opens the command palette from anywhere (even inside inputs)
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
          (document.activeElement as HTMLElement).blur();
        }
        setPaletteOpen((v) => !v);
        return;
      }
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        if (e.key === "Escape") (document.activeElement as HTMLElement).blur();
        return;
      }
      // A modal is open: it owns the keyboard (Esc/Tab handled by useDialog).
      // Bail so map shortcuts (f, 0, 1, …) don't fire behind the overlay.
      if (welcomeOpen || helpOpen || spawnModal || textPrompt || confirmDialog) {
        if (helpOpen && e.key === "?") setHelpOpen(false); // keep ?-toggles-help
        return;
      }
      // Alt+left/right = browser-style selection history (back/forward).
      // Takes priority over the plain arrow-key navigation so the modifier
      // version doesn't fall through to "cycle within session."
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        navigateHistory(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      // Arrow keys: cycle through visible nodes in the active session (or selected's session)
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        navigateBy(1);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        navigateBy(-1);
        return;
      }
      // Gmail-style `g` chord: g then v/m/b/s/f
      if (chordRef.current.pending) {
        chordRef.current.pending = false;
        if (chordRef.current.timer) {
          window.clearTimeout(chordRef.current.timer);
          chordRef.current.timer = null;
        }
        e.preventDefault();
        switch (e.key) {
          case "v": onClose(); return; // back to viewer
          case "m": return; // already in map; no-op
          case "b": {
            const first = [...bookmarks][0];
            if (first && layout) {
              setSelected(first);
              const ln = layout.nodes.get(first);
              if (ln) {
                const t = transformRef.current;
                const sc = Math.max(t.scale, 1.5);
                animateTo({ scale: sc, tx: size.w / 2 - ln.x * sc, ty: size.h / 2 - ln.y * sc }, 250);
              }
            }
            return;
          }
          case "s":
          case "/":
            setSearchOpen(true);
            return;
          case "h":
          case "f":
            if (layout) animateTo(fitTransform(layout, size.w, size.h));
            return;
          case "l": {
            // jump to live tip — same as spacebar
            if (liveTipId && layout) {
              const ln = layout.nodes.get(liveTipId);
              if (ln) {
                const t = transformRef.current;
                const sc = Math.max(t.scale, 1.5);
                animateTo({ scale: sc, tx: size.w / 2 - ln.x * sc, ty: size.h / 2 - ln.y * sc }, 250);
                setSelected(liveTipId);
              }
            }
            return;
          }
          default:
            return;
        }
      }
      if (e.key === "g") {
        e.preventDefault();
        chordRef.current.pending = true;
        if (chordRef.current.timer) window.clearTimeout(chordRef.current.timer);
        chordRef.current.timer = window.setTimeout(() => {
          chordRef.current.pending = false;
          chordRef.current.timer = null;
        }, 1500);
        return;
      }
      // b: toggle bookmark on the selected node
      if (e.key === "b" && selected) {
        e.preventDefault();
        toggleBookmark(selected);
        return;
      }
      // Spacebar: jump to live tip (the latest message in the live session)
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (!layout || !effectiveActiveSession) return;
        // If active session is in a different project, switch scope; otherwise pan+zoom to live tip
        const activeProj = forest?.nodes.find((n) => n.sessionId === effectiveActiveSession)?.projectSlug;
        if (mode === "per-project" && activeProj && activeProj !== scopeProject) {
          setScopeProject(activeProj);
          return;
        }
        if (liveTipId) {
          const ln = layout.nodes.get(liveTipId);
          if (ln) {
            const targetScale = Math.max(transformRef.current.scale, 1.5);
            animateTo({
              scale: targetScale,
              tx: size.w / 2 - ln.x * targetScale,
              ty: size.h / 2 - ln.y * targetScale,
            }, 300);
            setSelected(liveTipId);
            return;
          }
        }
        // Fallback to fitting the session band
        const band = layout.sessionBands.find((b) => b.sessionId === effectiveActiveSession);
        if (band) animateTo(fitToBounds(band, size.w, size.h, 80));
        return;
      }
      switch (e.key) {
        case "f":
        case "0":
          if (!layout) return;
          animateTo(fitTransform(layout, size.w, size.h));
          break;
        case "1":
          if (!layout || !forest) return;
          const recent = mostRecentSessionBand(layout, forest);
          if (recent) animateTo(fitToBounds(recent, size.w, size.h, 80));
          break;
        case "=":
        case "+":
          animateTo({ ...transformRef.current, scale: Math.min(MAX_SCALE, transformRef.current.scale * 1.5) }, 200);
          break;
        case "-":
        case "_":
          animateTo({ ...transformRef.current, scale: Math.max(MIN_SCALE, transformRef.current.scale / 1.5) }, 200);
          break;
        case "/":
          e.preventDefault();
          setSearchOpen(true);
          break;
        case "?":
          setHelpOpen((v) => !v);
          break;
        case "Escape":
          if (helpOpen) setHelpOpen(false);
          else if (searchOpen) { setSearchOpen(false); setSearchQuery(""); }
          else if (multiSelected.size > 0) setMultiSelected(new Set());
          else if (selected) setSelected(null);
          else onClose();
          break;
      }
    };
    // WASD smooth pan: track held keys; RAF loop reads + advances camera.
    // Ignored when typing in an input/textarea. Shift = faster pan.
    const isTyping = () => {
      const tag = document.activeElement?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA";
    };
    const onWasdDown = (e: KeyboardEvent) => {
      if (isTyping()) return;
      const k = e.key.toLowerCase();
      if (k === "w" || k === "a" || k === "s" || k === "d") {
        if (e.ctrlKey || e.metaKey || e.altKey) return; // don't fight chord shortcuts
        e.preventDefault();
        wasdKeysRef.current.add(k);
        wasdShiftRef.current = e.shiftKey;
        dirtyRef.current = true;
      } else if (e.key === "Shift") {
        wasdShiftRef.current = true;
      }
    };
    const onWasdUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w" || k === "a" || k === "s" || k === "d") {
        wasdKeysRef.current.delete(k);
      } else if (e.key === "Shift") {
        wasdShiftRef.current = false;
      }
    };
    // Clear keys on blur / visibility change so a held key never gets stuck
    // (e.g., user Alt+Tabs away mid-press).
    const onBlur = () => { wasdKeysRef.current.clear(); wasdShiftRef.current = false; };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onWasdDown);
    window.addEventListener("keyup", onWasdUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onWasdDown);
      window.removeEventListener("keyup", onWasdUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    };
  }, [layout, size, forest, selected, helpOpen, searchOpen, onClose, effectiveActiveSession, liveTipId, mode, scopeProject, toggleBookmark, multiSelected, navigateHistory, welcomeOpen, spawnModal, textPrompt, confirmDialog]);

  // ───── Tooltip data ─────
  // Enriched in timeline mode with gap-from-prev; assistant nodes include
  // their output-token cost so heat-map values are interpretable on hover.
  const tooltipData = useMemo(() => {
    if (!hovered || !forest) return null;
    if (hovered.kind === "node") {
      const n = forest.nodes.find((x) => x.id === hovered.id);
      if (!n) return null;
      const gapMs = layout?.nodeGapToPrev?.get(n.id);
      const metaParts: string[] = [
        new Date(n.timestamp).toLocaleString(),
        n.sessionId.slice(0, 8),
      ];
      if (n.role === "assistant" && n.outputTokens > 0) {
        metaParts.push(`${n.outputTokens.toLocaleString()} out`);
      }
      if (gapMs && gapMs >= 60_000) {
        metaParts.push(`+${humanGap(gapMs)} since prev`);
      }
      return {
        kind: "node" as const,
        title: n.role === "assistant"
          ? (n.subtype === "tool-only" ? "assistant · tool call" : n.subtype === "thinking" ? "assistant · thinking" : "assistant")
          : (n.subtype ?? "user"),
        body: n.preview || "(empty)",
        meta: metaParts.join(" · "),
        color: n.isSidechain ? "#c084fc" : n.role === "assistant" ? "#fbbf24" : n.subtype === "prompt" ? "#34d399" : "#71717a",
        isSidechain: n.isSidechain,
      };
    } else {
      const band = layout?.sessionBands.find((b) => b.sessionId === hovered.id);
      if (!band) return null;
      const sess = forest.nodes.find((x) => x.sessionId === hovered.id);
      const titleInfo = forest.sessionTitles?.[band.sessionId];
      const totalTokens = titleInfo
        ? titleInfo.tokens.input + titleInfo.tokens.output
        : 0;
      const metaParts = [
        band.sessionId.slice(0, 8),
        `${band.nodeCount} nodes`,
      ];
      if (totalTokens > 0) metaParts.push(`${formatTokens(totalTokens)} tok`);
      return {
        kind: "session" as const,
        title: prettySlug(band.projectSlug),
        body: titleInfo?.aiTitle || band.firstPrompt || "(no user prompt yet)",
        meta: metaParts.join(" · "),
        color: projectColor(band.projectSlug),
        sess,
        isSidechain: false,
      };
    }
  }, [hovered, forest, layout]);

  // Mark the welcome modal as seen + close it (shared by Esc / backdrop / button).
  const closeWelcome = useCallback(() => {
    setWelcomeOpen(false);
    try { localStorage.setItem("cc-map-seen-welcome", "1"); } catch {}
  }, []);
  // Focus management + Esc handling for the inline modals (Welcome/Help/Spawn).
  const welcomeDialogRef = useDialog(welcomeOpen, closeWelcome);
  const helpDialogRef = useDialog(helpOpen, () => setHelpOpen(false));
  const spawnDialogRef = useDialog(!!spawnModal, () => setSpawnModal(null));

  if (error) {
    return <div className="flex-1 flex items-center justify-center text-red-400">{error}</div>;
  }
  if (!forest) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="flex-1 flex overflow-hidden relative">
      {/* Sidebar */}
      <div data-tour-id="sidebar" className="w-56 border-r border-zinc-800 bg-zinc-950 p-3 text-sm overflow-y-auto shrink-0">
        {/* Collapse-all / expand-all — compact the sidebar to maximize canvas */}
        <div className="flex justify-end pb-1 -mt-1">
          <button
            onClick={() => setAllGroupsOpen(false)}
            className="text-zinc-500 hover:text-zinc-200 text-[10px] px-1.5 py-0.5 rounded hover:bg-zinc-900"
            title="Collapse all sidebar groups"
          >
            collapse all
          </button>
          <button
            onClick={() => setAllGroupsOpen(true)}
            className="text-zinc-500 hover:text-zinc-200 text-[10px] px-1.5 py-0.5 rounded hover:bg-zinc-900 ml-1"
            title="Expand all sidebar groups"
          >
            expand all
          </button>
        </div>
        <div key={sidebarKey}>
        <SidebarGroup
          id="scope"
          title="Scope"
          summary={
            (activeSpace ? activeSpace.name : null) ??
            (mode === "per-project" && scopeProject ? prettySlug(scopeProject) : null) ??
            "all projects"
          }
        >
        <div>
          <div className="text-zinc-500 text-xs mb-1">View</div>
          <div className="flex gap-1">
            <button
              className={`px-2 py-1 rounded text-xs ${mode === "per-project" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
              onClick={() => setMode("per-project")}
            >
              per-project
            </button>
            <button
              className={`px-2 py-1 rounded text-xs ${mode === "all-projects" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
              onClick={() => setMode("all-projects")}
            >
              all
            </button>
          </div>
        </div>
        {mode === "per-project" && (() => {
          const sorted = [...forest.projects].sort((a, b) => b.sessionCount - a.sessionCount);
          const maxCount = sorted.length > 0 ? sorted[0]!.sessionCount : 0;
          return (
            <div>
              <div className="text-zinc-500 text-xs mb-1">Project ({forest.projects.length})</div>
              <div className="space-y-0.5 max-h-[40vh] overflow-y-auto">
                {sorted.map((p) => {
                  const ratio = maxCount > 0 ? p.sessionCount / maxCount : 0;
                  const isActive = scopeProject === p.slug;
                  return (
                    <button
                      key={p.slug}
                      onClick={() => setScopeProject(p.slug)}
                      className={`relative w-full text-left px-2 py-1 rounded text-xs truncate flex items-center gap-2 overflow-hidden ${isActive ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800"}`}
                      title={`${p.slug} · ${p.sessionCount} sessions`}
                    >
                      <span
                        className="absolute left-0 top-0 bottom-0 pointer-events-none"
                        style={{
                          width: `${Math.max(2, ratio * 100)}%`,
                          background: projectColor(p.slug),
                          opacity: isActive ? 0.25 : 0.15,
                        }}
                      />
                      <span className="relative inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: projectColor(p.slug) }} />
                      <span className="relative truncate flex-1">{prettySlug(p.slug)}</span>
                      <span className="relative text-zinc-600 shrink-0 tabular-nums">{p.sessionCount}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
        {/* Spaces (moved from below Input so it sits in the Scope group) */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-zinc-500 text-xs">Spaces</span>
            <button
              onClick={() => {
                setTextPrompt({
                  title: "New space",
                  label: "Name",
                  initial: "Untitled",
                  confirmLabel: "Create",
                  onSubmit: (raw) => {
                    const name = raw.trim();
                    if (!name) return;
                    const sp: Space = {
                      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `s_${Date.now()}`,
                      name,
                      hue: Math.floor(Math.random() * 360),
                      sessionIds: [],
                      note: "",
                      createdAt: new Date().toISOString(),
                    };
                    upsertSpace(sp);
                    setActiveSpaceId(sp.id);
                  },
                });
              }}
              className="text-zinc-400 hover:text-zinc-200 text-xs"
              title="new space"
            >
              + new
            </button>
          </div>
          <div className="space-y-0.5">
            <button
              onClick={() => setActiveSpaceId(null)}
              className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-2 ${activeSpaceId === null ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-900"}`}
            >
              <span className="inline-block w-2 h-2 rounded-sm shrink-0 bg-zinc-500" />
              <span className="truncate flex-1">All sessions</span>
              <span className="text-zinc-600 shrink-0">{forest.sessionCount}</span>
            </button>
            {spaces.map((sp) => (
              <div key={sp.id} className="group flex items-center gap-1">
                <button
                  data-space-id={sp.id}
                  onClick={() => setActiveSpaceId(sp.id)}
                  className={`flex-1 text-left px-2 py-1 rounded text-xs flex items-center gap-2 ${activeSpaceId === sp.id ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-900"} ${dragSession && dragOverSpaceId === sp.id ? "ring-2 ring-emerald-400 bg-emerald-900/40" : ""}`}
                  title={dragSession ? `Drop to add session to "${sp.name}"` : sp.note || sp.name}
                >
                  <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: `hsl(${sp.hue}, 60%, 55%)` }} />
                  <span className="truncate flex-1">{sp.name}</span>
                  <span className="text-zinc-600 shrink-0">{sp.sessionIds.length}</span>
                </button>
                <button
                  onClick={() => {
                    setTextPrompt({
                      title: "Rename space",
                      label: "Name",
                      initial: sp.name,
                      confirmLabel: "Rename",
                      onSubmit: (raw) => {
                        const name = raw.trim();
                        if (name) upsertSpace({ ...sp, name });
                      },
                    });
                  }}
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 text-xs px-0.5"
                  title="rename"
                  aria-label={`Rename space ${sp.name}`}
                >
                  ✎
                </button>
                <button
                  onClick={() => {
                    setConfirmDialog({
                      title: "Delete space",
                      message: `Delete space "${sp.name}"? Member sessions stay — only the grouping is removed.`,
                      confirmLabel: "Delete",
                      danger: true,
                      onConfirm: () => deleteSpace(sp.id),
                    });
                  }}
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 text-xs px-0.5"
                  title="delete"
                  aria-label={`Delete space ${sp.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
        </SidebarGroup>

        <SidebarGroup
          id="display"
          title="Display"
          summary={`${direction} · ${nodeStyle} · ${colorMode}`}
        >
        <div>
          <div className="text-zinc-500 text-xs mb-1">Layout</div>
          <div className="flex gap-1">
            {(["grid", "column", "timeline"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDirection(d)}
                className={`px-2 py-1 rounded text-xs flex-1 ${direction === d ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
                title={
                  d === "grid" ? "trees wrap into rows (square-ish)" :
                  d === "column" ? "each session on its own row, prompts vertical, replies horizontal" :
                  "one column per session; Y is real time — reveals burst sessions and idle gaps"
                }
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-zinc-500 text-xs mb-1">Nodes</div>
          <div className="flex gap-1">
            {(["dots", "cards"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setNodeStyle(s)}
                className={`px-2 py-1 rounded text-xs flex-1 ${nodeStyle === s ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
                title={s === "dots" ? "small dots — fast, good for overview" : "text cards — preview content in-place, layout is much larger"}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-zinc-500 text-xs mb-1">Color by</div>
          <div className="flex gap-1">
            {(["role", "recency", "cost"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setColorMode(m)}
                className={`px-2 py-1 rounded text-xs flex-1 ${colorMode === m ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
                title={
                  m === "role" ? "user/assistant/subagent colors" :
                  m === "recency" ? "heat map: old → recent (gray → emerald)" :
                  "heat map: assistant output tokens (gray → red)"
                }
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-zinc-500 text-xs mb-1">Background</div>
          <div className="flex gap-1">
            {(["none", "grid", "dots"] as const).map((b) => (
              <button
                key={b}
                onClick={() => setBackgroundStyle(b)}
                className={`px-2 py-1 rounded text-xs flex-1 ${backgroundStyle === b ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
                title={
                  b === "none" ? "flat black canvas" :
                  b === "grid" ? "faint grid (helps feel pan/zoom in empty areas)" :
                  "faint dot field"
                }
              >
                {b}
              </button>
            ))}
          </div>
        </div>
        </SidebarGroup>

        <SidebarGroup
          id="live"
          title="Live"
          summary={`follow ${followLive ? "on" : "off"} · ${inputMode}`}
        >
        <div className="space-y-1">
          <div className="text-zinc-500 text-xs mb-1">Follow live</div>
          <button
            onClick={() => setFollowLive((v) => !v)}
            className={`w-full px-2 py-1 rounded text-xs flex items-center justify-between gap-2 ${followLive ? "bg-emerald-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
            title="When on, the map auto-pans to keep the latest live message in view"
          >
            <span className="flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${followLive ? "bg-emerald-300 animate-pulse" : "bg-zinc-600"}`} />
              follow live
            </span>
            <span className="text-[10px] opacity-75">{followLive ? "ON" : "OFF"}</span>
          </button>
          {direction === "timeline" && layout?.timelineAnchors && effectiveActiveSession && layout.timelineAnchors.has(effectiveActiveSession) && (
            <button
              onClick={() => {
                const anchor = layout.timelineAnchors!.get(effectiveActiveSession!);
                if (!anchor) return;
                const nowY = timelineNowY(anchor, Date.now());
                const cx = (anchor.x + anchor.xRight) / 2;
                panToLayoutPoint(cx, nowY, 350);
              }}
              className="w-full px-2 py-1 rounded text-xs bg-zinc-900 text-zinc-400 hover:bg-zinc-800 flex items-center justify-between"
              title="Pan to the 'right now' line in the active session column"
            >
              <span>today / now</span>
              <span className="text-[10px] opacity-75">→</span>
            </button>
          )}
        </div>
        <div>
          <div className="text-zinc-500 text-xs mb-1">Input</div>
          <div className="flex gap-1">
            {(["auto", "mouse", "trackpad"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setInputMode(m)}
                className={`px-2 py-1 rounded text-xs flex-1 ${inputMode === m ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
                title={
                  m === "mouse" ? "plain wheel = zoom" :
                  m === "trackpad" ? "plain wheel = pan; ctrl/pinch = zoom" :
                  "auto-detect by event magnitude"
                }
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        </SidebarGroup>

        <SidebarGroup
          id="filter"
          title="Filter"
          summary={(() => {
            const parts: string[] = [];
            if (filter.startDate || filter.endDate) parts.push(`date`);
            if (filter.requiredTools.length > 0) parts.push(`${filter.requiredTools.length} tool${filter.requiredTools.length === 1 ? "" : "s"}`);
            if (filter.bookmarkedOnly) parts.push("★");
            const visChanged = JSON.stringify(visibility) !== JSON.stringify(DEFAULT_VISIBILITY);
            if (visChanged) parts.push("show*");
            return parts.length === 0 ? "none" : parts.join(" · ");
          })()}
        >
        <div className="space-y-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-zinc-500 text-xs">Sessions</span>
            {(filter.startDate || filter.endDate || filter.requiredTools.length > 0 || filter.bookmarkedOnly) && (
              <button
                onClick={() => updateFilter({ startDate: null, endDate: null, requiredTools: [], bookmarkedOnly: false })}
                className="text-zinc-500 hover:text-zinc-200 text-[10px] underline"
                title="clear all filters"
              >
                clear
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-zinc-400">
            <label className="text-zinc-500 w-8 shrink-0">from</label>
            <input
              type="date"
              value={filter.startDate ?? ""}
              onChange={(e) => updateFilter({ startDate: e.target.value || null })}
              className="bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-zinc-200 text-[10px] flex-1 min-w-0"
            />
          </div>
          <div className="flex items-center gap-1 text-[10px] text-zinc-400">
            <label className="text-zinc-500 w-8 shrink-0">to</label>
            <input
              type="date"
              value={filter.endDate ?? ""}
              onChange={(e) => updateFilter({ endDate: e.target.value || null })}
              className="bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-zinc-200 text-[10px] flex-1 min-w-0"
            />
          </div>
          <label className="flex items-center gap-2 px-1 py-1 rounded cursor-pointer hover:bg-zinc-900 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={filter.bookmarkedOnly}
              onChange={(e) => updateFilter({ bookmarkedOnly: e.target.checked })}
              className="w-3 h-3 accent-zinc-400"
            />
            <span>★ bookmarked only</span>
          </label>
          {availableTools.length > 0 && (
            <div>
              <div className="text-zinc-500 text-[10px] mt-1 mb-1">tools used (any)</div>
              <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                {availableTools.map((t) => {
                  const on = filter.requiredTools.includes(t);
                  return (
                    <button
                      key={t}
                      onClick={() => updateFilter({
                        requiredTools: on
                          ? filter.requiredTools.filter((x) => x !== t)
                          : [...filter.requiredTools, t],
                      })}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${on ? "bg-emerald-700 text-emerald-100" : "bg-zinc-900 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {allowedSessions && (
            <div className="text-[10px] text-zinc-500 pt-1">
              matched: {allowedSessions.size} / {forest.sessionCount} sessions
            </div>
          )}
        </div>
        <div>
          <div className="text-zinc-500 text-xs mb-1">Show</div>
          <VisToggle label="Prompts"        color="#34d399" on={visibility.prompt}        onChange={() => toggleVisibility("prompt")} />
          <VisToggle label="Replies (text)" color="#fbbf24" on={visibility.assistantText} onChange={() => toggleVisibility("assistantText")} />
          <VisToggle label="Replies (tool calls)" color="#92400e" on={visibility.assistantToolOnly} onChange={() => toggleVisibility("assistantToolOnly")} />
          <VisToggle label="Replies (thinking)" color="#6366f1" on={visibility.assistantThinking} onChange={() => toggleVisibility("assistantThinking")} />
          <VisToggle label="Subagents"      color="#c084fc" on={visibility.subagent}      onChange={() => toggleVisibility("subagent")} />
          <VisToggle label="Tool results"   color="#52525b" on={visibility.toolResult}    onChange={() => toggleVisibility("toolResult")} />
          <VisToggle label="Slash commands" color="#71717a" on={visibility.slashCommand}  onChange={() => toggleVisibility("slashCommand")} />
          <VisToggle label="System reminders" color="#3f3f46" on={visibility.systemReminder} onChange={() => toggleVisibility("systemReminder")} />
        </div>
        {(filter.startDate || filter.endDate || filter.requiredTools.length > 0 || filter.bookmarkedOnly ||
          JSON.stringify(visibility) !== JSON.stringify(DEFAULT_VISIBILITY)) && (
          <button
            onClick={() => {
              updateFilter({ startDate: null, endDate: null, requiredTools: [], bookmarkedOnly: false });
              setVisibility(DEFAULT_VISIBILITY);
              try {
                localStorage.setItem("cc-map-visibility", JSON.stringify(DEFAULT_VISIBILITY));
              } catch {}
            }}
            className="w-full text-left text-xs text-zinc-400 hover:text-zinc-100 underline"
            title="reset all visibility + filter settings"
          >
            ↺ reset filters & visibility
          </button>
        )}
        </SidebarGroup>

        {effectiveActiveSession && (
          <SidebarGroup id="live-card" title="Live session">
            {(() => {
              const liveBand = layout?.sessionBands.find((b) => b.sessionId === effectiveActiveSession);
              const liveProj = forest.nodes.find((n) => n.sessionId === effectiveActiveSession)?.projectSlug ?? "";
              const liveTitle = forest.sessionTitles?.[effectiveActiveSession]?.aiTitle;
              const latestNode = liveTipId ? forest.nodes.find((n) => n.id === liveTipId) : null;
              return (
                <button
                  className="flex flex-col items-start gap-1 w-full text-left p-2 rounded hover:bg-zinc-900 border border-emerald-900/40"
                  onClick={() => {
                    if (!layout) return;
                    if (mode === "per-project" && liveProj && liveProj !== scopeProject) {
                      setScopeProject(liveProj);
                    } else if (liveBand) {
                      animateTo(fitToBounds(liveBand, size.w, size.h, 80));
                    }
                  }}
                  title={`session ${effectiveActiveSession}\n${liveProj}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                    <span className="text-emerald-400 font-mono text-[10px]">live</span>
                  </div>
                  {liveTitle ? (
                    <div className="text-zinc-200 text-xs leading-tight line-clamp-2 w-full">{liveTitle}</div>
                  ) : (
                    <div className="text-zinc-300 text-xs font-mono">{effectiveActiveSession.slice(0, 8)}</div>
                  )}
                  <div className="text-zinc-500 text-[10px] truncate w-full" title={liveProj}>{prettySlug(liveProj)}</div>
                  {latestNode && (
                    <div className="text-zinc-400 text-[10px] line-clamp-2 leading-tight w-full pt-1 border-t border-zinc-800/60 mt-1">
                      <span className={latestNode.role === "assistant" ? "text-amber-400" : "text-emerald-400"}>
                        {latestNode.role === "assistant" ? "→ " : "← "}
                      </span>
                      {latestNode.preview || "(no preview)"}
                    </div>
                  )}
                </button>
              );
            })()}
          </SidebarGroup>
        )}

        <SidebarGroup
          id="saved"
          title="Saved"
          defaultOpen={false}
          count={savedViews.length + bookmarks.size}
          summary={`${savedViews.length} view${savedViews.length === 1 ? "" : "s"} · ${bookmarks.size} ★`}
        >
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-zinc-500 text-xs">Views ({savedViews.length})</span>
              <button
                onClick={() => {
                  setTextPrompt({
                    title: "Save view",
                    label: "Name",
                    initial: "",
                    placeholder: "e.g. cost heatmap",
                    confirmLabel: "Save",
                    onSubmit: (raw) => {
                      const name = raw.trim();
                      if (!name) return;
                      const view: SavedView = {
                        id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `v_${Date.now()}`,
                        name,
                        mode,
                        scopeProject,
                        filter,
                        visibility,
                        nodeStyle,
                        direction,
                        colorMode,
                      };
                      persistViews([...savedViews, view]);
                    },
                  });
                }}
                className="text-zinc-400 hover:text-zinc-200 text-xs px-1.5 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800"
                title="Save the current map state (filters, scope, layout, colors) as a named view"
              >
                + save
              </button>
            </div>
            {savedViews.length === 0 ? (
              <div className="text-zinc-600 text-[10px] italic">no saved views</div>
            ) : (
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {savedViews.map((v) => (
                  <div key={v.id} className="flex items-center gap-1 group">
                    <button
                      onClick={() => {
                        setMode(v.mode);
                        setScopeProject(v.scopeProject);
                        setFilter(v.filter);
                        setVisibility(v.visibility);
                        setNodeStyle(v.nodeStyle);
                        setDirection(v.direction);
                        setColorMode(v.colorMode);
                      }}
                      className="flex-1 text-left px-2 py-0.5 rounded hover:bg-zinc-800 text-zinc-300 text-xs truncate"
                      title={`${v.mode} · ${v.scopeProject ?? "all projects"} · ${v.nodeStyle} · ${v.direction} · ${v.colorMode}`}
                    >
                      {v.name}
                    </button>
                    <button
                      onClick={() => {
                        setConfirmDialog({
                          title: "Delete view",
                          message: `Delete view "${v.name}"?`,
                          confirmLabel: "Delete",
                          danger: true,
                          onConfirm: () => persistViews(savedViews.filter((x) => x.id !== v.id)),
                        });
                      }}
                      className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs px-1"
                      title="Delete view"
                      aria-label={`Delete view ${v.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {bookmarks.size > 0 && (
            <div>
              <div className="text-zinc-500 text-xs mb-1">★ Bookmarks ({bookmarks.size})</div>
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {[...bookmarks].map((bid) => {
                  const n = forest.nodes.find((x) => x.id === bid);
                  if (!n) return null;
                  return (
                    <div key={bid} className="group flex items-center gap-1">
                      <button
                        className="flex-1 text-left px-1 py-0.5 rounded hover:bg-zinc-900 text-zinc-400 text-[10px] flex items-center gap-1 min-w-0"
                        onClick={() => {
                          setSelected(bid);
                          const ln = layout?.nodes.get(bid);
                          if (ln) {
                            const t = transformRef.current;
                            const sc = Math.max(t.scale, 1.5);
                            animateTo({ scale: sc, tx: size.w / 2 - ln.x * sc, ty: size.h / 2 - ln.y * sc }, 250);
                          }
                        }}
                        title={n.preview}
                      >
                        <span className="text-amber-400 shrink-0">★</span>
                        <span className="truncate">{n.preview || bid.slice(0, 8)}</span>
                      </button>
                      <button
                        onClick={() => toggleBookmark(bid)}
                        className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-[10px] px-1 shrink-0"
                        title="Remove bookmark"
                        aria-label="Remove bookmark"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </SidebarGroup>

        <SidebarGroup
          id="activity"
          title="Activity"
          summary={`${forest.sessionCount} sessions`}
        >
          <div>
            <div className="text-zinc-500 text-xs mb-1.5">Recent activity</div>
            <DailyActivityHeatmap forest={forest} filter={filter} onPickDate={(iso) => updateFilter({ startDate: iso, endDate: iso })} />
          </div>
          <div className="text-xs text-zinc-500 space-y-1 pt-1">
            {(() => {
              const total = forest.projects.reduce((acc, p) => ({
                input: acc.input + (p.tokens?.input ?? 0),
                output: acc.output + (p.tokens?.output ?? 0),
                cacheRead: acc.cacheRead + (p.tokens?.cacheRead ?? 0),
              }), { input: 0, output: 0, cacheRead: 0 });
              const total_b = (total.input + total.output + total.cacheRead) / 1e6;
              return total_b > 0 ? (
                <div className="text-zinc-500" title={`${total.input.toLocaleString()} input + ${total.output.toLocaleString()} output + ${total.cacheRead.toLocaleString()} cache-read`}>
                  ≈{total_b.toFixed(1)}M tokens total
                </div>
              ) : null;
            })()}
            <div>
              <AnimatedNumber value={layout?.nodes.size ?? 0} /> visible · <AnimatedNumber value={forest.nodes.length} /> total
            </div>
            <div>
              <AnimatedNumber value={forest.sessionCount} /> sessions · <AnimatedNumber value={forest.forks.length} /> forks
            </div>
          </div>
        </SidebarGroup>

        </div>
        <div className="pt-3">
          <button onClick={() => setHelpOpen(true)} className="text-xs text-zinc-400 hover:text-zinc-200 underline">help (?)</button>
        </div>
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        <canvas
          ref={attachCanvas}
          style={{
            cursor: "grab",
            display: "block",
            touchAction: "none",
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onMouseLeave={() => {
            dragRef.current = null;
            setHovered(null);
            setCursor(null);
            dirtyRef.current = true;
          }}
        />

        {/* Tooltip — DOM overlay so it's always crisp + can show rich content.
            Anchored with a small offset; flips left of cursor if it would overflow
            the right edge. Suppressed when an inline card overlay is open since
            that already shows the full content. */}
        {tooltipData && tooltipReady && cursor && !(nodeStyle === "cards" && selected) && (
          <div
            className="absolute pointer-events-none z-20 bg-zinc-900/95 border border-zinc-700 rounded shadow-lg px-3 py-2 text-xs w-80 backdrop-blur"
            style={(() => {
              const cw = containerRef.current?.clientWidth ?? size.w;
              const ch = containerRef.current?.clientHeight ?? size.h;
              const tipW = 320;
              const tipH = 140;
              const overflowRight = cursor.x + 14 + tipW > cw - 8;
              const left = overflowRight ? Math.max(8, cursor.x - 14 - tipW) : cursor.x + 14;
              const top = Math.min(cursor.y + 14, ch - tipH - 8);
              return { left, top };
            })()}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ background: tooltipData.color }}
              />
              <span className="font-mono text-zinc-300 font-semibold">{tooltipData.title}</span>
              {tooltipData.isSidechain && (
                <span className="text-[9px] uppercase tracking-wider text-purple-300 bg-purple-950/60 px-1.5 py-0.5 rounded">subagent</span>
              )}
            </div>
            <div className="text-zinc-200 leading-snug line-clamp-5 mb-1.5">
              {highlightMatches(tooltipData.body, searchQuery)}
            </div>
            <div className="text-[10px] text-zinc-500 font-mono leading-tight">{tooltipData.meta}</div>
          </div>
        )}

        {/* Bookmark gutter (left edge) — stars at the screen-Y of each bookmark */}
        <BookmarkGutter
          bookmarks={bookmarks}
          layout={layout}
          viewportHeight={size.h}
          getTransform={() => transformRef.current}
          panToLayoutPoint={(lx, ly) => panToLayoutPoint(lx, ly, 300)}
          onSelect={(id) => setSelected(id)}
        />

        {/* Minimap (top-right) */}
        <Minimap
          layout={layout}
          viewportWidth={size.w}
          viewportHeight={size.h}
          getTransform={() => transformRef.current}
          panToLayoutPoint={(lx, ly) => panToLayoutPoint(lx, ly, 250)}
        />

        {/* Zoom overlay */}
        <ZoomOverlay
          layout={layout}
          size={size}
          getTransform={() => transformRef.current}
          onFitAll={() => { if (layout) animateTo(fitTransform(layout, size.w, size.h)); }}
          onFitRecent={() => {
            if (!layout || !forest) return;
            const b = mostRecentSessionBand(layout, forest);
            if (b) animateTo(fitToBounds(b, size.w, size.h, 80));
          }}
          onZoomChange={(factor) => {
            const t = transformRef.current;
            const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.scale * factor));
            if (newScale === t.scale) return;
            const cx = size.w / 2;
            const cy = size.h / 2;
            const lx = (cx - t.tx) / t.scale;
            const ly = (cy - t.ty) / t.scale;
            animateTo({ scale: newScale, tx: cx - lx * newScale, ty: cy - ly * newScale }, 200);
          }}
        />

        {/* Search overlay */}
        {searchOpen && (
          <div className="absolute top-3 right-3 z-30 bg-zinc-900/95 border border-zinc-700 rounded backdrop-blur min-w-[380px]">
            <div className="flex items-center gap-2 px-2 py-1">
            <input
              autoFocus
              type="text"
              placeholder="search messages…"
              className="bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none w-64"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Shift+Enter steps backward; Enter steps forward.
                  stepMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === "ArrowDown" || (e.key === "n" && (e.ctrlKey || e.metaKey))) {
                  e.preventDefault();
                  stepMatch(1);
                } else if (e.key === "ArrowUp" || (e.key === "p" && (e.ctrlKey || e.metaKey))) {
                  e.preventDefault();
                  stepMatch(-1);
                }
              }}
            />
            {matchList.length > 0 ? (
              <>
                <button
                  className="text-zinc-400 hover:text-zinc-100 text-xs px-1.5 rounded hover:bg-zinc-800"
                  onClick={() => stepMatch(-1)}
                  title="Previous match (shift+enter)"
                  aria-label="Previous match"
                >
                  ↑
                </button>
                <span className="text-xs text-zinc-300 font-mono tabular-nums">
                  {matchIndex + 1}<span className="text-zinc-600">/</span>{matchList.length}
                </span>
                <button
                  className="text-zinc-400 hover:text-zinc-100 text-xs px-1.5 rounded hover:bg-zinc-800"
                  onClick={() => stepMatch(1)}
                  title="Next match (enter)"
                  aria-label="Next match"
                >
                  ↓
                </button>
                <button
                  className="text-zinc-500 hover:text-zinc-200 text-[10px] underline ml-1"
                  onClick={() => {
                    if (!layout) return;
                    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
                    for (const id of matchList) {
                      const n = layout.nodes.get(id);
                      if (!n) continue;
                      if (n.x < mnx) mnx = n.x;
                      if (n.y < mny) mny = n.y;
                      if (n.x > mxx) mxx = n.x;
                      if (n.y > mxy) mxy = n.y;
                    }
                    if (mxx > mnx) animateTo(fitToBounds({ minX: mnx, minY: mny, maxX: mxx, maxY: mxy }, size.w, size.h, 80));
                  }}
                  title="Zoom out to fit all matches"
                >
                  fit all
                </button>
              </>
            ) : (
              <span className="text-xs text-zinc-600 font-mono">
                {searchQuery ? "0 matches" : ""}
              </span>
            )}
            <button
              className="text-zinc-500 hover:text-zinc-200 text-xs px-1"
              onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
              title="esc"
              aria-label="Close search"
            >
              ✕
            </button>
            </div>

            {/* Recent searches — only shown when the input is empty (acts as
                a suggestion list). Click to re-run, ✕ to remove. */}
            {!searchQuery.trim() && recentSearches.length > 0 && (
              <div className="border-t border-zinc-800 py-1 max-h-56 overflow-y-auto">
                <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Recent</div>
                {recentSearches.map((q) => (
                  <div key={q} className="group flex items-center px-2 hover:bg-zinc-800/50">
                    <button
                      className="flex-1 text-left text-xs text-zinc-300 px-1 py-1 truncate"
                      onClick={() => setSearchQuery(q)}
                      title={`Search for "${q}"`}
                    >
                      <span className="text-zinc-500 mr-2">↻</span>
                      {q}
                    </button>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs px-1"
                      onClick={() => removeRecentSearch(q)}
                      title="Remove from recents"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Color legend (only when heat-map mode is active) */}
        {colorMode !== "role" && layout && layout.nodes.size > 0 && (
          <ColorLegend mode={colorMode} layout={layout} />
        )}

        {/* Empty state — when filters/scope/visibility have excluded everything,
            the canvas goes black with no explanation. Tell the user what's
            wrong and offer one-click rescue. */}
        {layout && layout.nodes.size === 0 && forest.nodes.length > 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto bg-zinc-900/95 border border-zinc-700 rounded-lg p-5 max-w-sm text-center space-y-3 shadow-xl backdrop-blur">
              <div className="text-zinc-200 text-sm">
                {(() => {
                  const filterActive = filter.startDate || filter.endDate || filter.requiredTools.length > 0 || filter.bookmarkedOnly;
                  if (activeSpace && activeSpace.sessionIds.length === 0) return `Space "${activeSpace.name}" has no sessions yet`;
                  if (activeSpace) return `No sessions in "${activeSpace.name}" match the current filter`;
                  if (filterActive) return "No sessions match the current filter";
                  if (mode === "per-project" && scopeProject) return `No visible nodes in "${prettySlug(scopeProject)}" — try the visibility toggles below`;
                  return "No visible nodes — adjust the visibility filter to show messages";
                })()}
              </div>
              <div className="flex gap-2 justify-center text-xs">
                {(filter.startDate || filter.endDate || filter.requiredTools.length > 0 || filter.bookmarkedOnly) && (
                  <button
                    className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
                    onClick={() => updateFilter({ startDate: null, endDate: null, requiredTools: [], bookmarkedOnly: false })}
                  >
                    clear filter
                  </button>
                )}
                {activeSpaceId && (
                  <button
                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                    onClick={() => setActiveSpaceId(null)}
                  >
                    exit space
                  </button>
                )}
                {mode === "per-project" && scopeProject && (
                  <button
                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                    onClick={() => setMode("all-projects")}
                  >
                    view all projects
                  </button>
                )}
                <button
                  className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                  onClick={() => setVisibility(DEFAULT_VISIBILITY)}
                >
                  reset visibility
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Active scope pills (top-center, above LOD) — show what's narrowing
            the view so empty results don't feel mysterious. Click × to clear. */}
        {(activeSpace || (mode === "per-project" && scopeProject)) && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 -translate-y-1">
            {activeSpace && (
              <button
                className="group flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-900/95 border border-zinc-700 hover:border-zinc-500 text-xs text-zinc-200 backdrop-blur shadow"
                onClick={() => setActiveSpaceId(null)}
                title="Clear space filter"
              >
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ background: `hsl(${activeSpace.hue}, 60%, 55%)` }}
                />
                <span>✦ {activeSpace.name}</span>
                <span className="text-zinc-500">·</span>
                <span className="text-zinc-500 text-[10px]">{activeSpace.sessionIds.length} sessions</span>
                <span className="text-zinc-500 group-hover:text-red-400 ml-1">×</span>
              </button>
            )}
            {mode === "per-project" && scopeProject && (
              <button
                className="group flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-900/95 border border-zinc-700 hover:border-zinc-500 text-xs text-zinc-200 backdrop-blur shadow"
                onClick={() => setMode("all-projects")}
                title="Switch to all-projects view"
              >
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ background: projectColor(scopeProject) }}
                />
                <span>📁 {prettySlug(scopeProject)}</span>
                <span className="text-zinc-500 group-hover:text-red-400 ml-1">×</span>
              </button>
            )}
          </div>
        )}

        {/* StatusBar replaces the standalone LOD indicator (zoom / lod / scope /
            mode / selection / live status all in one strip at the bottom). */}
        <StatusBar
          mode={mode}
          scopeLabel={
            activeSpace ? `✦ ${activeSpace.name}` :
            (mode === "per-project" && scopeProject ? prettySlug(scopeProject) : null)
          }
          direction={direction}
          nodeStyle={nodeStyle}
          colorMode={colorMode}
          backgroundStyle={backgroundStyle}
          selectedCount={selected ? 1 : 0}
          multiSelectedCount={multiSelected.size}
          followLive={followLive}
          liveSessionId={effectiveActiveSession}
          liveTipTs={liveTipId ? forest.nodes.find((n) => n.id === liveTipId)?.timestamp ?? null : null}
          layout={layout}
          getTransform={() => transformRef.current}
        />

        {/* Multi-select action bar (bottom-center) — appears when ctrl/cmd+click
            has accumulated 1+ nodes. Bulk bookmark + add-to-Space + clear. */}
        {multiSelected.size > 0 && (
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-2 rounded bg-zinc-900/95 border border-cyan-700 text-xs text-zinc-200 backdrop-blur shadow-xl">
            <span className="font-mono text-cyan-300 tabular-nums">{multiSelected.size}</span>
            <span className="text-zinc-400">selected</span>
            <span className="text-zinc-700">·</span>
            <button
              className="px-2 py-1 rounded hover:bg-zinc-800 text-amber-400"
              onClick={() => {
                setBookmarks((prev) => {
                  const next = new Set(prev);
                  for (const id of multiSelected) next.add(id);
                  try { localStorage.setItem("cc-map-bookmarks", JSON.stringify([...next])); } catch {}
                  return next;
                });
                setMultiSelected(new Set());
              }}
              title="Bookmark all selected"
            >
              ★ bookmark all
            </button>
            {spaces.length > 0 && (
              <details className="relative">
                <summary className="px-2 py-1 rounded hover:bg-zinc-800 cursor-pointer list-none text-emerald-400">+ add to space ▾</summary>
                <div className="absolute bottom-full mb-1 right-0 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1 min-w-[160px]">
                  {spaces.map((sp) => (
                    <button
                      key={sp.id}
                      className="w-full text-left px-2 py-1 hover:bg-zinc-800 text-zinc-200 flex items-center gap-1.5"
                      onClick={() => {
                        const sessionIds = new Set<string>();
                        for (const nodeId of multiSelected) {
                          const n = forest?.nodes.find((x) => x.id === nodeId);
                          if (n) sessionIds.add(n.sessionId);
                        }
                        const combined = [...new Set([...sp.sessionIds, ...sessionIds])];
                        upsertSpace({ ...sp, sessionIds: combined });
                        setMultiSelected(new Set());
                      }}
                    >
                      <span className="inline-block w-2 h-2 rounded-sm" style={{ background: `hsl(${sp.hue}, 60%, 55%)` }} />
                      {sp.name}
                    </button>
                  ))}
                </div>
              </details>
            )}
            <span className="text-zinc-700">·</span>
            <button
              className="px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400"
              onClick={() => setMultiSelected(new Set())}
              title="Clear selection (esc)"
            >
              clear
            </button>
          </div>
        )}

        {/* Recent activity toasts (bottom-right, stacked) */}
        {activityToasts.length > 0 && (
          <div className="absolute bottom-10 right-3 z-30 flex flex-col-reverse gap-2 max-w-xs pointer-events-none">
            {activityToasts.map((t) => {
              const age = Date.now() - t.receivedMs;
              const fadeOpacity = Math.max(0, 1 - age / TOAST_TTL_MS);
              return (
                <button
                  key={t.nodeId}
                  className="pointer-events-auto text-left px-3 py-2 rounded shadow-xl bg-zinc-900/95 border border-zinc-700 hover:border-emerald-500 transition-all"
                  style={{ opacity: 0.4 + 0.6 * fadeOpacity }}
                  onClick={() => {
                    setSelected(t.nodeId);
                    const ln = layout?.nodes.get(t.nodeId);
                    if (ln) panToLayoutPoint(ln.x, ln.y, 350);
                    setActivityToasts((prev) => prev.filter((x) => x.nodeId !== t.nodeId));
                  }}
                  title="Click to jump to this message"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-sm"
                      style={{ background: projectColor(t.projectSlug) }}
                    />
                    <span className="text-[10px] uppercase tracking-wide font-mono text-zinc-400">
                      {t.role === "assistant" ? "new reply" : "new prompt"}
                    </span>
                    <span className="text-[10px] text-zinc-600 font-mono">{t.sessionId.slice(0, 6)}</span>
                  </div>
                  <div className="text-xs text-zinc-200 line-clamp-2 leading-tight">{t.preview}</div>
                </button>
              );
            })}
          </div>
        )}

        {/* Drag-to-Space hint when no spaces yet. Sits ABOVE the multi-select
            toolbar so they don't overlap if both are active at once. */}
        {dragSession && spaces.length === 0 && (
          <div className={`absolute left-1/2 -translate-x-1/2 z-30 px-3 py-2 rounded bg-zinc-900/95 border border-zinc-700 text-xs text-zinc-300 ${multiSelected.size > 0 ? "bottom-20" : "bottom-10"}`}>
            create a Space first to drop this session into one
          </div>
        )}

        {/* Mini context toolbar above the selected node (dots mode only; in cards
            mode the inline expand panel provides actions). Hidden when the
            right-click context menu is open to avoid double-toolbar overlap. */}
        {nodeStyle === "dots" && selected && layout?.nodes.has(selected) && !contextMenu && (() => {
          const selNode = forest.nodes.find((n) => n.id === selected);
          if (!selNode) return null;
          return (
            <NodeContextToolbar
              layout={layout}
              selectedId={selected}
              viewportWidth={size.w}
              viewportHeight={size.h}
              getTransform={() => transformRef.current}
              isBookmarked={bookmarks.has(selected)}
              spaces={spaces}
              isInSpace={(spaceId) => {
                const sp = spaces.find((x) => x.id === spaceId);
                return !!sp && sp.sessionIds.includes(selNode.sessionId);
              }}
              onToggleBookmark={() => toggleBookmark(selected)}
              onResumeCLI={(fork) => {
                const token = localStorage.getItem("cc-map-token") ?? "";
                fetch("/api/resume", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ sessionId: selNode.sessionId, fork }),
                })
                  .then((r) => r.json())
                  .then((r) => {
                    if (!r.ok && r.command) {
                      void navigator.clipboard.writeText(r.command);
                      showToast(`Couldn't launch a terminal — command copied to clipboard: ${r.command}`, "error");
                    }
                  })
                  .catch((e) => showToast(`Resume failed: ${e}`, "error"));
              }}
              onContinueInMap={() => {
                setSpawnModal({
                  mode: "continue",
                  sessionId: selNode.sessionId,
                  cwd: "",
                  prompt: "",
                });
              }}
              onAddToSpace={(spaceId) => addSessionToSpace(selNode.sessionId, spaceId)}
            />
          );
        })()}

        {/* Inline card expansion (cards mode only). The pinned card takes
            priority over the live selection so you can keep one open while
            navigating other cards. */}
        {(() => {
          if (nodeStyle !== "cards") return null;
          const isPinned = pinnedCardId !== null && layout?.nodes.has(pinnedCardId);
          const id = isPinned ? pinnedCardId : selected;
          if (!id || !layout?.nodes.has(id)) return null;
          return (
            <InlineCardExpand
              layout={layout}
              selectedId={id}
              selectedDetail={isPinned ? pinnedDetail : selectedDetail}
              viewportWidth={size.w}
              viewportHeight={size.h}
              getTransform={() => transformRef.current}
              pinned={!!isPinned}
              onPin={() => {
                setPinnedCardId(id);
                setPinnedDetail(selectedDetail);
              }}
              onUnpin={() => {
                setPinnedCardId(null);
                setPinnedDetail(null);
              }}
              onClose={() => {
                if (isPinned) { setPinnedCardId(null); setPinnedDetail(null); }
                else setSelected(null);
              }}
            />
          );
        })()}
      </div>

      {/* Side detail panel — hidden in cards mode where inline expansion replaces it */}
      {selected && nodeStyle !== "cards" && (
        <div className="absolute top-0 right-0 bottom-0 w-[480px] border-l border-zinc-800 bg-zinc-950/95 backdrop-blur overflow-y-auto z-10">
          <DetailPanel
            data={selectedDetail}
            selectedId={selected}
            forest={forest}
            layout={layout}
            onClose={() => setSelected(null)}
            onNavigate={(id) => setSelected(id)}
          />
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="absolute z-30 bg-zinc-900 border border-zinc-700 rounded shadow-xl text-xs py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <ContextMenuItems
            target={contextMenu.target}
            layout={layout}
            forest={forest}
            size={size}
            activeSpace={activeSpace}
            spaces={spaces}
            onAddToSpace={(sid, spId) => addSessionToSpace(sid, spId)}
            onRemoveFromSpace={(sid, spId) => removeSessionFromSpace(sid, spId)}
            onNewCCSession={() => {
              setSpawnModal({
                mode: "new",
                cwd: "",
                prompt: "",
                targetSpaceId: activeSpaceId,
              });
            }}
            onContinueSession={(sid) => {
              setSpawnModal({
                mode: "continue",
                sessionId: sid,
                cwd: "",
                prompt: "",
              });
            }}
            animateTo={animateTo}
            onZoomIn={() => {
              const t = transformRef.current;
              const newScale = Math.min(MAX_SCALE, t.scale * 1.6);
              const lx = (contextMenu.x - t.tx) / t.scale;
              const ly = (contextMenu.y - t.ty) / t.scale;
              animateTo({ scale: newScale, tx: contextMenu.x - lx * newScale, ty: contextMenu.y - ly * newScale }, 220);
            }}
            onZoomOut={() => {
              const t = transformRef.current;
              const newScale = Math.max(MIN_SCALE, t.scale / 1.6);
              const lx = (contextMenu.x - t.tx) / t.scale;
              const ly = (contextMenu.y - t.ty) / t.scale;
              animateTo({ scale: newScale, tx: contextMenu.x - lx * newScale, ty: contextMenu.y - ly * newScale }, 220);
            }}
            onSelect={(id) => setSelected(id)}
            onOpenInViewer={(sessionId) => {
              void selectSessionInViewer(sessionId);
              onClose();
            }}
            onResumeCLI={(sessionId, fork) => {
              const token = localStorage.getItem("cc-map-token") ?? "";
              fetch("/api/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ sessionId, fork }),
              })
                .then((r) => r.json())
                .then((r) => {
                  if (!r.ok && r.command) {
                    void navigator.clipboard.writeText(r.command);
                    showToast(`Couldn't launch a terminal — command copied to clipboard: ${r.command}`, "error");
                  }
                })
                .catch((e) => showToast(`Resume failed: ${e}`, "error"));
            }}
            isBookmarked={contextMenu.target.kind === "node" && contextMenu.target.id ? bookmarks.has(contextMenu.target.id) : false}
            onToggleBookmark={(id) => toggleBookmark(id)}
            onClose={() => setContextMenu(null)}
          />
        </div>
      )}

      {/* Spawn-session modal (Phase 3c) — stays open as a chat for back-and-forth */}
      {spawnModal && (() => {
        // Live session transcript (only in continue mode) — read from forest
        const sessionNodes = spawnModal.mode === "continue"
          ? (forest.nodes ?? [])
              .filter((n) => n.sessionId === spawnModal.sessionId)
              .filter((n) => (n.role === "user" && n.subtype === "prompt") || (n.role === "assistant" && n.subtype === "text"))
              .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          : [];
        return (
          <div
            className="absolute inset-0 z-40 bg-zinc-950/80 backdrop-blur flex items-center justify-center"
            onClick={(e) => { if (e.target === e.currentTarget) setSpawnModal(null); }}
          >
            <div
              ref={spawnDialogRef}
              role="dialog"
              aria-modal="true"
              aria-label={spawnModal.mode === "new" ? "New Claude Code session" : "Chat with session"}
              className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 max-w-2xl w-full text-sm space-y-3 max-h-[85vh] flex flex-col outline-none"
            >
              <div className="flex items-center justify-between">
                <div className="text-zinc-100 font-semibold text-base">
                  {spawnModal.mode === "new" ? "✦ New Claude Code session" : "✦ Chat with session"}
                </div>
                <button
                  onClick={() => setSpawnModal(null)}
                  className="text-zinc-500 hover:text-zinc-200 text-base leading-none"
                  title="close (esc)"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              {spawnModal.mode === "continue" && (
                <div className="text-xs text-zinc-500 font-mono">
                  resume: {spawnModal.sessionId.slice(0, 8)}… · {sessionNodes.length} message{sessionNodes.length === 1 ? "" : "s"}
                </div>
              )}

              {/* Transcript scroll area (continue mode only) */}
              {spawnModal.mode === "continue" && sessionNodes.length > 0 && (
                <div className="flex-1 overflow-y-auto border border-zinc-800 rounded bg-zinc-950 p-2 space-y-2 min-h-0">
                  {sessionNodes.map((n) => (
                    <div key={n.id} className="text-xs">
                      <div className={`text-[10px] font-mono mb-0.5 ${n.role === "assistant" ? "text-amber-400" : "text-emerald-400"}`}>
                        {n.role === "assistant" ? "ASSISTANT" : "YOU"} · {new Date(n.timestamp).toLocaleTimeString()}
                      </div>
                      <div className="text-zinc-200 whitespace-pre-wrap leading-snug">{n.preview}</div>
                    </div>
                  ))}
                </div>
              )}

              {spawnModal.mode === "new" && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Working directory (optional)</label>
                  <input
                    type="text"
                    value={spawnModal.cwd}
                    onChange={(e) => setSpawnModal((m) => m ? { ...m, cwd: e.target.value } : m)}
                    placeholder="C:\Users\bnakk\projects\… (default: your home dir)"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-xs font-mono"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  {spawnModal.mode === "new" ? "Prompt" : "Reply"}
                </label>
                <textarea
                  autoFocus
                  value={spawnModal.prompt}
                  onChange={(e) => setSpawnModal((m) => m ? { ...m, prompt: e.target.value } : m)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void submitSpawn();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setSpawnModal(null);
                    }
                  }}
                  rows={4}
                  placeholder={spawnModal.mode === "new" ? "What do you want Claude to do?" : "Type your next message…"}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm"
                />
                <div className="text-[10px] text-zinc-500 mt-1">Ctrl/Cmd+Enter to send · Esc to close</div>
              </div>
              {spawnModal.mode === "new" && spawnModal.targetSpaceId && (() => {
                const sp = spaces.find((p) => p.id === spawnModal.targetSpaceId);
                return sp ? (
                  <div className="text-xs text-zinc-400">
                    Will be added to space: <span className="text-emerald-400">{sp.name}</span>
                  </div>
                ) : null;
              })()}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setSpawnModal(null)}
                  className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Close
                </button>
                <button
                  onClick={() => void submitSpawn()}
                  disabled={!spawnModal.prompt.trim()}
                  className="px-3 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-30 disabled:hover:bg-emerald-700 rounded text-white"
                >
                  {spawnModal.mode === "new" ? "Spawn session" : "Send"}
                </button>
              </div>
              <div className="text-[10px] text-zinc-600 pt-2 border-t border-zinc-800">
                {spawnModal.mode === "new"
                  ? "After spawn this turns into a chat — keep typing replies; each one spawns claude --resume in the background."
                  : "Replies stream into the transcript above as Claude writes. Map nodes update too."}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Help modal */}
      {helpOpen && (
        <div
          className="absolute inset-0 z-40 bg-zinc-950/80 backdrop-blur flex items-center justify-center"
          onClick={() => setHelpOpen(false)}
        >
          <div
            ref={helpDialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="cc-map controls"
            className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-2xl text-sm grid grid-cols-2 gap-x-8 gap-y-3 max-h-[85vh] overflow-y-auto outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="col-span-2 text-zinc-100 font-semibold text-base mb-1">cc-map — controls</div>
            <KbdGroup title="Pan & zoom">
              <KbdRow keys={["drag"]} desc="pan" />
              <KbdRow keys={["w", "a", "s", "d"]} desc="smooth pan (hold shift for fast)" />
              <KbdRow keys={["2-finger scroll"]} desc="pan (trackpad)" />
              <KbdRow keys={["ctrl", "+", "wheel"]} desc="zoom (or pinch)" />
              <KbdRow keys={["="]} desc="zoom in" />
              <KbdRow keys={["−"]} desc="zoom out" />
              <KbdRow keys={["double-click"]} desc="zoom in 2× at cursor" />
            </KbdGroup>
            <KbdGroup title="Fit & jump">
              <KbdRow keys={["0", "f"]} desc="fit all" />
              <KbdRow keys={["1"]} desc="fit most recent session" />
              <KbdRow keys={["space"]} desc="jump to live tip" />
              <KbdRow keys={["click minimap"]} desc="pan to that area" />
              <KbdRow keys={["click ★ gutter"]} desc="jump to bookmark" />
              <KbdRow keys={["click live arrow"]} desc="pan to off-screen live tip" />
            </KbdGroup>
            <KbdGroup title="Selection">
              <KbdRow keys={["click"]} desc="select node / zoom to session band" />
              <KbdRow keys={["↑", "↓"]} desc="prev/next node in session" />
              <KbdRow keys={["←", "→"]} desc="prev/next node in session" />
              <KbdRow keys={["b"]} desc="bookmark the selected node" />
              <KbdRow keys={["esc"]} desc="close overlay / clear search" />
            </KbdGroup>
            <KbdGroup title="Search">
              <KbdRow keys={["/"]} desc="open search" />
              <KbdRow keys={["enter"]} desc="next match (shift+enter = prev)" />
              <KbdRow keys={["↓", "↑"]} desc="(in search) next / prev match" />
              <KbdRow keys={["ctrl", "+", "n"]} desc="(in search) next match" />
              <KbdRow keys={["ctrl", "+", "p"]} desc="(in search) prev match" />
            </KbdGroup>
            <KbdGroup title="Spaces">
              <KbdRow keys={["shift", "+", "drag node"]} desc="drag-to-Space chip in sidebar" />
              <KbdRow keys={["click + N badge"]} desc="expand collapsed subagents" />
              <KbdRow keys={["right-click"]} desc="context menu (resume / fork / add to space)" />
            </KbdGroup>
            <KbdGroup title="Chord shortcuts (press g, then…)">
              <KbdRow keys={["g", "v"]} desc="back to viewer" />
              <KbdRow keys={["g", "b"]} desc="jump to first bookmark" />
              <KbdRow keys={["g", "s"]} desc="open search" />
              <KbdRow keys={["g", "f"]} desc="fit all" />
              <KbdRow keys={["g", "l"]} desc="jump to live tip" />
            </KbdGroup>
            <KbdGroup title="Modes (sidebar)">
              <KbdRow keys={["grid"]} desc="square-ish tree-map; forks stack" />
              <KbdRow keys={["column"]} desc="prompts down, replies right" />
              <KbdRow keys={["timeline"]} desc="one column per session; Y = real time" />
              <KbdRow keys={["dots / cards"]} desc="dot or text-card rendering" />
              <KbdRow keys={["role / recency / cost"]} desc="color modes (heat-maps add legend)" />
              <KbdRow keys={["follow live"]} desc="auto-recenter as new messages arrive" />
            </KbdGroup>
            <KbdGroup title="Help">
              <KbdRow keys={["?"]} desc="toggle this help" />
            </KbdGroup>
            <div className="col-span-2 flex items-center justify-between pt-3 border-t border-zinc-800">
              <div className="text-xs text-zinc-500 flex-1 pr-4">
                Semantic zoom: low zoom shows sessions as colored ribbons. Zoom in to see individual messages.
                In timeline mode, vertical gaps are real time (clamped so a week-long pause doesn't blow up the canvas).
              </div>
              <button
                className="text-xs text-zinc-400 hover:text-zinc-200 underline shrink-0"
                onClick={() => { setHelpOpen(false); setWelcomeOpen(true); }}
              >
                show intro
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Command palette (Cmd/Ctrl+K) — jump to anything, switch any mode,
          run any common action. Built fresh each render from current state. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
      />

      {/* Guided onboarding tour. Highlights real UI elements with a callout
          per step. Triggered on first visit (no cc-map-seen-welcome flag) and
          re-invokable via the help overlay's "show intro" link. */}
      <OnboardingTour open={welcomeOpen} onClose={closeWelcome} />

      {/* Drag-to-Space follower chip */}
      {dragSession && (
        <div
          className="fixed z-50 pointer-events-none px-2 py-1 rounded bg-emerald-700 border border-emerald-400 text-xs text-white shadow-xl max-w-xs truncate"
          style={{ left: dragSession.x + 12, top: dragSession.y + 12 }}
        >
          → {dragSession.label}
        </div>
      )}

      {/* In-app prompt / confirm (replace native dialogs) */}
      {textPrompt && (
        <TextPromptModal {...textPrompt} onClose={() => setTextPrompt(null)} />
      )}
      {confirmDialog && (
        <ConfirmModal {...confirmDialog} onClose={() => setConfirmDialog(null)} />
      )}

      {/* Transient toast (replaces alert()) */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`absolute top-3 left-1/2 -translate-x-1/2 z-50 max-w-md px-3 py-2 rounded shadow-xl text-xs backdrop-blur border ${
            toast.kind === "error"
              ? "bg-red-950/90 border-red-800 text-red-200"
              : "bg-zinc-900/95 border-zinc-700 text-zinc-200"
          }`}
        >
          <div className="flex items-start gap-2">
            <span className="break-words">{toast.message}</span>
            <button
              onClick={() => setToast(null)}
              className="shrink-0 text-current opacity-60 hover:opacity-100"
              aria-label="Dismiss"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───── Sidebar group helper ─────
/**
 * Collapsible sidebar section with persisted open state. The whole header is
 * clickable; a chevron indicates state. Inner sections (e.g. "Layout" inside
 * a "Display" group) keep their existing small sub-labels.
 */
function SidebarGroup({
  id,
  title,
  defaultOpen = true,
  count,
  summary,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  count?: number | string;
  /** One-line current-state summary shown right-aligned in the header when collapsed. */
  summary?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(`cc-map-sb-${id}`);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch {}
    return defaultOpen;
  });
  useEffect(() => {
    try { localStorage.setItem(`cc-map-sb-${id}`, open ? "1" : "0"); } catch {}
  }, [open, id]);
  return (
    <div className="border-b border-zinc-800 pb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 text-[10px] uppercase tracking-wider font-semibold py-1.5"
      >
        <span className="text-zinc-600 w-3 text-xs">{open ? "▾" : "▸"}</span>
        <span>{title}</span>
        {count !== undefined && (
          <span className="text-zinc-600 normal-case tracking-normal text-[10px]">({count})</span>
        )}
        {!open && summary && (
          <span className="ml-auto text-zinc-500 normal-case tracking-normal text-[10px] truncate max-w-[140px]" title={summary}>
            {summary}
          </span>
        )}
      </button>
      {open && <div className="space-y-2 mt-1">{children}</div>}
    </div>
  );
}

// ───── Modal a11y ─────
/**
 * Wire up the keyboard + focus contract every modal should honor: focus moves
 * inside on open (unless a child already grabbed it, e.g. an autoFocus field),
 * Tab is trapped within the dialog, Esc closes, and focus is restored to
 * whatever was focused before. Returns a ref to attach to the dialog container.
 *
 * The keydown listener runs in the capture phase and stops propagation, so the
 * map's global shortcut handler never sees Esc/Tab while a modal is up.
 */
function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open]);
  return ref;
}

/** Styled in-app replacement for window.prompt. */
function TextPromptModal({
  title,
  label,
  initial,
  placeholder,
  confirmLabel = "OK",
  onSubmit,
  onClose,
}: {
  title: string;
  label?: string;
  initial: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const dialogRef = useDialog(true, onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = () => { onSubmit(value); onClose(); };
  return (
    <div
      className="absolute inset-0 z-50 bg-zinc-950/80 backdrop-blur flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 w-full max-w-sm space-y-3 shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-zinc-100 font-semibold">{title}</div>
        {label && <label className="block text-xs text-zinc-400">{label}</label>}
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
          }}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm"
        />
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button onClick={submit} className="px-3 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 rounded text-white">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/** Styled in-app replacement for window.confirm. */
function ConfirmModal({
  title,
  message,
  confirmLabel = "OK",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialog(true, onClose);
  return (
    <div
      className="absolute inset-0 z-50 bg-zinc-950/80 backdrop-blur flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 w-full max-w-sm space-y-3 shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-zinc-100 font-semibold">{title}</div>
        <div className="text-sm text-zinc-300 leading-relaxed">{message}</div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className={`px-3 py-1 text-xs rounded text-white ${danger ? "bg-red-700 hover:bg-red-600" : "bg-emerald-700 hover:bg-emerald-600"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───── Helpers ─────

/**
 * Parse the URL hash into a partial state object. Supports a flat key=value
 * format separated by `&`, e.g. `#m=per-project&d=timeline&n=cards`.
 *
 * Keys (short to keep URLs compact):
 *   m  = ViewMode             (per-project | all-projects)
 *   p  = project slug         (only with m=per-project)
 *   d  = direction            (grid | column | timeline)
 *   n  = nodeStyle            (dots | cards)
 *   c  = colorMode            (role | recency | cost)
 *   sp = active space id      ("" clears it)
 *   s  = selected node uuid
 */
interface UrlState {
  mode?: ViewMode;
  scopeProject?: string | null;
  direction?: LayoutDirection;
  nodeStyle?: NodeStyle;
  colorMode?: ColorMode;
  activeSpaceId?: string | null;
  selected?: string | null;
}

function parseUrlState(): UrlState {
  if (typeof window === "undefined" || !window.location.hash) return {};
  const out: UrlState = {};
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  for (const part of hash.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = decodeURIComponent(part.slice(eq + 1));
    switch (k) {
      case "m": if (v === "per-project" || v === "all-projects") out.mode = v; break;
      case "p": out.scopeProject = v || null; break;
      case "d": if (v === "grid" || v === "column" || v === "timeline") out.direction = v; break;
      case "n": if (v === "dots" || v === "cards") out.nodeStyle = v; break;
      case "c": if (v === "role" || v === "recency" || v === "cost") out.colorMode = v; break;
      case "sp": out.activeSpaceId = v || null; break;
      case "s": out.selected = v || null; break;
    }
  }
  return out;
}

function writeUrlState(s: UrlState): void {
  if (typeof window === "undefined") return;
  const parts: string[] = [];
  if (s.mode && s.mode !== "per-project") parts.push(`m=${s.mode}`);
  if (s.scopeProject) parts.push(`p=${encodeURIComponent(s.scopeProject)}`);
  if (s.direction && s.direction !== "grid") parts.push(`d=${s.direction}`);
  if (s.nodeStyle && s.nodeStyle !== "dots") parts.push(`n=${s.nodeStyle}`);
  if (s.colorMode && s.colorMode !== "role") parts.push(`c=${s.colorMode}`);
  if (s.activeSpaceId) parts.push(`sp=${encodeURIComponent(s.activeSpaceId)}`);
  if (s.selected) parts.push(`s=${encodeURIComponent(s.selected)}`);
  const next = parts.length > 0 ? `#${parts.join("&")}` : window.location.pathname + window.location.search;
  // replaceState keeps history clean — state changes shouldn't spam back-button
  if (window.location.hash !== (parts.length > 0 ? `#${parts.join("&")}` : "")) {
    window.history.replaceState(null, "", next);
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function mostRecentSessionBand(layout: Layout, forest: ForestPayload) {
  // Find the session in scope whose latest timestamp is newest, then return its band.
  const byId = new Map<string, string>(); // sessionId -> latest timestamp
  for (const n of forest.nodes) {
    const cur = byId.get(n.sessionId);
    if (!cur || n.timestamp > cur) byId.set(n.sessionId, n.timestamp);
  }
  let best: { ts: string; band: typeof layout.sessionBands[number] } | null = null;
  for (const b of layout.sessionBands) {
    const ts = byId.get(b.sessionId);
    if (!ts) continue;
    if (!best || ts > best.ts) best = { ts, band: b };
  }
  return best?.band ?? null;
}

// ───── ZoomOverlay ─────

function ZoomOverlay({
  layout,
  size,
  getTransform,
  onFitAll,
  onFitRecent,
  onZoomChange,
}: {
  layout: Layout | null;
  size: { w: number; h: number };
  getTransform: () => Transform;
  onFitAll: () => void;
  onFitRecent: () => void;
  onZoomChange: (factor: number) => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const t = getTransform();
  void layout;
  void size;
  return (
    <div className="absolute bottom-10 left-3 z-10 flex items-center gap-1 bg-zinc-900/85 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 font-mono backdrop-blur">
      <button className="px-1.5 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700" onClick={() => onZoomChange(1 / 1.5)} title="−" aria-label="Zoom out">−</button>
      <span className="w-12 text-center">{(t.scale * 100).toFixed(0)}%</span>
      <button className="px-1.5 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700" onClick={() => onZoomChange(1.5)} title="=" aria-label="Zoom in">+</button>
      <button className="px-2 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700 ml-2" onClick={onFitRecent} title="1">recent</button>
      <button className="px-2 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700" onClick={onFitAll} title="0 / f">all</button>
    </div>
  );
}

// ───── Inline card expansion (cards mode) ─────
// Floating panel pinned to the selected card's screen position. Reads the
// transform via RAF poll so it tracks pan/zoom. Click anywhere outside (or X)
// to dismiss.
// ───── Color legend ─────
// A small bottom-left overlay shown when colorMode is "recency" or "cost".
// Without it, the heat-map gradients are mystery colors. Reuses the same
// gradient math the renderer uses (via buildColorContext) so what you see in
// the legend matches what's on the map.
function ColorLegend({ mode, layout }: { mode: "recency" | "cost"; layout: Layout }) {
  const cc = useMemo(() => buildColorContext(layout.nodes.values()), [layout]);
  if (mode === "recency") {
    if (cc.tsMax <= cc.tsMin) return null;
    return (
      <div className="absolute bottom-10 left-8 z-20 px-2.5 py-2 bg-zinc-900/90 border border-zinc-700 rounded text-xs text-zinc-300 backdrop-blur shadow-xl">
        <div className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Recency</div>
        <div
          className="w-40 h-2 rounded"
          style={{
            background: "linear-gradient(to right, hsl(240,6%,35%), hsl(160,84%,55%))",
          }}
        />
        <div className="flex justify-between mt-1 text-[10px] text-zinc-400 tabular-nums">
          <span>{formatTimeAgo(cc.tsMin)}</span>
          <span>{formatTimeAgo(cc.tsMax)}</span>
        </div>
      </div>
    );
  }
  // cost
  if (cc.costMax <= 1) return null;
  return (
    <div className="absolute bottom-3 left-3 z-20 px-2.5 py-2 bg-zinc-900/90 border border-zinc-700 rounded text-xs text-zinc-300 backdrop-blur shadow-xl">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Output tokens</div>
      <div
        className="w-40 h-2 rounded"
        style={{
          background: "linear-gradient(to right, hsl(240,6%,35%), hsl(38,92%,55%), hsl(0,84%,55%))",
        }}
      />
      <div className="flex justify-between mt-1 text-[10px] text-zinc-400 tabular-nums">
        <span>0</span>
        <span>{formatTokens(Math.round(cc.costMax / 0.66))}+</span>
      </div>
    </div>
  );
}

function formatTimeAgo(ms: number): string {
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return "now";
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(diff / 3600_000);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(diff / 86400_000);
  return `${d}d ago`;
}

/**
 * Sidebar mini-heatmap: 5 weeks × 7 weekdays of prompts-per-day, like a
 * tiny GitHub contribution graph. Click a cell → narrow the date filter to
 * that day. Today is the rightmost column of the bottom row.
 */
function DailyActivityHeatmap({
  forest,
  filter,
  onPickDate,
}: {
  forest: ForestPayload;
  filter: SessionFilter;
  onPickDate: (iso: string) => void;
}) {
  const ROWS = 5;
  const COLS = 7;
  const TOTAL = ROWS * COLS;

  const { cells, max } = useMemo(() => {
    // Count user prompts per day (yyyy-mm-dd in local time)
    const counts = new Map<string, number>();
    for (const n of forest.nodes) {
      if (n.role !== "user" || n.subtype !== "prompt") continue;
      const d = new Date(n.timestamp);
      if (Number.isNaN(d.getTime())) continue;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      counts.set(iso, (counts.get(iso) ?? 0) + 1);
    }
    // Build grid: bottom-right = today; walk backward TOTAL-1 days.
    const arr: { iso: string; date: Date; count: number }[] = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = TOTAL - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      arr.push({ iso, date: d, count: counts.get(iso) ?? 0 });
    }
    let max = 0;
    for (const c of arr) if (c.count > max) max = c.count;
    return { cells: arr, max };
  }, [forest]);

  const intensity = (count: number): string => {
    if (count === 0) return "rgba(63, 63, 70, 0.5)"; // zinc-700
    const ratio = max > 0 ? count / max : 0;
    if (ratio < 0.25) return "hsl(160, 50%, 28%)";
    if (ratio < 0.5) return "hsl(160, 60%, 38%)";
    if (ratio < 0.75) return "hsl(160, 72%, 48%)";
    return "hsl(160, 84%, 55%)";
  };

  const monthsInRange = useMemo(() => {
    const seen = new Set<string>();
    for (const c of cells) seen.add(c.date.toLocaleString(undefined, { month: "short" }));
    return [...seen];
  }, [cells]);

  return (
    <div className="space-y-1">
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}
      >
        {cells.map((c) => {
          const isSelected = filter.startDate === c.iso && filter.endDate === c.iso;
          return (
            <button
              key={c.iso}
              onClick={() => onPickDate(c.iso)}
              title={`${c.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${c.count} prompt${c.count === 1 ? "" : "s"}`}
              className={`aspect-square rounded-[2px] transition-transform hover:scale-125 ${isSelected ? "ring-1 ring-white" : ""}`}
              style={{ background: intensity(c.count) }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-zinc-500 px-0.5">
        <span>{monthsInRange[0] ?? ""}</span>
        <span>{max > 0 ? `max ${max}` : ""}</span>
        <span>today</span>
      </div>
    </div>
  );
}

/**
 * Wrap occurrences of `query` (case-insensitive, literal substring) in <mark>
 * tags so the tooltip can show why a node matched the search. Returns the
 * original text unchanged if query is empty.
 */
function highlightMatches(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const found = lower.indexOf(needle, i);
    if (found < 0) {
      out.push(text.slice(i));
      break;
    }
    if (found > i) out.push(text.slice(i, found));
    out.push(
      <mark
        key={key++}
        className="bg-amber-500/40 text-amber-100 rounded px-0.5"
      >
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    i = found + needle.length;
  }
  return out;
}

/**
 * Tweens a number from its previous value to the new value over ~350ms. Use
 * for stat displays so changes feel like changes instead of snaps. Skips the
 * animation when value < 50 (sub-50 swaps aren't worth the visual noise).
 */
function AnimatedNumber({
  value,
  format,
  durationMs = 350,
}: {
  value: number;
  format?: (n: number) => string;
  durationMs?: number;
}) {
  const [display, setDisplay] = useState(value);
  const tweenRef = useRef<{ from: number; to: number; startMs: number } | null>(null);
  useEffect(() => {
    if (Math.abs(value - display) < 50) { setDisplay(value); return; }
    tweenRef.current = { from: display, to: value, startMs: performance.now() };
    let raf = 0;
    const tick = () => {
      const t = tweenRef.current;
      if (!t) return;
      const k = Math.min(1, (performance.now() - t.startMs) / durationMs);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisplay(t.from + (t.to - t.from) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const out = format ? format(display) : Math.round(display).toLocaleString();
  return <>{out}</>;
}

function humanGap(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(ms / 3600_000);
  if (h < 24) return `${h}h`;
  return `${Math.round(ms / 86400_000)}d`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function InlineCardExpand({
  layout,
  selectedId,
  selectedDetail,
  viewportWidth,
  viewportHeight,
  getTransform,
  pinned,
  onPin,
  onUnpin,
  onClose,
}: {
  layout: Layout;
  selectedId: string;
  selectedDetail: NodeResponse | null;
  viewportWidth: number;
  viewportHeight: number;
  getTransform: () => Transform;
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number; placement: "right" | "left" | "below" }>(
    { left: 0, top: 0, placement: "right" },
  );
  const PANEL_W = 480;
  const MAX_H = Math.min(560, viewportHeight - 40);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const node = layout.nodes.get(selectedId);
      if (node) {
        const t = getTransform();
        // Card top-left in screen coords. cardWidth = 260 layout units.
        const sx = node.x * t.scale + t.tx;
        const sy = node.y * t.scale + t.ty;
        const cardScreenW = 260 * t.scale;
        const cardScreenH = (node.cardHeight ?? 40) * t.scale;
        // Prefer placing right of the card; fall back to left then below.
        let left = sx + cardScreenW + 12;
        let top = sy;
        let placement: "right" | "left" | "below" = "right";
        if (left + PANEL_W > viewportWidth - 12) {
          // Try left
          left = sx - PANEL_W - 12;
          placement = "left";
          if (left < 12) {
            // Below the card
            left = Math.max(12, Math.min(sx, viewportWidth - PANEL_W - 12));
            top = sy + cardScreenH + 12;
            placement = "below";
          }
        }
        // Clamp top into viewport so panel is always reachable
        top = Math.max(12, Math.min(top, viewportHeight - MAX_H - 12));
        setPos((prev) =>
          prev.left === left && prev.top === top && prev.placement === placement ? prev : { left, top, placement },
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layout, selectedId, viewportWidth, viewportHeight, getTransform, MAX_H]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const node = layout.nodes.get(selectedId);
  if (!node) return null;

  return (
    <div
      className="absolute z-30 bg-zinc-950/95 backdrop-blur border border-zinc-700 rounded-lg shadow-2xl overflow-hidden flex flex-col"
      style={{ left: pos.left, top: pos.top, width: PANEL_W, maxHeight: MAX_H }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/60">
        <div className="text-xs font-mono text-zinc-400 flex items-center gap-2">
          <span className="uppercase font-semibold" style={{ color: roleColor(node.role, node.subtype) }}>
            {headerLabel(node.role, node.subtype)}
          </span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-500">{selectedId.slice(0, 8)}</span>
          {node.isSidechain && <span className="text-purple-400 text-[10px]">SUBAGENT</span>}
          {pinned && <span className="text-amber-400 text-[10px]">PINNED</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={pinned ? onUnpin : onPin}
            className={`w-6 h-6 rounded text-base leading-none ${pinned ? "text-amber-400 hover:text-amber-200 hover:bg-zinc-800" : "text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"}`}
            title={pinned ? "Unpin (let selection update this panel)" : "Pin this card open"}
            aria-label={pinned ? "Unpin card" : "Pin card open"}
          >
            {pinned ? "📌" : "📍"}
          </button>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 text-lg leading-none"
            title="Close (Esc)"
            aria-label="Close card"
          >
            ×
          </button>
        </div>
      </div>
      <div className="overflow-y-auto p-3 text-sm flex-1">
        {selectedDetail ? (
          <Suspense fallback={<div className="text-zinc-500 italic">loading renderer…</div>}>
            <ContentRender data={selectedDetail} />
          </Suspense>
        ) : (
          <div className="text-zinc-500 italic">loading…</div>
        )}
      </div>
    </div>
  );
}

function headerLabel(role: "user" | "assistant", subtype: string | null): string {
  if (role === "user" && subtype === "prompt") return "prompt";
  if (role === "assistant" && subtype === "tool-only") return "tool call";
  if (role === "assistant" && subtype === "thinking") return "thinking";
  if (role === "assistant") return "assistant";
  return subtype ?? "user";
}

function roleColor(role: "user" | "assistant", subtype: string | null): string {
  if (role === "user" && subtype === "prompt") return "#34d399";
  if (role === "assistant" && subtype === "tool-only") return "#60a5fa";
  if (role === "assistant" && subtype === "thinking") return "#c084fc";
  if (role === "assistant") return "#fbbf24";
  return "#a1a1aa";
}

// ───── Detail panel ─────

function DetailPanel({
  data,
  selectedId,
  forest,
  layout,
  onClose,
  onNavigate,
}: {
  data: NodeResponse | null;
  selectedId: string;
  forest: ForestPayload;
  layout: Layout | null;
  onClose: () => void;
  onNavigate: (id: string) => void;
}) {
  const node = forest.nodes.find((n) => n.id === selectedId);
  const sessionMeta = layout?.sessionBands.find((b) => b.sessionId === node?.sessionId);

  const { prevId, nextId } = useMemo(() => {
    if (!node) return { prevId: null, nextId: null };
    // Find prev/next nodes in the same session sorted by timestamp
    const sib = forest.nodes
      .filter((n) => n.sessionId === node.sessionId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const idx = sib.findIndex((n) => n.id === node.id);
    return {
      prevId: idx > 0 ? sib[idx - 1]!.id : null,
      nextId: idx >= 0 && idx < sib.length - 1 ? sib[idx + 1]!.id : null,
    };
  }, [node, forest]);

  return (
    <div>
      <div className="p-3 border-b border-zinc-800 flex items-center gap-2 text-xs">
        <button
          onClick={() => prevId && onNavigate(prevId)}
          disabled={!prevId}
          className="px-2 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-zinc-800"
          title="prev in session"
          aria-label="Previous message in session"
        >
          ←
        </button>
        <button
          onClick={() => nextId && onNavigate(nextId)}
          disabled={!nextId}
          className="px-2 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-zinc-800"
          title="next in session"
          aria-label="Next message in session"
        >
          →
        </button>
        <span className="text-zinc-600">message</span>
        <span className="text-zinc-400 font-mono truncate" title={selectedId}>{selectedId.slice(0, 8)}</span>
        <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-300 text-base leading-none" title="esc" aria-label="Close detail panel">✕</button>
      </div>
      {node && (
        <div className="px-3 py-2 border-b border-zinc-800 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={
                node.role === "assistant"
                  ? "text-amber-400 font-semibold"
                  : node.subtype === "prompt"
                    ? "text-emerald-400 font-semibold"
                    : "text-zinc-500"
              }
            >
              {node.role}{node.subtype ? `:${node.subtype}` : ""}
            </span>
            <span className="text-zinc-500">{new Date(node.timestamp).toLocaleString()}</span>
          </div>
          <div className="text-zinc-500 truncate" title={node.projectSlug}>{prettySlug(node.projectSlug)}</div>
          {sessionMeta && (
            <div className="text-zinc-600 font-mono">
              session {node.sessionId.slice(0, 8)} · {sessionMeta.nodeCount} nodes
              {node.sessionsIn > 1 ? ` · shared across ${node.sessionsIn} sessions` : ""}
            </div>
          )}
        </div>
      )}
      <div className="p-3 text-sm">
        {data ? (
          <Suspense fallback={<div className="text-zinc-500 italic">loading renderer…</div>}>
            <ContentRender data={data} />
          </Suspense>
        ) : (
          <div className="text-zinc-500">loading…</div>
        )}
      </div>
    </div>
  );
}

// ───── Help modal subcomponents ─────

function KbdGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function KbdRow({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex gap-1 w-40">
        {keys.map((k, i) => (
          <kbd key={i} className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300 font-mono">{k}</kbd>
        ))}
      </div>
      <span className="text-zinc-400">{desc}</span>
    </div>
  );
}

// Suppress unused-import warnings for ForestNode if not directly referenced
type _Unused = ForestNode;

function ContextMenuItems({
  target,
  layout,
  forest,
  size,
  activeSpace,
  spaces,
  onAddToSpace,
  onRemoveFromSpace,
  onNewCCSession,
  onContinueSession,
  animateTo,
  onZoomIn,
  onZoomOut,
  onSelect,
  onOpenInViewer,
  onResumeCLI,
  isBookmarked,
  onToggleBookmark,
  onClose,
}: {
  target: { kind: "node" | "session" | "empty"; id?: string };
  layout: Layout | null;
  forest: ForestPayload;
  size: { w: number; h: number };
  activeSpace: Space | null;
  spaces: Space[];
  onAddToSpace: (sessionId: string, spaceId: string) => void;
  onRemoveFromSpace: (sessionId: string, spaceId: string) => void;
  onNewCCSession: () => void;
  onContinueSession: (sessionId: string) => void;
  animateTo: (to: Transform, ms?: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSelect: (id: string) => void;
  onOpenInViewer: (sessionId: string) => void;
  onResumeCLI: (sessionId: string, fork: boolean) => void;
  isBookmarked: boolean;
  onToggleBookmark: (id: string) => void;
  onClose: () => void;
}) {
  const node = target.kind === "node" && target.id ? forest.nodes.find((n) => n.id === target.id) : null;
  const sessionId =
    target.kind === "node" ? node?.sessionId :
    target.kind === "session" ? target.id : undefined;
  const band = sessionId && layout ? layout.sessionBands.find((b) => b.sessionId === sessionId) : null;

  const copy = (text: string) => {
    try { void navigator.clipboard.writeText(text); } catch {}
    onClose();
  };

  return (
    <>
      {target.kind === "node" && node && target.id && (
        <>
          <MenuItem
            label="View message"
            onClick={() => { onSelect(target.id!); onClose(); }}
          />
          <MenuItem
            label="Zoom to message"
            onClick={() => {
              if (!layout) return;
              const ln = layout.nodes.get(target.id!);
              if (!ln) return;
              const r = 50;
              animateTo({
                scale: 4,
                tx: size.w / 2 - ln.x * 4,
                ty: size.h / 2 - ln.y * 4,
              }, 280);
              void r;
              onClose();
            }}
          />
        </>
      )}
      {(target.kind === "node" || target.kind === "session") && band && (
        <MenuItem
          label="Zoom to session"
          onClick={() => {
            animateTo(fitToBounds(band, size.w, size.h, 80));
            onClose();
          }}
        />
      )}
      {target.kind === "node" && target.id && (
        <MenuItem
          label={isBookmarked ? "★ Remove bookmark" : "☆ Bookmark this message"}
          onClick={() => { onToggleBookmark(target.id!); onClose(); }}
        />
      )}
      {sessionId && (
        <>
          <MenuDivider />
          <MenuItem
            label="✦ Continue this session (in map)"
            onClick={() => { onContinueSession(sessionId); onClose(); }}
          />
          <MenuItem
            label="Resume session in new terminal"
            onClick={() => { onResumeCLI(sessionId, false); onClose(); }}
          />
          <MenuItem
            label="Fork session (--fork-session)"
            onClick={() => { onResumeCLI(sessionId, true); onClose(); }}
          />
          <MenuItem
            label="Copy resume command"
            onClick={() => copy(`claude --resume ${sessionId}`)}
          />
          <MenuDivider />
          <MenuItem
            label="Open in viewer"
            onClick={() => onOpenInViewer(sessionId)}
          />
          <MenuItem
            label="Copy session ID"
            onClick={() => copy(sessionId)}
          />
          {/* Add to space submenu */}
          {spaces.length > 0 && (
            <>
              <MenuDivider />
              {activeSpace && activeSpace.sessionIds.includes(sessionId) ? (
                <MenuItem
                  label={`✕ Remove from "${activeSpace.name}"`}
                  onClick={() => { onRemoveFromSpace(sessionId, activeSpace.id); onClose(); }}
                />
              ) : (
                spaces.map((sp) => (
                  <MenuItem
                    key={sp.id}
                    label={`+ Add to "${sp.name}"`}
                    onClick={() => { onAddToSpace(sessionId, sp.id); onClose(); }}
                  />
                ))
              )}
            </>
          )}
        </>
      )}
      {target.kind === "node" && target.id && (
        <MenuItem
          label="Copy message UUID"
          onClick={() => copy(target.id!)}
        />
      )}
      {target.kind === "empty" && (
        <>
          <MenuItem label="✦ New Claude Code session" onClick={() => { onNewCCSession(); onClose(); }} />
          <MenuDivider />
          <MenuItem label="Zoom in here" onClick={() => { onZoomIn(); onClose(); }} />
          <MenuItem label="Zoom out" onClick={() => { onZoomOut(); onClose(); }} />
          <MenuDivider />
          <MenuItem
            label="Fit all"
            onClick={() => {
              if (layout) animateTo(fitTransform(layout, size.w, size.h));
              onClose();
            }}
          />
        </>
      )}
    </>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="w-full text-left px-3 py-1.5 hover:bg-zinc-800 text-zinc-200 block"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div className="h-px bg-zinc-800 my-1" />;
}

function VisToggle({
  label,
  color,
  on,
  onChange,
}: {
  label: string;
  color: string;
  on: boolean;
  onChange: () => void;
}) {
  return (
    <label className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer hover:bg-zinc-900 text-xs ${on ? "text-zinc-200" : "text-zinc-500"}`}>
      <input type="checkbox" checked={on} onChange={onChange} className="w-3 h-3 accent-zinc-400" />
      <span
        className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
        style={{ background: color, opacity: on ? 1 : 0.3 }}
      />
      <span className="truncate">{label}</span>
    </label>
  );
}
