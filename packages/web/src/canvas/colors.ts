/** Hash a string to a [0, 360) hue. Stable across runs. */
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

/** Color for a project tint in all-projects view. */
export function projectColor(slug: string): string {
  const hue = hashHue(slug);
  return `hsl(${hue}, 50%, 55%)`;
}

/** Color for a node, by role + subtype. */
export function nodeColor(role: "user" | "assistant", subtype: string | null, isSidechain: boolean): string {
  if (isSidechain) return "#a78bfa"; // purple for subagent
  if (role === "assistant") return "#fbbf24"; // amber
  if (subtype === "prompt") return "#34d399"; // emerald
  if (subtype === "tool-result") return "#52525b"; // zinc-600
  return "#71717a"; // zinc-500
}

export const NODE_FILL_SELECTED = "#ffffff";
export const NODE_RING_FORK = "#22d3ee"; // cyan
export const EDGE_COLOR = "rgba(113, 113, 122, 0.5)";
export const EDGE_FORK_COLOR = "rgba(34, 211, 238, 0.5)";
export const PROJECT_LABEL_COLOR = "#a1a1aa";
