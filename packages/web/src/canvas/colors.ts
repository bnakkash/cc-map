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

export const NODE_FILL_SELECTED = "#ffffff";
export const NODE_RING_FORK = "#22d3ee"; // cyan
export const NODE_RING_SELECTED = "#f59e0b"; // amber-500 — distinct from hover (white)
export const EDGE_COLOR = "rgba(113, 113, 122, 0.6)";
export const EDGE_FORK_COLOR = "rgba(34, 211, 238, 0.85)"; // cyan, prominent
export const PROJECT_LABEL_COLOR = "#a1a1aa";
