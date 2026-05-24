export interface ForestNode {
  id: string;
  parentId: string | null;
  sessionId: string;
  projectSlug: string;
  role: "user" | "assistant";
  subtype: string | null;
  isSidechain: boolean;
  timestamp: string;
  preview: string;
  sessionsIn: number;
}

export interface ForkInfo {
  parentUuid: string;
  sessionIds: string[];
}

export interface ProjectMeta {
  slug: string;
  sessionCount: number;
}

export interface ForestPayload {
  nodes: ForestNode[];
  forks: ForkInfo[];
  projects: ProjectMeta[];
  sessionCount: number;
  /** The currently-active Claude Code session (from SessionStart hook, or most-recent fallback). */
  activeSessionId: string | null;
  activeSessionAt: string | null;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  projectSlug: string;
  sessionId: string;
  role: "user" | "assistant";
  subtype: string | null;
  isSidechain: boolean;
  isFork: boolean;
  isShared: boolean; // appears in 2+ sessions
  preview: string;
}

export interface LayoutEdge {
  fromId: string;
  toId: string;
  /** True if this edge crosses sessions (fork edge). */
  isFork: boolean;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SessionBand {
  sessionId: string;
  projectSlug: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  nodeCount: number;
  /** First user prompt (preview) — used as a session "title". */
  firstPrompt: string;
}

export interface Layout {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  bounds: Bounds;
  /** projectSlug -> bounding box of all nodes in that project, for hulls + labels. */
  projectBands: Map<string, { minX: number; maxX: number; minY: number; maxY: number }>;
  /** Per-session bounding boxes for semantic-zoom ribbons and boundary lines. */
  sessionBands: SessionBand[];
  /** Dashed links between sequential roots of the same session — shows reading order. */
  sequenceLinks: SequenceLink[];
}

export type ViewMode = "per-project" | "all-projects";
export type LayoutDirection = "grid" | "column";

export interface SequenceLink {
  /** uuid of the last node in the previous root's chain (within the session) */
  fromId: string;
  /** uuid of the first node in the next root's chain */
  toId: string;
  sessionId: string;
  projectSlug: string;
}

export interface VisibilityFilter {
  assistant: boolean;
  prompt: boolean;
  toolResult: boolean;
  slashCommand: boolean;
  systemReminder: boolean;
  subagent: boolean;
}

export const DEFAULT_VISIBILITY: VisibilityFilter = {
  assistant: true,
  prompt: true,
  toolResult: false,
  slashCommand: false,
  systemReminder: false,
  subagent: true,
};

export function isNodeVisible(n: ForestNode, vf: VisibilityFilter): boolean {
  if (n.isSidechain && !vf.subagent) return false;
  if (n.role === "assistant") return vf.assistant;
  switch (n.subtype) {
    case "prompt": return vf.prompt;
    case "tool-result": return vf.toolResult;
    case "slash-command":
    case "slash-output": return vf.slashCommand;
    case "system-reminder": return vf.systemReminder;
    default: return true;
  }
}

export const LAYOUT = {
  nodeRadius: 4,
  /** Vertical spacing between chain nodes in grid mode (parent → child). */
  nodeSpacingV: 16,
  /** Horizontal spacing between sibling subtrees in grid mode (forks). */
  nodeSpacingH: 18,
  /** Gap between adjacent trees in a row. */
  treeGap: 80,
  /** Gap between wrapped rows of trees (currently unused — wrap is off). */
  rowGap: 240,
  /** Gap between projects in all-projects view. */
  projectGap: 240,
  /** Reserved at the top of the layout for project labels in all-projects view. */
  projectLabelHeight: 32,
  /** Column mode: vertical spacing between prompts in the spine.
   * Bigger than nodeSpacingV because prompts are 1.8× normal radius. */
  columnSpineV: 32,
  /** Column mode: horizontal spacing between side-chain nodes (right of each prompt). */
  columnSideH: 18,
  /** Column mode: vertical gap between sessions stacked top-to-bottom. */
  columnSessionGap: 180,
} as const;
