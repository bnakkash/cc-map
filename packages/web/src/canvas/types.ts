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

export interface Layout {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  bounds: Bounds;
  /** projectSlug -> [minX, maxX] for drawing labels above project blocks. */
  projectBands: Map<string, { minX: number; maxX: number; y: number }>;
}

export type ViewMode = "per-project" | "all-projects";

export const LAYOUT = {
  nodeRadius: 4,
  nodeSpacingV: 14,
  nodeSpacingH: 14,
  treeGap: 30,
  projectGap: 100,
  projectLabelHeight: 24,
} as const;
