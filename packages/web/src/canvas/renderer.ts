import {
  EDGE_COLOR,
  EDGE_FORK_COLOR,
  NODE_RING_FORK,
  NODE_RING_SELECTED,
  nodeColor,
  projectColor,
} from "./colors.js";
import { LAYOUT, type Layout, type NodeStyle, type SessionBand, type ViewMode } from "./types.js";

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

  // ───── Render the appropriate LOD ─────
  if (lod === "overview") {
    renderOverview(ctx, layout, state, view);
  } else if (lod === "session") {
    renderSession(ctx, layout, state, view);
  } else {
    renderDetail(ctx, layout, state, view);
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
    ctx.fillStyle = isHi ? "#ffffff" : nodeColor(n.role, n.subtype, n.isSidechain);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  drawSessionLabels(ctx, layout, state, view, /*minBandPx=*/ 18);
  drawSelectionAndHover(ctx, layout, state);
  drawLiveTip(ctx, layout, state);
}

function renderDetail(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  const scale = state.transform.scale;
  // Card mode dispatches to a completely different render
  if (state.nodeStyle === "cards") {
    renderCards(ctx, layout, state, view);
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
    let color = nodeColor(n.role, n.subtype, n.isSidechain);
    ctx.globalAlpha = nodeAlpha(n.role, n.subtype);
    ctx.fillStyle = isHi ? "#fafafa" : color;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
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
  drawSessionLabels(ctx, layout, state, view, /*minBandPx=*/ 12);
  // Inline node text labels (only when zoomed in enough — and capped to avoid clutter)
  if (scale >= 1.5) {
    drawInlineNodeLabels(ctx, layout, state, view);
  }
  drawSelectionAndHover(ctx, layout, state);
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
  const MAX_LABELS = 400;
  // Below this much horizontal room (in screen pixels), don't even try.
  const MIN_LABEL_PX = 60;

  // Pre-bucket by Y so we can find each node's horizontal next-neighbor cheaply.
  const yBucket = (y: number) => Math.round(y / 4) * 4;
  const byY = new Map<number, typeof layout.nodes extends Map<infer _K, infer V> ? V[] : never>();
  for (const n of layout.nodes.values()) {
    if (n.x < view.x0 || n.x > view.x1 || n.y < view.y0 || n.y > view.y1) continue;
    if (!n.preview) continue;
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

      const text = n.preview;
      const metrics = ctx.measureText(text);
      // Cap at available room — but no truncation since we skip when too tight
      const visibleWidth = Math.min(metrics.width, availLayout);
      const labelX = n.x + r + padX;
      const labelY = n.y;

      ctx.fillStyle = "rgba(9, 9, 11, 0.85)";
      ctx.fillRect(labelX - padX / 2, labelY - fontPx / 2 - padY, visibleWidth + padX, fontPx + padY * 2);
      // Color by role
      ctx.fillStyle =
        n.role === "user" && n.subtype === "prompt" ? "#a7f3d0" :
        n.role === "assistant" ? "#fde68a" :
        "#a1a1aa";
      // Clip text to visibleWidth if needed (no ellipsis — clean cut)
      if (metrics.width > availLayout) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(labelX - padX, labelY - fontPx, visibleWidth + padX * 2, fontPx * 2);
        ctx.clip();
        ctx.fillText(text, labelX, labelY);
        ctx.restore();
      } else {
        ctx.fillText(text, labelX, labelY);
      }
      count += 1;
    }
  }
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
): void {
  const scale = state.transform.scale;
  const cardW = LAYOUT.cardWidth;
  const cardH = LAYOUT.cardLineHeight * LAYOUT.cardMaxLines + LAYOUT.cardPadding * 2 + 14; // 14 for header

  // Faint session backgrounds first
  for (const band of layout.sessionBands) {
    if (!intersects(band, view)) continue;
    const w = band.maxX - band.minX + cardW;
    const h = band.maxY - band.minY + cardH;
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

  // Edges (parent center → child center)
  ctx.lineWidth = Math.max(1, 1 / scale);
  for (const e of layout.edges) {
    const from = layout.nodes.get(e.fromId);
    const to = layout.nodes.get(e.toId);
    if (!from || !to) continue;
    const fx = from.x + cardW / 2;
    const fy = from.y + cardH;
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
  const fontPx = 11;
  const headerPx = 9;
  ctx.textBaseline = "top";
  for (const n of layout.nodes.values()) {
    if (n.x + cardW < view.x0 || n.x > view.x1) continue;
    if (n.y + cardH < view.y0 || n.y > view.y1) continue;
    drawCard(ctx, n, state, cardW, cardH, fontPx, headerPx);
  }

  // Selection ring (already part of card border for selected, but draw the LIVE pulse here)
  drawLiveTip(ctx, layout, state);
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  n: import("./types.js").LayoutNode,
  state: RenderState,
  cardW: number,
  cardH: number,
  fontPx: number,
  headerPx: number,
): void {
  const x = n.x;
  const y = n.y;
  const isSelected = n.id === state.selectedId;
  const isHovered = n.id === state.hoveredId;
  const isHi = state.highlightedNodeIds?.has(n.id);
  const color = nodeColor(n.role, n.subtype, n.isSidechain);

  // Card background
  ctx.fillStyle = isSelected ? "rgba(39, 39, 42, 0.98)" : "rgba(24, 24, 27, 0.92)";
  roundRect(ctx, x, y, cardW, cardH, 6);
  ctx.fill();

  // Border
  ctx.strokeStyle = isSelected ? NODE_RING_SELECTED : isHovered ? "#ffffff" : isHi ? "#ffffff" : color;
  ctx.lineWidth = isSelected || isHovered || isHi ? 2 : 1;
  ctx.stroke();
  // Fork ring
  if (n.isFork) {
    ctx.strokeStyle = NODE_RING_FORK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect?.(x - 2, y - 2, cardW + 4, cardH + 4, 8);
    ctx.stroke();
  }

  // Header: role/subtype + (right-aligned) hint
  ctx.fillStyle = color;
  ctx.font = `bold ${headerPx}px ui-sans-serif, system-ui, sans-serif`;
  const header =
    n.role === "user" && n.subtype === "prompt" ? "prompt" :
    n.role === "assistant" && n.subtype === "text" ? "assistant" :
    n.role === "assistant" && n.subtype === "tool-only" ? "tool call" :
    n.role === "assistant" && n.subtype === "thinking" ? "thinking" :
    n.role === "user" ? (n.subtype ?? "user") :
    "assistant";
  ctx.fillText(header.toUpperCase(), x + LAYOUT.cardPadding, y + LAYOUT.cardPadding);

  // Subagent badge top-right
  if (n.isSidechain) {
    const label = "SUBAGENT";
    ctx.fillStyle = "#c084fc";
    ctx.textAlign = "right";
    ctx.fillText(label, x + cardW - LAYOUT.cardPadding, y + LAYOUT.cardPadding);
    ctx.textAlign = "left";
  }

  // Body text — wrap to N lines
  ctx.fillStyle = "#e4e4e7";
  ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  const text = n.preview || "(empty)";
  drawWrappedText(
    ctx,
    text,
    x + LAYOUT.cardPadding,
    y + LAYOUT.cardPadding + headerPx + 6,
    cardW - LAYOUT.cardPadding * 2,
    LAYOUT.cardLineHeight,
    LAYOUT.cardMaxLines,
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
      // commit current line
      if (lineIdx === maxLines - 1) {
        // Last line; truncate with ellipsis if there's more
        let truncated = line;
        const remaining = words.slice(i).join(" ");
        if (remaining.length > 0) {
          while (ctx.measureText(truncated + " …").width > maxWidth && truncated.length > 1) {
            truncated = truncated.slice(0, -1);
          }
          truncated = truncated + " …";
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

function sessionLabel(band: SessionBand): string {
  const id = band.sessionId.slice(0, 8);
  const count = band.nodeCount;
  const prompt = band.firstPrompt.slice(0, 30);
  return prompt ? `${id} · ${count}n · ${prompt}` : `${id} · ${count}n`;
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
      ctx.strokeStyle = NODE_RING_SELECTED;
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
      const cardH = LAYOUT.cardLineHeight * LAYOUT.cardMaxLines + LAYOUT.cardPadding * 2 + 14;
      for (const n of layout.nodes.values()) {
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
