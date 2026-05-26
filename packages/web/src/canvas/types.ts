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
  /** Card height (layout units) in card mode — varies per node based on preview length. */
  cardHeight?: number;
  /** ISO timestamp — copied from ForestNode for color-by-recency rendering. */
  timestamp: string;
  /** Output tokens — copied from ForestNode for color-by-cost rendering. */
  outputTokens: number;
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
  /** Per-assistant-turn output-token series, in chronological order. Used by
   *  the sparkline overlay to show "thinking intensity" across the session
   *  without zooming into individual messages. */
  tokenSpark: number[];
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
  /** Number of subagent roots spawned by each parent uuid. Always computed from
   *  the raw forest, regardless of subagent visibility — so when subagents are
   *  hidden the renderer can draw a "+N" badge on the parent to signal what
   *  would expand. */
  subagentCountByParent: Map<string, number>;
  /** Timeline mode only: ms gap from previous chronological node in the same
   *  session. Used by the renderer to draw "+Xm" / "+Xh" / "+Xd" labels so
   *  users can see real time gaps without hovering each one. */
  nodeGapToPrev?: Map<string, number>;
  /** Timeline mode only: per-session anchor info so we can extrapolate "where
   *  is wall-clock now" in that session's Y space, for the live now-line. */
  timelineAnchors?: Map<
    string,
    {
      /** Layout-X of the session column. */
      x: number;
      /** Layout-X of the column's right edge. */
      xRight: number;
      /** Y of the last (chronologically latest) placed node in this session. */
      lastY: number;
      /** Timestamp ms of that last node. */
      lastTs: number;
    }
  >;
}

export type ViewMode = "per-project" | "all-projects";
/**
 *  - grid: square-ish tree-map, fork siblings stack vertically
 *  - column: each session a row; prompts vertical, replies horizontal
 *  - timeline: one column per session ordered left-to-right by session start;
 *    Y is timestamp-proportional within each session (with capped gaps so a
 *    week-long pause doesn't blow up the layout). Reveals temporal patterns
 *    invisible in topology layouts.
 */
export type LayoutDirection = "grid" | "column" | "timeline";
export type NodeStyle = "dots" | "cards";
/** Canvas background pattern. "none" = flat black; "grid" = faint zinc grid;
 *  "dots" = sparse zinc dot field. Helps orient pan/zoom on big maps. */
export type BackgroundStyle = "none" | "grid" | "dots";
/**
 * How nodes are colored.
 *  - role: by user/assistant/subtype (the original)
 *  - recency: gray → emerald gradient mapped onto each node's timestamp,
 *    so the most recent activity glows. Great for "what did I do today."
 *  - cost: gray → orange/red mapped onto assistant output-token spend,
 *    so expensive turns pop out. Great for finding "what burned the budget."
 */
export type ColorMode = "role" | "recency" | "cost";

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
  cardWidth: 260,
  /** Card line height. */
  cardLineHeight: 14,
  /** Padding inside each card. */
  cardPadding: 8,
  /** Height of the card header (role label row). */
  cardHeaderHeight: 16,
  /** Vertical gap between adjacent cards. */
  cardSpacingV: 14,
  /** Horizontal spacing between sibling cards. */
  cardSpacingH: 280,
  /** Approximate chars per line at cardWidth — used for height estimation. */
  cardCharsPerLine: 38,
  /** Hard cap on lines per card (above this we ellipsize). */
  cardMaxLines: 12,
} as const;
