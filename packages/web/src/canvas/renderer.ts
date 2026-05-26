import {
  EDGE_COLOR,
  EDGE_FORK_COLOR,
  NODE_RING_FORK,
  NODE_RING_SELECTED,
  buildColorContext,
  colorForNode,
  nodeColor,
  projectColor,
  type ColorContext,
} from "./colors.js";
import { LAYOUT, type BackgroundStyle, type ColorMode, type Layout, type LayoutNode, type NodeStyle, type SessionBand, type ViewMode } from "./types.js";
import { timelineNowY } from "./layout.js";

// Draw dashed sequence links between same-session disconnected roots.
function drawSequenceLinks(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  if (layout.sequenceLinks.length === 0) return;
  const scale = state.transform.scale;
  ctx.lineWidth = Math.max(1, 1.5 / scale);
  const dash = 8 / scale;
  const gap = 4 / scale;
  ctx.setLineDash([dash, gap]);
  for (const link of layout.sequenceLinks) {
    const from = layout.nodes.get(link.fromId);
    const to = layout.nodes.get(link.toId);
    if (!from || !to) continue;
    if (Math.max(from.x, to.x) < view.x0 || Math.min(from.x, to.x) > view.x1) continue;
    if (Math.max(from.y, to.y) < view.y0 || Math.min(from.y, to.y) > view.y1) continue;
    ctx.strokeStyle = projectColor(link.projectSlug);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    // Gentle curve toward the next root
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2 + Math.abs(to.x - from.x) * 0.2;
    ctx.quadraticCurveTo(cx, cy, to.x, to.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export interface Transform {
  /** Pan x in screen pixels. */
  tx: number;
  /** Pan y in screen pixels. */
  ty: number;
  /** Zoom factor; 1.0 = layout pixels == screen pixels. */
  scale: number;
}

export interface RenderState {
  transform: Transform;
  selectedId: string | null;
  hoveredId: string | null;
  hoveredSessionId: string | null;
  highlightedNodeIds: Set<string> | null; // search results
  mode: ViewMode;
  /** Currently-active Claude Code session — gets a "● live" highlight. */
  activeSessionId: string | null;
  /** Latest message uuid in the active session — gets a pulse ring. */
  liveTipId: string | null;
  /** Monotonic ms timestamp used to animate the pulse. */
  nowMs: number;
  /** Render each node as a text card instead of a dot. */
  nodeStyle: NodeStyle;
  /** How nodes are colored — role, recency heat-map, or cost heat-map. */
  colorMode: ColorMode;
  /** When true, subagent nodes are hidden — and we draw a "+N subagents"
   *  badge on each parent that would expand into one. */
  subagentsCollapsed: boolean;
  /** Set of node ids currently in the multi-select set (ctrl/cmd+click).
   *  Drawn with a cyan outline distinct from hover/select. */
  multiSelectedIds: Set<string> | null;
  /** Performance.now() at which the current selection was made. Used to draw
   *  a one-shot "spotlight ping" expanding ring at the selected node. */
  selectionPingMs: number | null;
  /** Canvas background pattern. "none" = flat zinc-950; otherwise a faint
   *  world-space grid/dot field so you can feel pan/zoom even in empty areas. */
  backgroundStyle: BackgroundStyle;
}

/**
 * Semantic-zoom LOD thresholds.
 *
 * - OVERVIEW (scale < 0.15): sessions drawn as solid rects, project-colored.
 *   No individual nodes. Fork edges only (sparse). Session titles, project labels.
 *
 * - SESSION (0.15 <= scale < 0.6): session rects fade, density strips appear
 *   inside each band. Edges of all kinds, but still no individual nodes.
 *
 * - DETAIL (scale >= 0.6): full per-node rendering with colors and hover labels.
 */
const LOD_OVERVIEW_MAX = 0.15;
const LOD_SESSION_MAX = 0.6;

export function lodOf(scale: number): "overview" | "session" | "detail" {
  if (scale < LOD_OVERVIEW_MAX) return "overview";
  if (scale < LOD_SESSION_MAX) return "session";
  return "detail";
}

/**
 * Render the layout to a 2D canvas. Caller controls the requestAnimationFrame loop
 * — this function is synchronous, idempotent, called only when the scene is dirty.
 */
export function render(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  viewportWidth: number,
  viewportHeight: number,
): void {
  const { transform } = state;
  const lod = lodOf(transform.scale);
  const dpr = window.devicePixelRatio || 1;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#09090b";
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  ctx.translate(transform.tx, transform.ty);
  ctx.scale(transform.scale, transform.scale);

  const margin = 100 / transform.scale;
  const view = {
    x0: -transform.tx / transform.scale - margin,
    y0: -transform.ty / transform.scale - margin,
    x1: (viewportWidth - transform.tx) / transform.scale + margin,
    y1: (viewportHeight - transform.ty) / transform.scale + margin,
  };

  // Background pattern (world-space so it pans/zooms with the map). Spacing
  // adapts to scale: at very low zoom we'd draw millions of lines, so we
  // bump the pitch up by factors of 5/10.
  if (state.backgroundStyle !== "none") {
    drawBackgroundPattern(ctx, state.backgroundStyle, transform.scale, view);
  }

  // ───── Project hulls (subtle background per project) ─────
  // Each hull covers ONLY that project's actual Y range. Without this, projects
  // wrapping to different rows had hulls covering the full layout height and
  // stacked on top of each other — the muddy mess from the all-projects screenshot.
  if (state.mode === "all-projects" && layout.projectBands.size > 1) {
    const pad = 20;
    for (const [slug, band] of layout.projectBands) {
      if (band.maxX < view.x0 || band.minX > view.x1) continue;
      if (band.maxY < view.y0 || band.minY > view.y1) continue;
      ctx.fillStyle = projectColor(slug);
      ctx.globalAlpha = lod === "overview" ? 0.15 : 0.06;
      ctx.fillRect(
        band.minX - pad,
        band.minY - pad,
        band.maxX - band.minX + pad * 2,
        band.maxY - band.minY + pad * 2,
      );
      ctx.globalAlpha = 1;
    }
  }

  // Color context for heat-map modes (cheap to build per-frame; nodes is a Map)
  const colorCtx = buildColorContext(layout.nodes.values());

  // ───── Render the appropriate LOD ─────
  if (lod === "overview") {
    renderOverview(ctx, layout, state, view);
  } else if (lod === "session") {
    renderSession(ctx, layout, state, view, colorCtx);
  } else {
    renderDetail(ctx, layout, state, view, colorCtx);
  }

  // ───── Off-screen live-tip indicator (screen-space, drawn while world transform is active) ─────
  // Computed inside the transformed pass so we can still reference layout coords,
  // but the arrow itself is drawn after restore() below.
  let offscreenLiveScreen: { sx: number; sy: number } | null = null;
  if (state.liveTipId) {
    const tip = layout.nodes.get(state.liveTipId);
    if (tip) {
      const sx = tip.x * transform.scale + transform.tx;
      const sy = tip.y * transform.scale + transform.ty;
      const margin = 24;
      if (sx < margin || sx > viewportWidth - margin || sy < margin || sy > viewportHeight - margin) {
        offscreenLiveScreen = { sx, sy };
      }
    }
  }

  // ───── Project labels (in all-projects mode) ─────
  // Each label sits at its project's actual top — not at layout.bounds.minY
  // (which was making all 15 labels overlap on the same line).
  if (state.mode === "all-projects") {
    const fontPx = 13 / transform.scale;
    ctx.font = `bold ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "alphabetic";
    for (const [slug, band] of layout.projectBands) {
      if (band.maxX < view.x0 || band.minX > view.x1) continue;
      if (band.maxY < view.y0 || band.minY > view.y1) continue;
      ctx.fillStyle = projectColor(slug);
      ctx.fillText(
        prettySlug(slug),
        band.minX + 4 / transform.scale,
        band.minY - 8 / transform.scale,
      );
    }
  }

  // ───── Timeline now-line for the active session ─────
  // Drawn inside the world transform so coordinates line up with nodes;
  // pulses emerald to read as "you are here, now."
  if (state.activeSessionId && layout.timelineAnchors) {
    const anchor = layout.timelineAnchors.get(state.activeSessionId);
    if (anchor) {
      const nowY = timelineNowY(anchor, state.nowMs);
      // Only draw if it's vertically inside (or just past) the viewport
      if (nowY > view.y0 && nowY < view.y1) {
        const pulse = 0.5 + 0.5 * Math.sin(state.nowMs / 350);
        ctx.strokeStyle = `rgba(52, 211, 153, ${0.5 + 0.4 * pulse})`;
        ctx.lineWidth = Math.max(1, 1.5 / transform.scale);
        ctx.setLineDash([6 / transform.scale, 4 / transform.scale]);
        ctx.beginPath();
        ctx.moveTo(anchor.x - 8 / transform.scale, nowY);
        ctx.lineTo(anchor.xRight + 8 / transform.scale, nowY);
        ctx.stroke();
        ctx.setLineDash([]);
        // Tiny "now" pill on the right edge
        const labelFont = 10 / transform.scale;
        ctx.font = `bold ${labelFont}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const labelText = "NOW";
        const lpad = 4 / transform.scale;
        const lw = ctx.measureText(labelText).width + lpad * 2;
        const lh = labelFont + 4 / transform.scale;
        ctx.fillStyle = `rgba(52, 211, 153, ${0.7 + 0.3 * pulse})`;
        roundRect(ctx, anchor.xRight + 4 / transform.scale, nowY - lh / 2, lw, lh, lh / 2);
        ctx.fill();
        ctx.fillStyle = "#06251a";
        ctx.fillText(labelText, anchor.xRight + 4 / transform.scale + lpad, nowY);
      }
    }
  }

  ctx.restore();

  // ───── Subtle radial vignette (screen-space) ─────
  // Faint darkening at viewport corners — gives the canvas depth and signals
  // "you can pan beyond this view" without explicit chrome. Cheap: one
  // radial gradient draw per frame.
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vw = viewportWidth;
  const vh = viewportHeight;
  const cx = vw / 2;
  const cy = vh / 2;
  const vignetteR0 = Math.min(vw, vh) * 0.45;
  const vignetteR1 = Math.max(vw, vh) * 0.8;
  const vg = ctx.createRadialGradient(cx, cy, vignetteR0, cx, cy, vignetteR1);
  vg.addColorStop(0, "rgba(0, 0, 0, 0)");
  vg.addColorStop(1, "rgba(0, 0, 0, 0.55)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, vw, vh);
  ctx.restore();

  // ───── Sticky session labels (screen-space) ─────
  // When you pan deep into a tall session, its label scrolled off the top edge,
  // so you lose context for "what session am I in." Pin the label to the
  // viewport top whenever the band's top is above the viewport but the band
  // is still partially visible. Only fires at session/detail LOD where
  // individual session orientation matters.
  if (lod !== "overview") {
    drawStickySessionLabels(ctx, layout, transform, state, viewportWidth, viewportHeight, dpr);
  }

  // ───── Screen-space overlay: off-screen live-tip arrow ─────
  // Drawn after restore so its size is in CSS pixels regardless of zoom.
  // Pulses emerald like the on-canvas live tip; points toward the live message
  // when it's outside the viewport, with a short label "live →".
  if (offscreenLiveScreen) {
    drawOffscreenLiveArrow(ctx, offscreenLiveScreen, state.nowMs, viewportWidth, viewportHeight, dpr);
  }
}

/**
 * Where the off-screen live arrow lands on the viewport edge — used by hit-testing
 * in TreeMap.tsx so clicking it pans-to-live. Returns null if the live tip is on-screen
 * or there's no live tip. Keep this in sync with drawOffscreenLiveArrow's math.
 */
export function getOffscreenLiveArrowBox(
  layout: Layout,
  transform: Transform,
  liveTipId: string | null,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!liveTipId) return null;
  const tip = layout.nodes.get(liveTipId);
  if (!tip) return null;
  const sx = tip.x * transform.scale + transform.tx;
  const sy = tip.y * transform.scale + transform.ty;
  const margin = 24;
  if (sx >= margin && sx <= viewportWidth - margin && sy >= margin && sy <= viewportHeight - margin) {
    return null;
  }
  const { ex, ey } = clampToEdge(sx, sy, viewportWidth, viewportHeight, 36);
  const size = 44;
  return { x: ex - size / 2, y: ey - size / 2, w: size, h: size };
}

/**
 * Hit-test the subagent "+N" badges in screen coordinates. Returns the parent
 * uuid whose badge was clicked, or null. Mirrors drawSubagentBadges' layout
 * math so click targets match what the user sees.
 */
export function getSubagentBadgeAt(
  layout: Layout,
  transform: Transform,
  subagentsCollapsed: boolean,
  nodeStyle: NodeStyle,
  screenX: number,
  screenY: number,
): string | null {
  if (!subagentsCollapsed) return null;
  if (layout.subagentCountByParent.size === 0) return null;
  const cardMode = nodeStyle === "cards";
  // Replicate font setup in a measurement-only canvas via a transient ctx is
  // expensive; use a conservative width estimate per digit instead.
  // Approximation: ~6.5 screen px per char for the 9px bold font.
  const PER_CHAR_PX = 6.5;
  const hPx = cardMode ? 14 : 14;
  for (const [parentId, count] of layout.subagentCountByParent) {
    const n = layout.nodes.get(parentId);
    if (!n) continue;
    const sx = n.x * transform.scale + transform.tx;
    const sy = n.y * transform.scale + transform.ty;
    const text = `+${count}`;
    const wPx = text.length * PER_CHAR_PX + 8;
    let bx: number;
    let by: number;
    if (cardMode) {
      // Top-right corner of the card
      bx = sx + LAYOUT.cardWidth * transform.scale - wPx - 4;
      by = sy + 4;
    } else {
      // Right of the dot
      const rPx = Math.max(LAYOUT.nodeRadius, 2.5 / transform.scale) * transform.scale + 4;
      bx = sx + rPx;
      by = sy - hPx / 2;
    }
    if (screenX >= bx && screenX <= bx + wPx && screenY >= by && screenY <= by + hPx) {
      return parentId;
    }
  }
  return null;
}

function clampToEdge(
  sx: number,
  sy: number,
  vw: number,
  vh: number,
  pad: number,
): { ex: number; ey: number } {
  const cx = vw / 2;
  const cy = vh / 2;
  const dx = sx - cx;
  const dy = sy - cy;
  if (dx === 0 && dy === 0) return { ex: cx, ey: cy };
  // Scale (dx, dy) so it lands on the inner rect (vw-2*pad × vh-2*pad)
  const tx = dx === 0 ? Infinity : (vw / 2 - pad) / Math.abs(dx);
  const ty = dy === 0 ? Infinity : (vh / 2 - pad) / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { ex: cx + dx * t, ey: cy + dy * t };
}

function drawOffscreenLiveArrow(
  ctx: CanvasRenderingContext2D,
  tipScreen: { sx: number; sy: number },
  nowMs: number,
  viewportWidth: number,
  viewportHeight: number,
  dpr: number,
): void {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { ex, ey } = clampToEdge(tipScreen.sx, tipScreen.sy, viewportWidth, viewportHeight, 36);
  const angle = Math.atan2(tipScreen.sy - viewportHeight / 2, tipScreen.sx - viewportWidth / 2);
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 280);
  const alpha = 0.7 + 0.3 * pulse;

  // Outer ring (interactive target zone)
  ctx.fillStyle = `rgba(9, 9, 11, 0.85)`;
  ctx.strokeStyle = `rgba(52, 211, 153, ${alpha})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(ex, ey, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Inner arrow pointing toward live tip
  ctx.translate(ex, ey);
  ctx.rotate(angle);
  ctx.fillStyle = `#34d399`;
  ctx.beginPath();
  ctx.moveTo(10, 0);
  ctx.lineTo(-4, -7);
  ctx.lineTo(-4, 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // "live" label below/beside
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#34d399";
  // Place label inside the viewport: nudge toward center if at an edge
  const labelOffset = 32;
  const lx = ex + (viewportWidth / 2 - ex) * 0.07;
  const ly = ey + (viewportHeight / 2 - ey) * 0.07 + (ey < viewportHeight / 2 ? labelOffset : -labelOffset);
  ctx.fillText("LIVE", lx, ly);
  ctx.restore();
}

// ───── LOD renderers ─────

function renderOverview(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  const scale = state.transform.scale;
  // Sessions as rounded rectangles, colored by project.
  for (const band of layout.sessionBands) {
    if (!intersects(band, view)) continue;
    const w = band.maxX - band.minX;
    const h = band.maxY - band.minY;
    const isHover = band.sessionId === state.hoveredSessionId;
    const isActive = band.sessionId === state.activeSessionId;
    const fill = projectColor(band.projectSlug);
    ctx.globalAlpha = isHover || isActive ? 1 : 0.85;
    ctx.fillStyle = fill;
    roundRect(ctx, band.minX, band.minY, w, h, Math.min(6, w / 2, h / 2));
    ctx.fill();
    if (isActive) {
      // Pulsing live-session border
      const pulse = 0.5 + 0.5 * Math.sin(state.nowMs / 350);
      ctx.strokeStyle = `rgba(52, 211, 153, ${0.5 + 0.5 * pulse})`; // emerald, pulsing
      ctx.lineWidth = Math.max(2, 3 / scale);
      ctx.stroke();
    } else if (isHover) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2 / scale;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  drawTimelineRails(ctx, layout, state, view);
  // Fork edges (rare, important): show even at overview LOD so branches are obvious.
  drawForkEdges(ctx, layout, state, view, /*alpha=*/ 0.9);
  drawSequenceLinks(ctx, layout, state, view);
  drawLiveTip(ctx, layout, state);
  // Session labels (screen-constant font)
  drawSessionLabels(ctx, layout, state, view, /*minBandPx=*/ 24);
}

function renderSession(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  colorCtx: ColorContext,
): void {
  const scale = state.transform.scale;
  // Session bands with lower opacity (a backdrop for the density rendering)
  for (const band of layout.sessionBands) {
    if (!intersects(band, view)) continue;
    const w = band.maxX - band.minX;
    const h = band.maxY - band.minY;
    const isHover = band.sessionId === state.hoveredSessionId;
    ctx.globalAlpha = isHover ? 0.5 : 0.25;
    ctx.fillStyle = projectColor(band.projectSlug);
    roundRect(ctx, band.minX, band.minY, w, h, Math.min(4, w / 2, h / 2));
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  drawTimelineRails(ctx, layout, state, view);
  drawCompactMarkers(ctx, layout, state, view, /*cardMode=*/ false);
  // Edges in muted colors
  drawEdges(ctx, layout, state, view, /*alpha=*/ 0.35);
  drawForkEdges(ctx, layout, state, view, /*alpha=*/ 0.85);
  drawSequenceLinks(ctx, layout, state, view);
  // Nodes as small dots (constant ~2 screen px), no labels yet
  const r = Math.max(LAYOUT.nodeRadius * 0.6, 1.5 / scale);
  for (const n of layout.nodes.values()) {
    if (n.x + r < view.x0 || n.x - r > view.x1) continue;
    if (n.y + r < view.y0 || n.y - r > view.y1) continue;
    const isHi = state.highlightedNodeIds?.has(n.id);
    ctx.fillStyle = isHi ? "#ffffff" : colorForNode(n, state.colorMode, colorCtx);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  drawSessionSparklines(ctx, layout, state, view);
  drawSessionLabels(ctx, layout, state, view, /*minBandPx=*/ 18);
  drawSelectionAndHover(ctx, layout, state);
  drawSelectionSpotlight(ctx, layout, state);
  drawLiveTip(ctx, layout, state);
}

function drawTimelineRails(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  if (!layout.timelineAnchors) return;
  const scale = state.transform.scale;
  ctx.save();
  ctx.lineWidth = Math.max(1, 1 / scale);
  for (const band of layout.sessionBands) {
    if (!intersects(band, view)) continue;
    const anchor = layout.timelineAnchors.get(band.sessionId);
    if (!anchor) continue;
    const railX = state.nodeStyle === "cards" ? anchor.x - 14 : anchor.x;
    const inViewX0 = state.nodeStyle === "cards" ? railX - 8 / scale : railX - 2 / scale;
    const inViewX1 = state.nodeStyle === "cards" ? anchor.xRight : railX + 2 / scale;
    if (inViewX1 < view.x0 || inViewX0 > view.x1) continue;
    const isActive = band.sessionId === state.activeSessionId;
    const isHover = band.sessionId === state.hoveredSessionId;
    ctx.strokeStyle = projectColor(band.projectSlug);
    ctx.globalAlpha = isActive ? 0.5 : isHover ? 0.38 : 0.2;
    ctx.beginPath();
    ctx.moveTo(railX, band.minY);
    ctx.lineTo(railX, band.maxY);
    ctx.stroke();
    ctx.globalAlpha = isActive ? 0.35 : 0.16;
    ctx.beginPath();
    ctx.arc(railX, band.minY, 4 / scale, 0, Math.PI * 2);
    ctx.fillStyle = projectColor(band.projectSlug);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawCompactMarkers(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  cardMode: boolean,
): void {
  const compactNodes = [...layout.nodes.values()].filter((n) => n.isCompactBoundary);
  if (compactNodes.length === 0) return;
  const scale = state.transform.scale;
  const labelFont = cardMode ? Math.min(10, 11 / scale) : Math.max(8, 10 / scale);
  ctx.save();
  ctx.font = `bold ${labelFont}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.setLineDash([8 / scale, 5 / scale]);
  for (const n of compactNodes) {
    const band = layout.sessionBands.find((b) => b.sessionId === n.sessionId);
    if (!band) continue;
    const y = n.y - (cardMode ? 8 / scale : 0);
    if (y < view.y0 || y > view.y1) continue;
    if (band.maxX < view.x0 || band.minX > view.x1) continue;
    const x0 = Math.max(band.minX, view.x0);
    const x1 = Math.min(band.maxX, view.x1);
    ctx.strokeStyle = "rgba(244, 114, 182, 0.9)";
    ctx.lineWidth = Math.max(1.25, 2 / scale);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = "COMPACTED";
    const padX = 5 / scale;
    const pillH = Math.max(14 / scale, labelFont + 4 / scale);
    const labelX = Math.min(Math.max(n.x + 6 / scale, x0), Math.max(x0, x1 - 70 / scale));
    const labelW = ctx.measureText(label).width + padX * 2;
    ctx.fillStyle = "rgba(244, 114, 182, 0.92)";
    roundRect(ctx, labelX, y - pillH / 2, labelW, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = "#190816";
    ctx.fillText(label, labelX + padX, y);
    ctx.setLineDash([8 / scale, 5 / scale]);
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function renderDetail(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  colorCtx: ColorContext,
): void {
  const scale = state.transform.scale;
  // Card mode dispatches to a completely different render
  if (state.nodeStyle === "cards") {
    renderCards(ctx, layout, state, view, colorCtx);
    return;
  }
  // Faint session backgrounds for visual grouping; active session gets a brighter tint
  for (const band of layout.sessionBands) {
    if (!intersects(band, view)) continue;
    const w = band.maxX - band.minX;
    const h = band.maxY - band.minY;
    const isHover = band.sessionId === state.hoveredSessionId;
    const isActive = band.sessionId === state.activeSessionId;
    ctx.globalAlpha = isActive ? 0.22 : isHover ? 0.18 : 0.06;
    ctx.fillStyle = projectColor(band.projectSlug);
    roundRect(ctx, band.minX, band.minY, w, h, Math.min(4, w / 2, h / 2));
    ctx.fill();
    if (isActive) {
      // Pulsing emerald outline so "you are here" is obvious even when zoomed in
      const pulse = 0.5 + 0.5 * Math.sin(state.nowMs / 350);
      ctx.strokeStyle = `rgba(52, 211, 153, ${0.4 + 0.4 * pulse})`;
      ctx.lineWidth = Math.max(1.5, 2 / state.transform.scale);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  drawTimelineRails(ctx, layout, state, view);
  drawCompactMarkers(ctx, layout, state, view, /*cardMode=*/ false);
  drawEdges(ctx, layout, state, view, /*alpha=*/ 1);
  drawForkEdges(ctx, layout, state, view, /*alpha=*/ 1);
  drawSequenceLinks(ctx, layout, state, view);
  // Nodes — size varies by classification so the prompt → assistant chain
  // visually dominates the tool-result/slash noise.
  const baseR = Math.max(LAYOUT.nodeRadius, 2.5 / scale);
  for (const n of layout.nodes.values()) {
    const sizeMul = nodeSizeMul(n.role, n.subtype);
    const r = baseR * sizeMul;
    if (n.x + r < view.x0 || n.x - r > view.x1) continue;
    if (n.y + r < view.y0 || n.y - r > view.y1) continue;
    const isHi = state.highlightedNodeIds?.has(n.id);
    const color = colorForNode(n, state.colorMode, colorCtx);
    drawDotNode(ctx, n, r, scale, isHi ? "#fafafa" : color);
    if (n.isFork) {
      ctx.strokeStyle = NODE_RING_FORK;
      ctx.lineWidth = Math.max(1.5, 2 / scale);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + Math.max(2, 3 / scale), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (isHi) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(2, 2 / scale);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + Math.max(3, 4 / scale), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  drawSessionSparklines(ctx, layout, state, view);
  if (state.subagentsCollapsed) drawSubagentBadges(ctx, layout, state, view, /*cardMode=*/ false);
  drawTimelineGapLabels(ctx, layout, state, view, /*cardMode=*/ false);
  drawMultiSelect(ctx, layout, state, /*cardMode=*/ false);
  drawSessionLabels(ctx, layout, state, view, /*minBandPx=*/ 12);
  // Inline node text labels (only when zoomed in enough — and capped to avoid clutter)
  if (scale >= 1.5) {
    drawInlineNodeLabels(ctx, layout, state, view);
  }
  drawSelectionAndHover(ctx, layout, state);
  drawSelectionSpotlight(ctx, layout, state);
  drawLiveTip(ctx, layout, state);
}

/**
 * Draw a short preview string to the RIGHT of each visible node.
 *
 * No auto-reflow / staircase: positions are deterministic in layout coords,
 * so labels don't jump around as you zoom. In cramped rows (multiple nodes
 * close together on the same Y), labels that don't fit are simply skipped —
 * hover for the full text on those.
 */
function drawInlineNodeLabels(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  const scale = state.transform.scale;
  const fontPx = 11 / scale;
  ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  const baseR = Math.max(LAYOUT.nodeRadius, 2.5 / scale);
  const padX = 6 / scale;
  const padY = 2 / scale;
  const MAX_LABELS = scale >= 2.5 ? 260 : 140;
  // Below this much horizontal room (in screen pixels), don't even try.
  const MIN_LABEL_PX = 60;
  const MAX_LABEL_PX = scale >= 2.5 ? 260 : 180;

  // Pre-bucket by Y so we can find each node's horizontal next-neighbor cheaply.
  const yBucket = (y: number) => Math.round(y / 4) * 4;
  const byY = new Map<number, typeof layout.nodes extends Map<infer _K, infer V> ? V[] : never>();
  for (const n of layout.nodes.values()) {
    if (n.x < view.x0 || n.x > view.x1 || n.y < view.y0 || n.y > view.y1) continue;
    if (!n.preview) continue;
    if (!shouldInlineLabel(n, state)) continue;
    const k = yBucket(n.y);
    let arr = byY.get(k);
    if (!arr) {
      arr = [];
      byY.set(k, arr);
    }
    arr.push(n);
  }

  let count = 0;
  for (const nodes of byY.values()) {
    if (count >= MAX_LABELS) return;
    nodes.sort((a, b) => a.x - b.x);
    for (let i = 0; i < nodes.length; i++) {
      if (count >= MAX_LABELS) return;
      const n = nodes[i];
      if (!n) continue;
      const r = baseR * nodeSizeMul(n.role, n.subtype);
      const nextN = nodes[i + 1];
      // Room available (in layout units) before the next node on this row
      const availLayout = nextN
        ? Math.max(0, nextN.x - n.x - r - (baseR * nodeSizeMul(nextN.role, nextN.subtype)) - padX * 2)
        : Infinity;
      if (availLayout * scale < MIN_LABEL_PX) continue; // too cramped → skip

      const text = n.isSessionStart ? `new session: ${n.preview}` : n.preview;
      const maxLayoutWidth = Math.min(availLayout, MAX_LABEL_PX / scale);
      if (maxLayoutWidth * scale < MIN_LABEL_PX) continue;
      const labelText = ellipsizeToWidth(ctx, text, maxLayoutWidth);
      const visibleWidth = ctx.measureText(labelText).width;
      const labelX = n.x + r + padX;
      const labelY = n.y;

      ctx.fillStyle = "rgba(9, 9, 11, 0.85)";
      ctx.fillRect(labelX - padX / 2, labelY - fontPx / 2 - padY, visibleWidth + padX, fontPx + padY * 2);
      // Color by role
      ctx.fillStyle =
        n.role === "user" && n.subtype === "prompt" ? "#a7f3d0" :
        n.role === "assistant" ? "#fde68a" :
        "#a1a1aa";
      ctx.fillText(labelText, labelX, labelY);
      count += 1;
    }
  }
}

function shouldInlineLabel(n: LayoutNode, state: RenderState): boolean {
  if (n.id === state.selectedId || n.id === state.hoveredId) return true;
  if (state.highlightedNodeIds?.has(n.id)) return true;
  if (n.role === "user" && n.subtype === "prompt") return true;
  if (n.role === "assistant" && n.subtype === "text") return true;
  return false;
}

/**
 * Visual size multiplier per node classification.
 * The conversation "ping pong" is user:prompt → assistant → assistant → ... → user:prompt.
 * Tool-result + slash-command noise lives between assistant turns. By scaling
 * prompts up and noise down, the prompt chain pops visually.
 */
function nodeSizeMul(role: "user" | "assistant", subtype: string | null): number {
  if (role === "user") {
    switch (subtype) {
      case "prompt": return 1.8;
      case "tool-result": return 0.55;
      case "slash-command": return 0.5;
      case "slash-output": return 0.5;
      case "system-reminder": return 0.4;
      default: return 0.7;
    }
  }
  return 1.0; // assistant
}

function nodeAlpha(role: "user" | "assistant", subtype: string | null): number {
  if (role === "user") {
    if (subtype === "tool-result") return 0.6;
    if (subtype === "slash-command" || subtype === "slash-output") return 0.5;
    if (subtype === "system-reminder") return 0.4;
  }
  return 1.0;
}

function isLowSignalNode(n: LayoutNode): boolean {
  if (n.role !== "user") return n.subtype === "tool-only" || n.subtype === "thinking";
  return n.subtype === "tool-result" || n.subtype === "slash-command" || n.subtype === "slash-output" || n.subtype === "system-reminder";
}

function isSessionStartPromptNode(n: LayoutNode): boolean {
  return n.isSessionStart && n.role === "user" && n.subtype === "prompt";
}

function formatTimeShort(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function drawDotNode(
  ctx: CanvasRenderingContext2D,
  n: LayoutNode,
  r: number,
  scale: number,
  color: string,
): void {
  const alpha = nodeAlpha(n.role, n.subtype);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;

  if (n.role === "user" && n.subtype !== "prompt") {
    const size = r * 1.65;
    if (n.subtype === "tool-result") {
      roundRect(ctx, n.x - size / 2, n.y - size / 2, size, size, Math.max(1 / scale, size * 0.22));
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(n.x, n.y - size / 2);
      ctx.lineTo(n.x + size / 2, n.y);
      ctx.lineTo(n.x, n.y + size / 2);
      ctx.lineTo(n.x - size / 2, n.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }

  ctx.beginPath();
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  if (n.role === "user" && n.subtype === "prompt") {
    ctx.strokeStyle = n.isSessionStart ? "rgba(34, 211, 238, 0.95)" : "rgba(167, 243, 208, 0.9)";
    ctx.lineWidth = Math.max(1, 1.25 / scale);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + Math.max(1.5, 2 / scale), 0, Math.PI * 2);
    ctx.stroke();
    if (n.isSessionStart) {
      const outer = r + Math.max(5, 6 / scale);
      ctx.strokeStyle = "rgba(34, 211, 238, 0.85)";
      ctx.lineWidth = Math.max(1.25, 1.75 / scale);
      ctx.beginPath();
      ctx.arc(n.x, n.y, outer, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#22d3ee";
      ctx.beginPath();
      ctx.moveTo(n.x - outer * 0.55, n.y - outer * 0.95);
      ctx.lineTo(n.x - outer * 0.55, n.y - outer * 0.18);
      ctx.lineTo(n.x + outer * 0.12, n.y - outer * 0.56);
      ctx.closePath();
      ctx.fill();
    }
    if (n.isCompactBoundary) {
      const marker = r + Math.max(7, 8 / scale);
      ctx.strokeStyle = "rgba(244, 114, 182, 0.95)";
      ctx.lineWidth = Math.max(1.5, 2 / scale);
      ctx.beginPath();
      ctx.moveTo(n.x - marker, n.y - marker * 0.65);
      ctx.lineTo(n.x + marker, n.y - marker * 0.65);
      ctx.moveTo(n.x - marker, n.y + marker * 0.65);
      ctx.lineTo(n.x + marker, n.y + marker * 0.65);
      ctx.stroke();
    }
  } else if (n.role === "assistant" && n.subtype === "thinking") {
    ctx.strokeStyle = "rgba(250, 250, 250, 0.55)";
    ctx.lineWidth = Math.max(1, 1 / scale);
    ctx.setLineDash([2 / scale, 2 / scale]);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + Math.max(1, 1.5 / scale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/**
 * Card-mode rendering: each node is a text box showing its preview content.
 * Cards anchored at the layout x/y (top-left), wider than tall typically.
 * Edges drawn between card centers.
 */
function renderCards(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  colorCtx: ColorContext,
): void {
  const scale = state.transform.scale;
  const cardW = LAYOUT.cardWidth;
  // Default fallback height — only used for nodes that somehow lack cardHeight
  // (shouldn't happen if layout was built in card mode).
  const defaultCardH = LAYOUT.cardHeaderHeight + LAYOUT.cardLineHeight + LAYOUT.cardPadding * 2;
  const cardHOf = (n: import("./types.js").LayoutNode): number =>
    n.cardHeight ?? defaultCardH;

  // Faint session backgrounds first
  for (const band of layout.sessionBands) {
    if (!intersects(band, view)) continue;
    const w = band.maxX - band.minX;
    const h = band.maxY - band.minY;
    const isHover = band.sessionId === state.hoveredSessionId;
    const isActive = band.sessionId === state.activeSessionId;
    ctx.globalAlpha = isActive ? 0.18 : isHover ? 0.14 : 0.05;
    ctx.fillStyle = projectColor(band.projectSlug);
    roundRect(ctx, band.minX, band.minY, w, h, 8);
    ctx.fill();
    if (isActive) {
      const pulse = 0.5 + 0.5 * Math.sin(state.nowMs / 350);
      ctx.strokeStyle = `rgba(52, 211, 153, ${0.4 + 0.4 * pulse})`;
      ctx.lineWidth = Math.max(1.5, 2 / scale);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  drawTimelineRails(ctx, layout, state, view);
  drawCompactMarkers(ctx, layout, state, view, /*cardMode=*/ true);

  // Edges (parent bottom-center → child top-center) — use each card's own height
  ctx.lineWidth = Math.max(1, 1 / scale);
  for (const e of layout.edges) {
    const from = layout.nodes.get(e.fromId);
    const to = layout.nodes.get(e.toId);
    if (!from || !to) continue;
    const fromH = cardHOf(from);
    const fx = from.x + cardW / 2;
    const fy = from.y + fromH;
    const tx = to.x + cardW / 2;
    const ty = to.y;
    if (Math.max(fx, tx) < view.x0 || Math.min(fx, tx) > view.x1) continue;
    if (Math.max(fy, ty) < view.y0 || Math.min(fy, ty) > view.y1) continue;
    ctx.strokeStyle = e.isFork ? EDGE_FORK_COLOR : EDGE_COLOR;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    if (e.isFork) {
      const midY = (fy + ty) / 2;
      ctx.bezierCurveTo(fx, midY, tx, midY, tx, ty);
    } else {
      ctx.lineTo(tx, ty);
    }
    ctx.stroke();
  }

  // Cards
  const fontPx = Math.min(11, 13 / scale);
  const headerPx = Math.min(9, 10.5 / scale);
  const cardLineHeight = Math.min(LAYOUT.cardLineHeight, 16 / scale);
  ctx.textBaseline = "top";
  for (const n of layout.nodes.values()) {
    const h = cardHOf(n);
    if (n.x + cardW < view.x0 || n.x > view.x1) continue;
    if (n.y + h < view.y0 || n.y > view.y1) continue;
    drawCard(ctx, n, state, cardW, h, fontPx, headerPx, cardLineHeight, colorCtx);
  }

  if (state.subagentsCollapsed) drawSubagentBadges(ctx, layout, state, view, /*cardMode=*/ true);
  drawTimelineGapLabels(ctx, layout, state, view, /*cardMode=*/ true);
  drawMultiSelect(ctx, layout, state, /*cardMode=*/ true);
  drawSelectionSpotlight(ctx, layout, state);

  // Selection ring (already part of card border for selected, but draw the LIVE pulse here)
  drawLiveTip(ctx, layout, state);
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  n: LayoutNode,
  state: RenderState,
  cardW: number,
  cardH: number,
  fontPx: number,
  headerPx: number,
  lineHeight: number,
  colorCtx: ColorContext,
): void {
  const x = n.x;
  const y = n.y;
  const isSelected = n.id === state.selectedId;
  const isHovered = n.id === state.hoveredId;
  const isHi = state.highlightedNodeIds?.has(n.id);
  const isSessionStart = isSessionStartPromptNode(n);
  const color = n.isCompactBoundary ? "#f472b6" : isSessionStart ? "#22d3ee" : colorForNode(n, state.colorMode, colorCtx);
  const isQuiet = isLowSignalNode(n);

  // Card background
  ctx.fillStyle = isSelected
    ? "rgba(39, 39, 42, 0.98)"
    : isQuiet
      ? "rgba(18, 18, 22, 0.82)"
      : "rgba(24, 24, 27, 0.94)";
  roundRect(ctx, x, y, cardW, cardH, 6);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.globalAlpha = isQuiet ? 0.55 : 0.9;
  const accentW = Math.max(0.8, 3 / state.transform.scale);
  roundRect(ctx, x, y, accentW, cardH, accentW);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Border
  ctx.strokeStyle = isSelected ? NODE_RING_SELECTED : isHovered ? "#ffffff" : isHi ? "#ffffff" : isQuiet ? "rgba(113, 113, 122, 0.7)" : color;
  ctx.lineWidth = Math.max(0.6, (isSelected || isHovered || isHi ? 2 : 1) / state.transform.scale);
  ctx.stroke();
  // Fork ring
  if (n.isFork) {
    ctx.strokeStyle = NODE_RING_FORK;
    ctx.lineWidth = Math.max(0.5, 1.5 / state.transform.scale);
    ctx.beginPath();
    ctx.roundRect?.(x - 2, y - 2, cardW + 4, cardH + 4, 8);
    ctx.stroke();
  }

  // Header: role/subtype + time/tokens.
  ctx.fillStyle = color;
  ctx.font = `bold ${headerPx}px ui-sans-serif, system-ui, sans-serif`;
  const header =
    n.isCompactBoundary ? "compacted here" :
    isSessionStart ? "new session" :
    n.role === "user" && n.subtype === "prompt" ? "prompt" :
    n.role === "assistant" && n.subtype === "text" ? "assistant" :
    n.role === "assistant" && n.subtype === "tool-only" ? "tool call" :
    n.role === "assistant" && n.subtype === "thinking" ? "thinking" :
    n.role === "user" ? (n.subtype ?? "user") :
    "assistant";
  const metaParts = [formatTimeShort(n.timestamp)];
  if (n.outputTokens > 0) metaParts.push(`${formatCompactNumber(n.outputTokens)} tok`);
  const meta = metaParts.filter(Boolean).join(" · ");
  ctx.textAlign = "right";
  ctx.fillStyle = isQuiet ? "#71717a" : "#a1a1aa";
  ctx.fillText(meta, x + cardW - LAYOUT.cardPadding, y + LAYOUT.cardPadding);
  ctx.textAlign = "left";
  ctx.fillStyle = color;
  const headerMaxW = Math.max(40, cardW - LAYOUT.cardPadding * 2 - ctx.measureText(meta).width - 10);
  ctx.fillText(ellipsizeToWidth(ctx, header.toUpperCase(), headerMaxW), x + LAYOUT.cardPadding, y + LAYOUT.cardPadding);

  // Subagent badge top-right
  if (n.isSidechain) {
    const label = "SUBAGENT";
    ctx.fillStyle = "#c084fc";
    ctx.textAlign = "right";
    ctx.fillText(label, x + cardW - LAYOUT.cardPadding, y + LAYOUT.cardPadding + headerPx + 2);
    ctx.textAlign = "left";
  }

  // Body text — wrap into the available body area inside this card. Lines available
  // is derived from the card's actual height (which the layout sized for this
  // node's preview length), so the text fits without external truncation.
  ctx.fillStyle = isQuiet ? "#a1a1aa" : "#e4e4e7";
  ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  const text = n.preview || "(empty)";
  const bodyTop = y + LAYOUT.cardPadding + LAYOUT.cardHeaderHeight;
  const bodyHeight = cardH - LAYOUT.cardHeaderHeight - LAYOUT.cardPadding * 2;
  const maxLines = Math.max(1, Math.floor(bodyHeight / lineHeight));
  drawWrappedText(
    ctx,
    text,
    x + LAYOUT.cardPadding,
    bodyTop,
    cardW - LAYOUT.cardPadding * 2,
    lineHeight,
    maxLines,
  );
}

/** Greedy word-wrap into N lines, with ellipsis if text overflows. */
function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  const words = text.split(/\s+/);
  let line = "";
  let lineIdx = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const test = line.length === 0 ? word : line + " " + word;
    if (ctx.measureText(test).width > maxWidth) {
      if (line.length === 0) {
        ctx.fillText(ellipsizeToWidth(ctx, word, maxWidth), x, y + lineIdx * lineHeight);
        lineIdx += 1;
        if (lineIdx >= maxLines) return;
        continue;
      }
      // commit current line
      if (lineIdx === maxLines - 1) {
        // Last line; truncate with ellipsis if there's more
        let truncated = line;
        const remaining = words.slice(i).join(" ");
        if (remaining.length > 0) {
          truncated = ellipsizeToWidth(ctx, truncated + " " + remaining, maxWidth);
        }
        ctx.fillText(truncated, x, y + lineIdx * lineHeight);
        return;
      }
      ctx.fillText(line, x, y + lineIdx * lineHeight);
      lineIdx += 1;
      line = word;
    } else {
      line = test;
    }
  }
  if (line.length > 0 && lineIdx < maxLines) {
    ctx.fillText(line, x, y + lineIdx * lineHeight);
  }
}

function ellipsizeToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  const suffix = "...";
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + suffix).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, Math.max(0, lo)).trimEnd() + suffix;
}

// ───── Drawing helpers ─────

function drawLiveTip(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
): void {
  if (!state.liveTipId) return;
  const n = layout.nodes.get(state.liveTipId);
  if (!n) return;
  const scale = state.transform.scale;
  const baseR = Math.max(LAYOUT.nodeRadius, 2.5 / scale);
  if (state.nodeStyle === "cards") {
    const cardH = n.cardHeight ?? LAYOUT.cardHeaderHeight + LAYOUT.cardLineHeight + LAYOUT.cardPadding * 2;
    const phase = (state.nowMs % 1400) / 1400;
    for (const offset of [0, 0.5]) {
      const p = (phase + offset) % 1;
      const pad = p * Math.max(8, 14 / scale);
      const alpha = 1 - p;
      ctx.strokeStyle = `rgba(52, 211, 153, ${alpha * 0.75})`;
      ctx.lineWidth = Math.max(1.5, 2 / scale);
      roundRect(ctx, n.x - pad, n.y - pad, LAYOUT.cardWidth + pad * 2, cardH + pad * 2, 8 + pad);
      ctx.stroke();
    }
    ctx.fillStyle = "#34d399";
    ctx.beginPath();
    ctx.arc(n.x + LAYOUT.cardPadding, n.y + LAYOUT.cardPadding, Math.max(3, 4 / scale), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Pulse: phase oscillates 0..1 with period ~700ms
  const phase = (state.nowMs % 1400) / 1400;
  // Two concentric pulses for a sonar feel
  for (const offset of [0, 0.5]) {
    const p = (phase + offset) % 1;
    const r = baseR + p * Math.max(12, 18 / scale);
    const alpha = 1 - p;
    ctx.strokeStyle = `rgba(52, 211, 153, ${alpha * 0.8})`;
    ctx.lineWidth = Math.max(1.5, 2 / scale);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Solid emerald dot in the center
  ctx.fillStyle = "#34d399";
  ctx.beginPath();
  ctx.arc(n.x, n.y, baseR + 1 / scale, 0, Math.PI * 2);
  ctx.fill();
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  alpha: number,
): void {
  ctx.strokeStyle = EDGE_COLOR;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(1, 1 / state.transform.scale);
  ctx.beginPath();
  for (const e of layout.edges) {
    if (e.isFork) continue; // drawn separately for prominence
    const from = layout.nodes.get(e.fromId);
    const to = layout.nodes.get(e.toId);
    if (!from || !to) continue;
    if (Math.max(from.x, to.x) < view.x0 || Math.min(from.x, to.x) > view.x1) continue;
    if (Math.max(from.y, to.y) < view.y0 || Math.min(from.y, to.y) > view.y1) continue;
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawForkEdges(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  alpha: number,
): void {
  ctx.strokeStyle = EDGE_FORK_COLOR;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(1.5, 1.5 / state.transform.scale);
  for (const e of layout.edges) {
    if (!e.isFork) continue;
    const from = layout.nodes.get(e.fromId);
    const to = layout.nodes.get(e.toId);
    if (!from || !to) continue;
    if (Math.max(from.x, to.x) < view.x0 || Math.min(from.x, to.x) > view.x1) continue;
    if (Math.max(from.y, to.y) < view.y0 || Math.min(from.y, to.y) > view.y1) continue;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    const midY = (from.y + to.y) / 2;
    ctx.bezierCurveTo(from.x, midY, to.x, midY, to.x, to.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * Timeline mode only: draw a "+Δt" label to the left of each node showing the
 * gap from the previous chronological message in the same session. Lets you
 * read "is this a 5-second gap or a 5-hour gap" at a glance without hovering.
 * Skips gaps under 1 minute (always shown tight as the visual minimum) and
 * skips small zoom levels where labels would clutter the canvas.
 */
function drawTimelineGapLabels(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  cardMode: boolean,
): void {
  if (!layout.nodeGapToPrev || layout.nodeGapToPrev.size === 0) return;
  const scale = state.transform.scale;
  if (scale < 0.6) return;
  const fontPx = cardMode ? 9 : Math.max(8, 10 / scale);
  ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const [id, ms] of layout.nodeGapToPrev) {
    if (ms < 60_000) continue; // sub-minute gaps not worth labeling
    const n = layout.nodes.get(id);
    if (!n) continue;
    if (n.x < view.x0 - 200 || n.x > view.x1) continue;
    if (n.y < view.y0 || n.y > view.y1) continue;
    const text = formatGap(ms);
    // Position to the left of the node/card top-edge with a small margin
    const labelX = cardMode ? n.x - 6 : n.x - 6 / scale;
    const labelY = cardMode ? n.y + 8 : n.y;
    const w = ctx.measureText(text).width + (cardMode ? 8 : 8 / scale);
    const h = cardMode ? 13 : 13 / scale;
    // Background pill so labels stay readable over edges/hulls
    ctx.fillStyle = "rgba(9, 9, 11, 0.75)";
    roundRect(ctx, labelX - w, labelY - h / 2, w, h, h / 2);
    ctx.fill();
    // Tint long gaps amber, short gaps zinc — gives at-a-glance "big pause" signal
    ctx.fillStyle = ms >= 3600_000 ? "#fbbf24" : ms >= 600_000 ? "#fde68a" : "#a1a1aa";
    ctx.fillText(text, labelX - (cardMode ? 4 : 4 / scale), labelY);
  }
  ctx.textAlign = "left";
}

function formatGap(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `+${s}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `+${m}m`;
  const h = Math.round(ms / 3600_000);
  if (h < 24) return `+${h}h`;
  const d = Math.round(ms / 86400_000);
  return `+${d}d`;
}

/**
 * Draw a small purple "+N" badge next to each parent that has subagents,
 * when subagents are globally hidden. Purely informative — clicking does
 * nothing yet (toggle the global visibility from the sidebar to expand).
 *
 * In dot mode the badge sits just to the right of the dot; in card mode
 * it sits at the top-right corner of the card.
 */
function drawSubagentBadges(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  cardMode: boolean,
): void {
  if (layout.subagentCountByParent.size === 0) return;
  const scale = state.transform.scale;
  const fontPx = cardMode ? 9 : Math.max(8, 9 / scale);
  ctx.font = `bold ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const [parentId, count] of layout.subagentCountByParent) {
    const n = layout.nodes.get(parentId);
    if (!n) continue;
    if (n.x < view.x0 || n.x > view.x1 || n.y < view.y0 || n.y > view.y1) continue;
    const text = `+${count}`;
    const w = ctx.measureText(text).width + (cardMode ? 8 : 8 / scale);
    const h = cardMode ? 14 : 14 / scale;
    let bx: number;
    let by: number;
    if (cardMode) {
      // Top-right corner of the card. cardWidth = 260 layout units; height per-node.
      bx = n.x + LAYOUT.cardWidth - w - 4;
      by = n.y + 4;
    } else {
      const r = Math.max(LAYOUT.nodeRadius, 2.5 / scale);
      bx = n.x + r + 4 / scale;
      by = n.y - h / 2;
    }
    // Pill background
    ctx.fillStyle = "rgba(192, 132, 252, 0.92)"; // violet — matches subagent dot color
    ctx.strokeStyle = "rgba(9, 9, 11, 0.6)";
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, w, h, h / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1e1b3a";
    ctx.fillText(text, bx + w / 2, by + h / 2);
  }
  ctx.textAlign = "left";
}

/**
 * Per-session sparkline: assistant output-tokens per turn, drawn as a tiny bar
 * chart along the top edge of the session band. Reveals which sessions are
 * "thinking hard" (tall bars, late-game spikes) vs flat tool-bouncing without
 * needing to zoom in. Normalized per-session so a small session's pattern
 * isn't crushed by a huge one.
 */
function drawSessionSparklines(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  const scale = state.transform.scale;
  // Sparkline area in layout units — height depends on zoom so it stays readable
  // on screen. Cap at 18px screen height so it never dominates the band.
  const screenH = 18;
  const layoutH = screenH / scale;
  for (const band of layout.sessionBands) {
    if (!intersects(band, view)) continue;
    const spark = band.tokenSpark;
    if (spark.length === 0) continue;
    const widthPx = (band.maxX - band.minX) * scale;
    if (widthPx < 60) continue; // too narrow to read
    const bandW = band.maxX - band.minX;
    const x0 = band.minX;
    // Bars hugging the top of the band (just under the sticky label slot)
    const y0 = band.minY + layoutH;
    const max = spark.reduce((m, v) => Math.max(m, v), 0);
    if (max <= 0) continue;
    const barW = bandW / spark.length;
    const isHover = band.sessionId === state.hoveredSessionId;
    ctx.fillStyle = `rgba(251, 191, 36, ${isHover ? 0.7 : 0.45})`; // amber-400, matches assistant role
    for (let i = 0; i < spark.length; i++) {
      const v = spark[i]!;
      if (v <= 0) continue;
      const h = (v / max) * layoutH;
      ctx.fillRect(x0 + i * barW, y0 - h, Math.max(barW * 0.8, 1 / scale), h);
    }
  }
}

function drawSessionLabels(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
  minBandWidthScreenPx: number,
): void {
  const scale = state.transform.scale;
  const fontPx = 11 / scale;
  ctx.font = `${fontPx}px ui-monospace, monospace`;
  ctx.textBaseline = "alphabetic";
  for (const band of layout.sessionBands) {
    if (!intersects(band, view)) continue;
    const widthPx = (band.maxX - band.minX) * scale;
    if (widthPx < minBandWidthScreenPx) continue;
    const label = sessionLabel(band);
    ctx.fillStyle = band.sessionId === state.hoveredSessionId ? "#fafafa" : "#a1a1aa";
    ctx.fillText(label, band.minX, band.minY - 4 / scale);
  }
}

/**
 * Draw a sticky banner at the top of the viewport for each session whose band
 * has scrolled past the top edge. Banner width matches the band's x extent on
 * screen (clamped to viewport), so multiple visible sessions stack horizontally
 * if they're side-by-side.
 */
function drawStickySessionLabels(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  transform: Transform,
  state: RenderState,
  viewportWidth: number,
  viewportHeight: number,
  dpr: number,
): void {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const stickyTop = 8;
  const bannerH = 20;
  const fontPx = 11;
  ctx.font = `${fontPx}px ui-monospace, monospace`;
  ctx.textBaseline = "middle";
  for (const band of layout.sessionBands) {
    const bandTopY = band.minY * transform.scale + transform.ty;
    const bandBotY = band.maxY * transform.scale + transform.ty;
    // Only stick when the label has scrolled past the top AND the band is still
    // partially visible below the sticky banner.
    if (bandTopY >= stickyTop) continue;
    if (bandBotY <= stickyTop + bannerH) continue;
    const bandLeftX = band.minX * transform.scale + transform.tx;
    const bandRightX = band.maxX * transform.scale + transform.tx;
    if (bandRightX < 8 || bandLeftX > viewportWidth - 8) continue;
    const x = Math.max(8, bandLeftX);
    const right = Math.min(viewportWidth - 8, bandRightX);
    const w = Math.max(60, right - x);
    const isHover = band.sessionId === state.hoveredSessionId;
    const isActive = band.sessionId === state.activeSessionId;
    // Banner background — project-tinted, more opaque when active
    ctx.fillStyle = projectColor(band.projectSlug);
    ctx.globalAlpha = isActive ? 0.35 : isHover ? 0.28 : 0.22;
    ctx.fillRect(x, stickyTop, w, bannerH);
    // Bottom edge line for separation
    ctx.globalAlpha = 0.7;
    ctx.fillRect(x, stickyTop + bannerH - 1, w, 1);
    ctx.globalAlpha = 1;
    // Label text
    ctx.fillStyle = isActive || isHover ? "#fafafa" : "#d4d4d8";
    const label = sessionLabel(band);
    // Clip to banner so long labels don't bleed past the band's x range
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 8, stickyTop, w - 16, bannerH);
    ctx.clip();
    ctx.fillText(label, x + 8, stickyTop + bannerH / 2);
    ctx.restore();
    // Active session: pulsing emerald dot before the label
    if (isActive) {
      const pulse = 0.5 + 0.5 * Math.sin(state.nowMs / 350);
      ctx.fillStyle = `rgba(52, 211, 153, ${0.6 + 0.4 * pulse})`;
      ctx.beginPath();
      ctx.arc(x + 4, stickyTop + bannerH / 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function sessionLabel(band: SessionBand): string {
  const id = band.sessionId.slice(0, 8);
  const count = band.nodeCount;
  const prompt = band.firstPrompt.slice(0, 30);
  return prompt ? `${id} · ${count}n · ${prompt}` : `${id} · ${count}n`;
}

/** Cyan outlines around multi-selected nodes — distinct from hover (white)
 *  and single-select (amber). Drawn in both dot and card modes. */
function drawMultiSelect(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  cardMode: boolean,
): void {
  if (!state.multiSelectedIds || state.multiSelectedIds.size === 0) return;
  const scale = state.transform.scale;
  ctx.strokeStyle = "rgba(34, 211, 238, 0.85)"; // cyan-400
  ctx.lineWidth = Math.max(1.5, 2 / scale);
  for (const id of state.multiSelectedIds) {
    const n = layout.nodes.get(id);
    if (!n) continue;
    if (cardMode) {
      const h = n.cardHeight ?? LAYOUT.cardHeaderHeight + LAYOUT.cardLineHeight + LAYOUT.cardPadding * 2;
      ctx.beginPath();
      const r = 6;
      ctx.roundRect?.(n.x - 1, n.y - 1, LAYOUT.cardWidth + 2, h + 2, r);
      ctx.stroke();
    } else {
      const baseR = Math.max(LAYOUT.nodeRadius, 2.5 / scale);
      const r = baseR * nodeSizeMul(n.role, n.subtype) + Math.max(3, 4 / scale);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * Faint grid or dot pattern in world coords. Snaps line pitch to a power-of-10
 * style step (50 / 100 / 500 / 1000 etc.) chosen so screen-space density stays
 * around ~50px between lines regardless of zoom. Always quite dim so it sits
 * behind everything else.
 */
function drawBackgroundPattern(
  ctx: CanvasRenderingContext2D,
  style: "grid" | "dots",
  scale: number,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  // Target ~80px between adjacent gridlines on screen. Pick the closest "nice"
  // pitch (...50, 100, 250, 500, 1000, 2500, 5000...) above (80/scale).
  const targetLayoutPitch = 80 / scale;
  const candidates = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];
  let pitch = candidates[candidates.length - 1]!;
  for (const c of candidates) {
    if (c >= targetLayoutPitch) { pitch = c; break; }
  }
  const x0 = Math.floor(view.x0 / pitch) * pitch;
  const x1 = Math.ceil(view.x1 / pitch) * pitch;
  const y0 = Math.floor(view.y0 / pitch) * pitch;
  const y1 = Math.ceil(view.y1 / pitch) * pitch;

  if (style === "grid") {
    ctx.strokeStyle = "rgba(63, 63, 70, 0.35)"; // zinc-700 at low alpha
    ctx.lineWidth = Math.max(0.5, 1 / scale);
    ctx.beginPath();
    for (let x = x0; x <= x1; x += pitch) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = y0; y <= y1; y += pitch) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
    // Stronger major gridlines every 5 pitches for visual rhythm
    ctx.strokeStyle = "rgba(82, 82, 91, 0.45)"; // zinc-600
    ctx.beginPath();
    const major = pitch * 5;
    const mx0 = Math.floor(view.x0 / major) * major;
    const mx1 = Math.ceil(view.x1 / major) * major;
    const my0 = Math.floor(view.y0 / major) * major;
    const my1 = Math.ceil(view.y1 / major) * major;
    for (let x = mx0; x <= mx1; x += major) {
      ctx.moveTo(x, my0);
      ctx.lineTo(x, my1);
    }
    for (let y = my0; y <= my1; y += major) {
      ctx.moveTo(mx0, y);
      ctx.lineTo(mx1, y);
    }
    ctx.stroke();
  } else {
    // Dot pattern — at every grid intersection
    ctx.fillStyle = "rgba(82, 82, 91, 0.55)";
    const r = Math.max(0.7, 1.2 / scale);
    for (let x = x0; x <= x1; x += pitch) {
      for (let y = y0; y <= y1; y += pitch) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Selection-ring color tinted by the node's role/subtype so the ring reads
 *  as a diegetic emphasis of what's selected (prompt → emerald, assistant →
 *  amber, subagent → violet) instead of always-amber. */
function selectionRingColor(role: "user" | "assistant", subtype: string | null, isSidechain: boolean): string {
  if (isSidechain) return "#c084fc"; // violet
  if (role === "user" && subtype === "prompt") return "#34d399"; // emerald
  if (role === "assistant" && subtype === "thinking") return "#a78bfa"; // soft violet
  if (role === "assistant" && subtype === "tool-only") return "#60a5fa"; // blue
  if (role === "assistant") return "#fbbf24"; // amber for plain text reply
  return NODE_RING_SELECTED; // fallback
}

/** Brief expanding-ring "ping" centered on the just-selected node. Single-shot
 *  per selection change; the ring grows for SPOTLIGHT_MS then disappears.
 *  Drawn AFTER the selection ring so it sits on top. */
const SPOTLIGHT_MS = 350;
function drawSelectionSpotlight(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
): void {
  if (!state.selectedId || !state.selectionPingMs) return;
  const dt = state.nowMs - state.selectionPingMs;
  if (dt < 0 || dt > SPOTLIGHT_MS) return;
  const n = layout.nodes.get(state.selectedId);
  if (!n) return;
  const t = dt / SPOTLIGHT_MS;
  const eased = 1 - Math.pow(1 - t, 2); // ease-out-quad
  const scale = state.transform.scale;
  const baseR = Math.max(LAYOUT.nodeRadius, 2.5 / scale);
  const startR = baseR * 1.5;
  const endR = startR + 30 / scale;
  const r = startR + (endR - startR) * eased;
  const alpha = 1 - eased;
  ctx.strokeStyle = `rgba(245, 158, 11, ${(alpha * 0.85).toFixed(3)})`;
  ctx.lineWidth = Math.max(1.5, 2 / scale);
  ctx.beginPath();
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function drawSelectionAndHover(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
): void {
  const scale = state.transform.scale;
  if (state.selectedId) {
    const n = layout.nodes.get(state.selectedId);
    if (n) {
      const r = Math.max(LAYOUT.nodeRadius, 2.5 / scale);
      // Selection ring tinted to the node's role color so the ring reads as
      // a diegetic emphasis instead of generic-amber-on-everything.
      ctx.strokeStyle = selectionRingColor(n.role, n.subtype, n.isSidechain);
      ctx.lineWidth = Math.max(2.5, 3 / scale);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + Math.max(4, 5 / scale), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (state.hoveredId && state.hoveredId !== state.selectedId) {
    const h = layout.nodes.get(state.hoveredId);
    if (h) {
      const r = Math.max(LAYOUT.nodeRadius, 2.5 / scale);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(2, 2 / scale);
      ctx.beginPath();
      ctx.arc(h.x, h.y, r + Math.max(3, 4 / scale), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function intersects(
  band: SessionBand,
  view: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  return !(band.maxX < view.x0 || band.minX > view.x1 || band.maxY < view.y0 || band.minY > view.y1);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (w <= 0 || h <= 0) return;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function prettySlug(slug: string): string {
  return slug.replace(/^C--Users-[^-]+-/, "~/").replace(/-+/g, "/");
}

// ───── Hit testing ─────

/** Hit-test a screen-coord point against nodes (detail LOD) or session bands (lower LODs). */
/**
 * Hit-test sparkline bars (the amber chart at the top of each session band).
 * Mirrors drawSessionSparklines' geometry. Returns the matched bar's node id
 * + the band so the tooltip can show "this message was at X time."
 *
 * Only fires at session/detail LOD (the sparkline isn't drawn at overview).
 */
export function hitTestSparkline(
  layout: Layout,
  transform: Transform,
  screenX: number,
  screenY: number,
): { sessionId: string; nodeId: string; tokens: number } | null {
  if (transform.scale < 0.15) return null; // overview LOD has no spark
  const screenH = 18;
  const layoutH = screenH / transform.scale;
  // Inverse: convert screen → layout coords
  const lx = (screenX - transform.tx) / transform.scale;
  const ly = (screenY - transform.ty) / transform.scale;
  for (const band of layout.sessionBands) {
    if (!band.sparkNodeIds || band.sparkNodeIds.length === 0) continue;
    if (lx < band.minX || lx > band.maxX) continue;
    const y0 = band.minY;
    const y1 = band.minY + layoutH;
    if (ly < y0 || ly > y1) continue;
    const bandW = band.maxX - band.minX;
    const widthPx = bandW * transform.scale;
    if (widthPx < 60) continue;
    const barCount = band.sparkNodeIds.length;
    const barW = bandW / barCount;
    const idx = Math.floor((lx - band.minX) / barW);
    if (idx < 0 || idx >= barCount) continue;
    const nodeId = band.sparkNodeIds[idx]!;
    const tokens = band.tokenSpark[idx] ?? 0;
    return { sessionId: band.sessionId, nodeId, tokens };
  }
  return null;
}

export function hitTest(
  layout: Layout,
  transform: Transform,
  screenX: number,
  screenY: number,
  nodeStyle: NodeStyle = "dots",
): { kind: "node"; id: string } | { kind: "session"; id: string } | null {
  const lx = (screenX - transform.tx) / transform.scale;
  const ly = (screenY - transform.ty) / transform.scale;
  const lod = lodOf(transform.scale);
  if (lod === "detail") {
    if (nodeStyle === "cards") {
      const cardW = LAYOUT.cardWidth;
      const fallback = LAYOUT.cardHeaderHeight + LAYOUT.cardLineHeight + LAYOUT.cardPadding * 2;
      for (const n of layout.nodes.values()) {
        const cardH = n.cardHeight ?? fallback;
        if (lx >= n.x && lx <= n.x + cardW && ly >= n.y && ly <= n.y + cardH) {
          return { kind: "node", id: n.id };
        }
      }
    } else {
      const baseR = Math.max(LAYOUT.nodeRadius, 2.5 / transform.scale);
      const slack = 4 / transform.scale;
      let best: { id: string; d2: number } | null = null;
      for (const n of layout.nodes.values()) {
        const r = baseR * nodeSizeMul(n.role, n.subtype) + slack;
        const r2 = r * r;
        const dx = n.x - lx;
        const dy = n.y - ly;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2 && (!best || d2 < best.d2)) best = { id: n.id, d2 };
      }
      if (best) return { kind: "node", id: best.id };
    }
  }
  // At session/overview LOD, hit-test session bands
  for (const band of layout.sessionBands) {
    if (lx >= band.minX && lx <= band.maxX && ly >= band.minY && ly <= band.maxY) {
      return { kind: "session", id: band.sessionId };
    }
  }
  return null;
}

/** Compute a transform that fits the entire layout into the viewport. */
export function fitTransform(
  layout: Layout,
  viewportWidth: number,
  viewportHeight: number,
  padding = 32,
): Transform {
  return fitToBounds(layout.bounds, viewportWidth, viewportHeight, padding);
}

/** Fit transform to an arbitrary bounding box. */
export function fitToBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  viewportWidth: number,
  viewportHeight: number,
  padding = 32,
): Transform {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  if (w <= 0 || h <= 0) {
    return { tx: viewportWidth / 2, ty: viewportHeight / 2, scale: 1 };
  }
  const scaleX = (viewportWidth - padding * 2) / w;
  const scaleY = (viewportHeight - padding * 2) / h;
  const scale = Math.min(scaleX, scaleY, 4);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    tx: viewportWidth / 2 - cx * scale,
    ty: viewportHeight / 2 - cy * scale,
    scale,
  };
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 16;
