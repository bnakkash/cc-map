import {
  EDGE_COLOR,
  EDGE_FORK_COLOR,
  NODE_FILL_SELECTED,
  NODE_RING_FORK,
  PROJECT_LABEL_COLOR,
  nodeColor,
  projectColor,
} from "./colors.js";
import { LAYOUT, type Layout, type ViewMode } from "./types.js";

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
  mode: ViewMode;
  showLabels: boolean;
}

/**
 * Render the layout to a 2D canvas. Caller controls the requestAnimationFrame loop
 * — this function is synchronous, idempotent, and called only when the scene is dirty.
 *
 * Viewport culling: skips nodes/edges outside the visible region with a generous margin.
 */
export function render(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  state: RenderState,
  viewportWidth: number,
  viewportHeight: number,
): void {
  const { transform } = state;
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  // Clear in CSS pixels
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#09090b"; // zinc-950
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  // Apply pan/zoom
  ctx.translate(transform.tx, transform.ty);
  ctx.scale(transform.scale, transform.scale);

  // Viewport in layout coords (with margin)
  const margin = 50 / transform.scale;
  const view = {
    x0: -transform.tx / transform.scale - margin,
    y0: -transform.ty / transform.scale - margin,
    x1: (viewportWidth - transform.tx) / transform.scale + margin,
    y1: (viewportHeight - transform.ty) / transform.scale + margin,
  };

  // Project labels (in all-projects mode)
  if (state.mode === "all-projects") {
    ctx.fillStyle = PROJECT_LABEL_COLOR;
    ctx.font = `${12 / transform.scale}px ui-monospace, monospace`;
    ctx.textBaseline = "bottom";
    for (const [slug, band] of layout.projectBands) {
      if (band.maxX < view.x0 || band.minX > view.x1) continue;
      // Color stripe at top of project block
      ctx.fillStyle = projectColor(slug);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(band.minX, 0, band.maxX - band.minX, LAYOUT.projectLabelHeight - 4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(prettySlug(slug), band.minX + 4, LAYOUT.projectLabelHeight - 6);
    }
  }

  // Edges first so nodes draw on top
  ctx.lineWidth = 1 / transform.scale;
  for (const e of layout.edges) {
    const from = layout.nodes.get(e.fromId);
    const to = layout.nodes.get(e.toId);
    if (!from || !to) continue;
    if (Math.max(from.x, to.x) < view.x0 || Math.min(from.x, to.x) > view.x1) continue;
    if (Math.max(from.y, to.y) < view.y0 || Math.min(from.y, to.y) > view.y1) continue;
    ctx.strokeStyle = e.isFork ? EDGE_FORK_COLOR : EDGE_COLOR;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    if (e.isFork) {
      // Curved branch
      const midY = (from.y + to.y) / 2;
      ctx.bezierCurveTo(from.x, midY, to.x, midY, to.x, to.y);
    } else {
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
  }

  // Nodes
  const r = LAYOUT.nodeRadius;
  for (const n of layout.nodes.values()) {
    if (n.x + r < view.x0 || n.x - r > view.x1) continue;
    if (n.y + r < view.y0 || n.y - r > view.y1) continue;
    let color = nodeColor(n.role, n.subtype, n.isSidechain);
    if (state.mode === "all-projects") {
      // Tint by project, but keep the role color as base
      ctx.globalAlpha = 0.85;
    }
    ctx.fillStyle = state.selectedId === n.id ? NODE_FILL_SELECTED : color;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (n.isFork) {
      ctx.strokeStyle = NODE_RING_FORK;
      ctx.lineWidth = 1.5 / transform.scale;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Hover ring
  if (state.hoveredId && state.hoveredId !== state.selectedId) {
    const h = layout.nodes.get(state.hoveredId);
    if (h) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2 / transform.scale;
      ctx.beginPath();
      ctx.arc(h.x, h.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Selected label
  if (state.selectedId) {
    const sel = layout.nodes.get(state.selectedId);
    if (sel && state.showLabels) {
      drawLabel(ctx, sel.x, sel.y, sel.preview, transform.scale);
    }
  }

  ctx.restore();
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  scale: number,
): void {
  if (!text) return;
  const fontPx = Math.max(11, 12 / scale);
  ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  const truncated = text.length > 80 ? text.slice(0, 80) + "…" : text;
  const metrics = ctx.measureText(truncated);
  const padding = 4 / scale;
  const labelX = x + 10 / scale;
  const labelY = y;
  ctx.fillStyle = "rgba(24, 24, 27, 0.92)";
  ctx.fillRect(
    labelX - padding,
    labelY - fontPx / 2 - padding,
    metrics.width + padding * 2,
    fontPx + padding * 2,
  );
  ctx.fillStyle = "#fafafa";
  ctx.fillText(truncated, labelX, labelY);
}

function prettySlug(slug: string): string {
  return slug.replace(/^C--Users-[^-]+-/, "~/").replace(/-+/g, "/");
}

/** Hit-test a screen-coord point against layout nodes. Returns the node id or null. */
export function hitTest(
  layout: Layout,
  transform: Transform,
  screenX: number,
  screenY: number,
): string | null {
  // Reverse transform
  const lx = (screenX - transform.tx) / transform.scale;
  const ly = (screenY - transform.ty) / transform.scale;
  const r = LAYOUT.nodeRadius + 2 / transform.scale;
  // Linear scan — fine for our scale; can binary-search later if needed
  for (const n of layout.nodes.values()) {
    const dx = n.x - lx;
    const dy = n.y - ly;
    if (dx * dx + dy * dy <= r * r) return n.id;
  }
  return null;
}

/** Compute a transform that fits the entire layout into the viewport. */
export function fitTransform(
  layout: Layout,
  viewportWidth: number,
  viewportHeight: number,
  padding = 24,
): Transform {
  const w = layout.bounds.maxX - layout.bounds.minX;
  const h = layout.bounds.maxY - layout.bounds.minY;
  if (w <= 0 || h <= 0) {
    return { tx: viewportWidth / 2, ty: viewportHeight / 2, scale: 1 };
  }
  const scaleX = (viewportWidth - padding * 2) / w;
  const scaleY = (viewportHeight - padding * 2) / h;
  const scale = Math.min(scaleX, scaleY, 2); // never zoom in past 2x for fit
  const cx = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const cy = (layout.bounds.minY + layout.bounds.maxY) / 2;
  return {
    tx: viewportWidth / 2 - cx * scale,
    ty: viewportHeight / 2 - cy * scale,
    scale,
  };
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 8;
