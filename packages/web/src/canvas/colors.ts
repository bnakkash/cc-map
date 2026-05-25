/** Hash a string to a [0, 360) hue. Stable across runs. */
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

/** Pre-computed perceptually-distinct palette for the first N projects. */
const PROJECT_PALETTE = [
  "#60a5fa", // blue-400
  "#f472b6", // pink-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#22d3ee", // cyan-400
  "#fb923c", // orange-400
  "#4ade80", // green-400
  "#e879f9", // fuchsia-400
  "#facc15", // yellow-400
  "#2dd4bf", // teal-400
  "#f87171", // red-400
  "#818cf8", // indigo-400
  "#a3e635", // lime-400
  "#fda4af", // rose-300
];

const projectColorCache = new Map<string, string>();
export function projectColor(slug: string): string {
  let c = projectColorCache.get(slug);
  if (c) return c;
  if (projectColorCache.size < PROJECT_PALETTE.length) {
    c = PROJECT_PALETTE[projectColorCache.size]!;
  } else {
    c = `hsl(${hashHue(slug)}, 70%, 60%)`;
  }
  projectColorCache.set(slug, c);
  return c;
}

/** Color for a node, by role + subtype. */
export function nodeColor(role: "user" | "assistant", subtype: string | null, isSidechain: boolean): string {
  if (isSidechain) return "#c084fc"; // brighter violet for subagent
  if (role === "assistant") return "#fbbf24"; // amber
  if (subtype === "prompt") return "#34d399"; // emerald
  if (subtype === "tool-result") return "#52525b"; // zinc-600
  return "#71717a"; // zinc-500
}

/**
 * Normalization context for heat-map color modes. Computed once per render
 * pass from the visible layout, then used to map each node's value into [0,1].
 */
export interface ColorContext {
  tsMin: number;
  tsMax: number;
  costMax: number;
}

/** Cold-to-warm gradient for the recency heat map: zinc → emerald. */
function recencyColor(t01: number): string {
  // Clamp + ease so middle range still reads as "warm-ish."
  const t = Math.max(0, Math.min(1, t01));
  // Lerp HSL from zinc (240, 6%, 35%) → emerald (160, 84%, 55%).
  const h = 240 + (160 - 240) * t;
  const s = 6 + (84 - 6) * t;
  const l = 35 + (55 - 35) * t;
  return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
}

/** Cold-to-hot gradient for cost: zinc → amber → red. */
function costColor(t01: number): string {
  const t = Math.max(0, Math.min(1, t01));
  // 0 → zinc; 0.5 → amber; 1 → red. Two-stage lerp through amber.
  if (t < 0.5) {
    const k = t / 0.5;
    const h = 240 + (38 - 240) * k; // zinc-ish → amber
    const s = 6 + (92 - 6) * k;
    const l = 35 + (55 - 35) * k;
    return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
  } else {
    const k = (t - 0.5) / 0.5;
    const h = 38 + (0 - 38) * k; // amber → red
    const s = 92 + (84 - 92) * k;
    const l = 55 + (55 - 55) * k;
    return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
  }
}

/**
 * Color for a layout node under a given color mode.
 *
 * Sidechain (subagent) nodes always render in violet regardless of mode — they
 * carry their own visual semantic and the modes wouldn't help.
 */
export function colorForNode(
  node: {
    role: "user" | "assistant";
    subtype: string | null;
    isSidechain: boolean;
    timestamp: string;
    outputTokens: number;
  },
  mode: "role" | "recency" | "cost",
  cc: ColorContext,
): string {
  if (node.isSidechain) return "#c084fc";
  if (mode === "recency") {
    const ts = Date.parse(node.timestamp);
    if (!Number.isFinite(ts) || cc.tsMax <= cc.tsMin) return "#52525b";
    return recencyColor((ts - cc.tsMin) / (cc.tsMax - cc.tsMin));
  }
  if (mode === "cost") {
    if (node.role !== "assistant" || cc.costMax <= 0) return "#3f3f46"; // dim non-assistants
    return costColor(node.outputTokens / cc.costMax);
  }
  return nodeColor(node.role, node.subtype, node.isSidechain);
}

/** Build a ColorContext from all visible layout nodes. */
export function buildColorContext(
  nodes: Iterable<{ timestamp: string; outputTokens: number; role: "user" | "assistant" }>,
): ColorContext {
  let tsMin = Infinity;
  let tsMax = -Infinity;
  let costMax = 0;
  for (const n of nodes) {
    const ts = Date.parse(n.timestamp);
    if (Number.isFinite(ts)) {
      if (ts < tsMin) tsMin = ts;
      if (ts > tsMax) tsMax = ts;
    }
    if (n.role === "assistant" && n.outputTokens > costMax) costMax = n.outputTokens;
  }
  if (!Number.isFinite(tsMin)) tsMin = 0;
  if (!Number.isFinite(tsMax)) tsMax = 0;
  // Cap costMax at the 95th percentile equivalent so a single 50k-token outlier
  // doesn't flatten everything else to dark. Approximation: cap at 2/3 of max.
  // (Proper percentile would need a sort; this is good enough for visual weight.)
  return { tsMin, tsMax, costMax: Math.max(1, costMax * 0.66) };
}

export const NODE_FILL_SELECTED = "#ffffff";
export const NODE_RING_FORK = "#22d3ee"; // cyan
export const NODE_RING_SELECTED = "#f59e0b"; // amber-500 — distinct from hover (white)
export const EDGE_COLOR = "rgba(113, 113, 122, 0.6)";
export const EDGE_FORK_COLOR = "rgba(34, 211, 238, 0.85)"; // cyan, prominent
export const PROJECT_LABEL_COLOR = "#a1a1aa";
