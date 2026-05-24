import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type NodeResponse } from "../api.js";
import { useSse, type SseEvent } from "../sse.js";
import { useStore } from "../store.js";
import { buildLayout } from "../canvas/layout.js";
import {
  MAX_SCALE,
  MIN_SCALE,
  type Transform,
  fitToBounds,
  fitTransform,
  hitTest,
  lodOf,
  render,
} from "../canvas/renderer.js";
import { projectColor } from "../canvas/colors.js";
import { DEFAULT_VISIBILITY, type ForestNode, type ForestPayload, type Layout, type LayoutDirection, type ViewMode, type VisibilityFilter } from "../canvas/types.js";

const PAN_THRESHOLD_PX = 5;

export function TreeMap({ onClose }: { onClose: () => void }) {
  const [forest, setForest] = useState<ForestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("per-project");
  const [scopeProject, setScopeProject] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<NodeResponse | null>(null);
  const [hovered, setHovered] = useState<{ kind: "node" | "session"; id: string } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    target: { kind: "node" | "session" | "empty"; id?: string };
  } | null>(null);
  const selectSessionInViewer = useStore((s) => s.selectSession);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
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

  const [direction, setDirection] = useState<LayoutDirection>(() => {
    try {
      const raw = localStorage.getItem("cc-map-direction");
      if (raw === "grid" || raw === "column") return raw;
    } catch {}
    return "grid";
  });
  useEffect(() => {
    try { localStorage.setItem("cc-map-direction", direction); } catch {}
  }, [direction]);
  // Mark that direction changed so the next layout build triggers an auto-refit.
  const directionChangedRef = useRef(false);
  useEffect(() => {
    directionChangedRef.current = true;
  }, [direction]);
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

  const transformRef = useRef<Transform>({ tx: 0, ty: 0, scale: 1 });
  const dirtyRef = useRef(true);
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
        }, 250);
      }
    } else if (e.type === "active-session") {
      setForest((prev) => prev ? { ...prev, activeSessionId: e.sessionId, activeSessionAt: e.at } : prev);
    }
  }, []);
  useSse(onSse, fetchForest);

  // ───── Layout ─────
  const layout: Layout | null = useMemo(() => {
    if (!forest) return null;
    const t0 = performance.now();
    const l = buildLayout(forest, mode, mode === "per-project" ? scopeProject : null, visibility, direction);
    console.log(`layout: ${l.nodes.size} nodes, ${l.sessionBands.length} sessions in ${(performance.now() - t0).toFixed(0)}ms`);
    return l;
  }, [forest, mode, scopeProject, visibility, direction]);

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

  // ───── Initial fit + re-fit when direction changes ─────
  // Prefer the ACTIVE session (the one you're typing in right now) so the live
  // pulse is in view. Falls back to most-recent, then fit-all.
  // Direction switches (grid ↔ column) also force a re-fit to re-orient the user.
  const fittedKey = useRef<string>("");
  useEffect(() => {
    if (!layout || !forest) return;
    const key = `${mode}::${scopeProject}::${size.w}x${size.h}::${direction}`;
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
  }, [layout, mode, scopeProject, size, forest, effectiveActiveSession, direction]);

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
      // Animation
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
      // Continuously dirty when there's anything animated (live pulse, transition)
      if (transitionRef.current || liveTipId || effectiveActiveSession) {
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
          },
          cw,
          ch,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layout, size, selected, hovered, mode, matches, forest, liveTipId, effectiveActiveSession]);

  // ───── Mouse interactions ─────
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number; moved: boolean } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    transitionRef.current = null;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTx: transformRef.current.tx,
      startTy: transformRef.current.ty,
      moved: false,
    };
  }, []);

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
    } else if (layout) {
      const hit = hitTest(layout, transformRef.current, e.clientX - rect.left, e.clientY - rect.top);
      const next = hit ? { kind: hit.kind, id: hit.id } : null;
      const same = next && hovered && next.kind === hovered.kind && next.id === hovered.id;
      if (!same) {
        setHovered(next);
        e.currentTarget.style.cursor = hit ? "pointer" : "grab";
        dirtyRef.current = true;
      }
    }
  }, [layout, hovered]);

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved) return;
    if (!layout) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = hitTest(layout, transformRef.current, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    if (hit.kind === "node") {
      setSelected(hit.id);
    } else {
      // session band click → zoom to that session
      const band = layout.sessionBands.find((b) => b.sessionId === hit.id);
      if (band) animateTo(fitToBounds(band, size.w, size.h, 80));
    }
    dirtyRef.current = true;
  }, [layout, size]);

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
    const hit = hitTest(layout, transformRef.current, sx, sy);
    setContextMenu({
      x: sx,
      y: sy,
      target: hit ? { kind: hit.kind, id: hit.id } : { kind: "empty" },
    });
  }, [layout]);

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
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        if (e.key === "Escape") (document.activeElement as HTMLElement).blur();
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
          else if (selected) setSelected(null);
          else onClose();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, size, forest, selected, helpOpen, searchOpen, onClose, effectiveActiveSession, liveTipId, mode, scopeProject, toggleBookmark]);

  // ───── Tooltip data ─────
  const tooltipData = useMemo(() => {
    if (!hovered || !forest) return null;
    if (hovered.kind === "node") {
      const n = forest.nodes.find((x) => x.id === hovered.id);
      if (!n) return null;
      return {
        kind: "node" as const,
        title: n.role === "assistant" ? "assistant" : (n.subtype ?? "user"),
        body: n.preview || "(empty)",
        meta: `${new Date(n.timestamp).toLocaleString()} · ${n.sessionId.slice(0, 8)}`,
        color: n.role === "assistant" ? "#fbbf24" : n.subtype === "prompt" ? "#34d399" : "#71717a",
      };
    } else {
      const band = layout?.sessionBands.find((b) => b.sessionId === hovered.id);
      if (!band) return null;
      const sess = forest.nodes.find((x) => x.sessionId === hovered.id);
      return {
        kind: "session" as const,
        title: prettySlug(band.projectSlug),
        body: band.firstPrompt || "(no user prompt yet)",
        meta: `${band.sessionId.slice(0, 8)} · ${band.nodeCount} nodes`,
        color: projectColor(band.projectSlug),
        sess,
      };
    }
  }, [hovered, forest, layout]);

  if (error) {
    return <div className="flex-1 flex items-center justify-center text-red-400">{error}</div>;
  }
  if (!forest) {
    return <div className="flex-1 flex items-center justify-center text-zinc-500">loading forest…</div>;
  }

  return (
    <div className="flex-1 flex overflow-hidden relative">
      {/* Sidebar */}
      <div className="w-56 border-r border-zinc-800 bg-zinc-950 p-3 space-y-3 text-sm overflow-y-auto shrink-0">
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
        {mode === "per-project" && (
          <div>
            <div className="text-zinc-500 text-xs mb-1">Project ({forest.projects.length})</div>
            <div className="space-y-0.5 max-h-[60vh] overflow-y-auto">
              {[...forest.projects].sort((a, b) => b.sessionCount - a.sessionCount).map((p) => (
                <button
                  key={p.slug}
                  onClick={() => setScopeProject(p.slug)}
                  className={`w-full text-left px-2 py-1 rounded text-xs truncate flex items-center gap-2 ${scopeProject === p.slug ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800"}`}
                  title={p.slug}
                >
                  <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: projectColor(p.slug) }} />
                  <span className="truncate flex-1">{prettySlug(p.slug)}</span>
                  <span className="text-zinc-600 shrink-0">{p.sessionCount}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="pt-2 border-t border-zinc-800">
          <div className="text-zinc-500 text-xs mb-1">Layout</div>
          <div className="flex gap-1">
            {(["grid", "column"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDirection(d)}
                className={`px-2 py-1 rounded text-xs flex-1 ${direction === d ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
                title={d === "grid" ? "trees wrap into rows (square-ish)" : "each session on its own row, stacked top to bottom"}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="pt-2 border-t border-zinc-800">
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
        <div className="pt-2 border-t border-zinc-800">
          <div className="text-zinc-500 text-xs mb-1">Show</div>
          <VisToggle label="Prompts"        color="#34d399" on={visibility.prompt}        onChange={() => toggleVisibility("prompt")} />
          <VisToggle label="Replies"        color="#fbbf24" on={visibility.assistant}     onChange={() => toggleVisibility("assistant")} />
          <VisToggle label="Subagents"      color="#c084fc" on={visibility.subagent}      onChange={() => toggleVisibility("subagent")} />
          <VisToggle label="Tool results"   color="#52525b" on={visibility.toolResult}    onChange={() => toggleVisibility("toolResult")} />
          <VisToggle label="Slash commands" color="#71717a" on={visibility.slashCommand}  onChange={() => toggleVisibility("slashCommand")} />
          <VisToggle label="System reminders" color="#3f3f46" on={visibility.systemReminder} onChange={() => toggleVisibility("systemReminder")} />
        </div>
        <div className="text-xs text-zinc-500 pt-2 border-t border-zinc-800 space-y-1">
          {effectiveActiveSession && (() => {
            const liveBand = layout?.sessionBands.find((b) => b.sessionId === effectiveActiveSession);
            const liveProj = forest.nodes.find((n) => n.sessionId === effectiveActiveSession)?.projectSlug ?? "";
            const liveTitle = forest.sessionTitles?.[effectiveActiveSession]?.aiTitle;
            return (
              <button
                className="flex flex-col items-start gap-1 w-full text-left p-2 -mx-1 rounded hover:bg-zinc-900 border border-emerald-900/40"
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
              </button>
            );
          })()}
          {/* Bookmarks */}
          {bookmarks.size > 0 && (
            <div className="pt-2 border-t border-zinc-800">
              <div className="text-zinc-500 text-xs mb-1">★ Bookmarks ({bookmarks.size})</div>
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {[...bookmarks].map((bid) => {
                  const n = forest.nodes.find((x) => x.id === bid);
                  if (!n) return null;
                  return (
                    <button
                      key={bid}
                      className="w-full text-left px-1 py-0.5 rounded hover:bg-zinc-900 text-zinc-400 text-[10px] flex items-center gap-1"
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
                  );
                })}
              </div>
            </div>
          )}
          {/* Token totals across all projects */}
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
          <div>{layout?.nodes.size.toLocaleString() ?? 0} visible · {forest.nodes.length.toLocaleString()} total</div>
          <div>{forest.sessionCount} sessions · {forest.forks.length} forks</div>
          <button onClick={() => setHelpOpen(true)} className="mt-2 text-zinc-400 hover:text-zinc-200 underline">help (?)</button>
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

        {/* Tooltip — DOM overlay so it's always crisp + can show rich content */}
        {tooltipData && cursor && (
          <div
            className="absolute pointer-events-none z-20 bg-zinc-900/95 border border-zinc-700 rounded shadow-lg px-3 py-2 text-xs max-w-sm backdrop-blur"
            style={{
              left: Math.min(cursor.x + 14, (containerRef.current?.clientWidth ?? size.w) - 380),
              top: Math.min(cursor.y + 14, (containerRef.current?.clientHeight ?? size.h) - 100),
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ background: tooltipData.color }}
              />
              <span className="font-mono text-zinc-400">{tooltipData.title}</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-500 text-[10px]">{tooltipData.meta}</span>
            </div>
            <div className="text-zinc-200 leading-tight line-clamp-3">{tooltipData.body}</div>
          </div>
        )}

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
          <div className="absolute top-3 right-3 z-30 flex items-center gap-2 bg-zinc-900/95 border border-zinc-700 rounded px-2 py-1 backdrop-blur">
            <input
              autoFocus
              type="text"
              placeholder="search messages…"
              className="bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none w-64"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // Fit to all match nodes
                  if (matches && matches.size > 0 && layout) {
                    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
                    for (const id of matches) {
                      const n = layout.nodes.get(id);
                      if (!n) continue;
                      if (n.x < mnx) mnx = n.x;
                      if (n.y < mny) mny = n.y;
                      if (n.x > mxx) mxx = n.x;
                      if (n.y > mxy) mxy = n.y;
                    }
                    if (mxx > mnx) animateTo(fitToBounds({ minX: mnx, minY: mny, maxX: mxx, maxY: mxy }, size.w, size.h, 80));
                  }
                }
              }}
            />
            <span className="text-xs text-zinc-500 font-mono">
              {matches ? `${matches.size} match${matches.size === 1 ? "" : "es"}` : ""}
            </span>
            <button
              className="text-zinc-500 hover:text-zinc-200 text-xs px-1"
              onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
              title="esc"
            >
              ✕
            </button>
          </div>
        )}

        {/* LOD indicator (subtle, top-center) */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 text-xs text-zinc-500 font-mono pointer-events-none bg-zinc-900/70 backdrop-blur rounded px-2 py-0.5">
          {lodOf(transformRef.current.scale)}
        </div>
      </div>

      {/* Side detail panel */}
      {selected && (
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
                    alert(`Manual launch needed.\nCommand copied to clipboard:\n  ${r.command}`);
                  }
                })
                .catch((e) => alert(`Resume failed: ${e}`));
            }}
            isBookmarked={contextMenu.target.kind === "node" && contextMenu.target.id ? bookmarks.has(contextMenu.target.id) : false}
            onToggleBookmark={(id) => toggleBookmark(id)}
            onClose={() => setContextMenu(null)}
          />
        </div>
      )}

      {/* Help modal */}
      {helpOpen && (
        <div
          className="absolute inset-0 z-40 bg-zinc-950/80 backdrop-blur flex items-center justify-center"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-md text-sm space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-zinc-100 font-semibold text-base mb-2">cc-map — tree-map controls</div>
            <KbdGroup title="Navigation">
              <KbdRow keys={["drag"]} desc="pan" />
              <KbdRow keys={["2-finger scroll"]} desc="pan (trackpad)" />
              <KbdRow keys={["ctrl", "+", "wheel"]} desc="zoom (or pinch)" />
              <KbdRow keys={["="]} desc="zoom in" />
              <KbdRow keys={["−"]} desc="zoom out" />
            </KbdGroup>
            <KbdGroup title="View">
              <KbdRow keys={["0", "f"]} desc="fit all" />
              <KbdRow keys={["1"]} desc="fit most recent session" />
              <KbdRow keys={["double-click"]} desc="zoom in 2× at cursor" />
              <KbdRow keys={["right-click"]} desc="context menu" />
            </KbdGroup>
            <KbdGroup title="Selection">
              <KbdRow keys={["↑", "↓"]} desc="prev/next node in session" />
              <KbdRow keys={["←", "→"]} desc="prev/next node in session" />
              <KbdRow keys={["space"]} desc="jump to live tip (the message being written right now)" />
              <KbdRow keys={["b"]} desc="bookmark the selected node" />
            </KbdGroup>
            <KbdGroup title="CLI integration (right-click any node)">
              <KbdRow keys={["right-click"]} desc="resume / fork / copy command for that session" />
            </KbdGroup>
            <KbdGroup title="Search & navigation">
              <KbdRow keys={["/"]} desc="search messages" />
              <KbdRow keys={["enter"]} desc="(in search) fit to matches" />
              <KbdRow keys={["esc"]} desc="close panel / search / back to viewer" />
              <KbdRow keys={["?"]} desc="toggle this help" />
            </KbdGroup>
            <div className="text-xs text-zinc-500 pt-3 border-t border-zinc-800">
              Semantic zoom: at low zoom you see sessions as colored ribbons (one per session, color = project). Zoom in to see individual messages.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───── Helpers ─────

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function prettySlug(s: string): string {
  return s.replace(/^C--Users-[^-]+-/, "~/").replace(/-+/g, "/");
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
    <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 bg-zinc-900/85 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 font-mono backdrop-blur">
      <button className="px-1.5 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700" onClick={() => onZoomChange(1 / 1.5)} title="−">−</button>
      <span className="w-12 text-center">{(t.scale * 100).toFixed(0)}%</span>
      <button className="px-1.5 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700" onClick={() => onZoomChange(1.5)} title="=">+</button>
      <button className="px-2 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700 ml-2" onClick={onFitRecent} title="1">recent</button>
      <button className="px-2 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700" onClick={onFitAll} title="0 / f">all</button>
    </div>
  );
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
        >
          ←
        </button>
        <button
          onClick={() => nextId && onNavigate(nextId)}
          disabled={!nextId}
          className="px-2 py-0.5 bg-zinc-800 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-zinc-800"
          title="next in session"
        >
          →
        </button>
        <span className="text-zinc-600">message</span>
        <span className="text-zinc-400 font-mono truncate" title={selectedId}>{selectedId.slice(0, 8)}</span>
        <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-300 text-base leading-none" title="esc">✕</button>
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
        {data ? <ContentRender data={data} /> : <div className="text-zinc-500">loading…</div>}
      </div>
    </div>
  );
}

function ContentRender({ data }: { data: NodeResponse }) {
  const raw = data.raw as { message?: { content?: unknown } } | null;
  const content = raw?.message?.content;
  if (typeof content === "string") {
    return (
      <div className="md-body text-zinc-200">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2 text-zinc-200">
        {content.map((block, i) => <BlockRender key={i} block={block} />)}
      </div>
    );
  }
  return <div className="text-zinc-500 italic">(empty)</div>;
}

function BlockRender({ block }: { block: unknown }) {
  if (!block || typeof block !== "object") {
    return <pre className="text-xs text-zinc-500">{JSON.stringify(block, null, 2)}</pre>;
  }
  const b = block as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };
  if (b.type === "text" && typeof b.text === "string") {
    return <div className="md-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown></div>;
  }
  if (b.type === "tool_use") {
    return (
      <details className="border border-blue-900/50 bg-blue-950/20 rounded p-2 text-xs">
        <summary className="cursor-pointer text-blue-400 font-mono">🔧 {b.name ?? "tool"}</summary>
        <pre className="mt-2 overflow-x-auto text-blue-200">{JSON.stringify(b.input, null, 2)}</pre>
      </details>
    );
  }
  if (b.type === "tool_result") {
    const text =
      typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n")
          : "";
    return (
      <details className="border border-zinc-800 bg-zinc-900/40 rounded p-2 text-xs">
        <summary className="cursor-pointer text-zinc-400 font-mono">📨 tool_result</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-zinc-300">{text}</pre>
      </details>
    );
  }
  return <pre className="text-xs text-zinc-500">{JSON.stringify(block, null, 2)}</pre>;
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
