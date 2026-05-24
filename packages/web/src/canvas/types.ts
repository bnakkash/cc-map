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
  /** Assistant output tokens (0 otherwise). Used for sparkline. */
  outputTokens: number;
}

export interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface SessionTitleInfo {
  aiTitle: string | null;
  tokens: SessionTokens;
  toolsUsed: string[];
  startedAt: string | null;
  lastActivityAt: string | null;
}

export interface SessionFilter {
  /** ISO date strings (YYYY-MM-DD). Sessions with no overlap are filtered out. */
  startDate: string | null;
  endDate: string | null;
  /** When non-empty, session must have used AT LEAST one of these tools. */
  requiredTools: string[];
  /** When true, only show bookmarked sessions (any node bookmarked counts). */
  bookmarkedOnly: boolean;
}

export const DEFAULT_FILTER: SessionFilter = {
  startDate: null,
  endDate: null,
  requiredTools: [],
  bookmarkedOnly: false,
};

export interface ForkInfo {
  parentUuid: string;
  sessionIds: string[];
}

export interface ProjectMeta {
  slug: string;
  sessionCount: number;
  tokens: SessionTokens;
}

export interface ForestPayload {
  nodes: ForestNode[];
  forks: ForkInfo[];
  projects: ProjectMeta[];
  sessionCount: number;
  /** The currently-active Claude Code session (from SessionStart hook, or most-recent fallback). */
  activeSessionId: string | null;
  activeSessionAt: string | null;
  /** Per-session metadata: ai-title + total token usage. Keyed by sessionId. */
  sessionTitles: Record<string, SessionTitleInfo>;
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
export type NodeStyle = "dots" | "cards";

/**
 * A user-created top-level workspace. Has a name + a curated list of session
 * IDs to include. Switching INTO a space shows the forest filtered to those
 * sessions only. Later (Phase 3c) spawning a new Claude Code session inside a
 * space automatically adds the new sessionId to its member list.
 */
export interface Space {
  id: string;
  name: string;
  /** HSL hue 0-360 for visual identification in the sidebar list. */
  hue: number;
  /** Session IDs that belong to this space. Filters the forest when active. */
  sessionIds: string[];
  /** Optional free-form note shown at the top of the space's canvas. */
  note: string;
  /** ISO timestamp of creation. */
  createdAt: string;
}

export interface SequenceLink {
  /** uuid of the last node in the previous root's chain (within the session) */
  fromId: string;
  /** uuid of the first node in the next root's chain */
  toId: string;
  sessionId: string;
  projectSlug: string;
}

export interface VisibilityFilter {
  /** Assistant turns with at least one text block (the human-readable reply). */
  assistantText: boolean;
  /** Assistant turns that are ONLY tool_use blocks — the JSON noise. */
  assistantToolOnly: boolean;
  /** Assistant turns that are ONLY thinking blocks — extended-thinking traces. */
  assistantThinking: boolean;
  prompt: boolean;
  toolResult: boolean;
  slashCommand: boolean;
  systemReminder: boolean;
  subagent: boolean;
}

export const DEFAULT_VISIBILITY: VisibilityFilter = {
  assistantText: true,
  assistantToolOnly: false,
  assistantThinking: false,
  prompt: true,
  toolResult: false,
  slashCommand: false,
  systemReminder: false,
  subagent: true,
};

export function isNodeVisible(n: ForestNode, vf: VisibilityFilter): boolean {
  if (n.isSidechain && !vf.subagent) return false;
  if (n.role === "assistant") {
    // ForestNode.subtype for assistant is "text" / "tool-only" / "thinking" / "other"
    if (n.subtype === "tool-only") return vf.assistantToolOnly;
    if (n.subtype === "thinking") return vf.assistantThinking;
    if (n.subtype === "other") return false; // empty/malformed — never useful
    return vf.assistantText; // "text"
  }
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
  // ───── Card mode (text-box rendering) ─────
  /** Card width in layout units. */
  cardWidth: 220,
  /** Card line height. Card total height = lineHeight × visible lines + padding. */
  cardLineHeight: 14,
  /** Padding inside each card. */
  cardPadding: 8,
  /** Vertical spacing between cards in card mode (replaces nodeSpacingV). */
  cardSpacingV: 12,
  /** Horizontal spacing between sibling cards in card mode (replaces nodeSpacingH). */
  cardSpacingH: 240,
  /** Max preview lines shown per card. */
  cardMaxLines: 4,
} as const;
