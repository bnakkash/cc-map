import {
  type Bounds,
  type ForestNode,
  type ForestPayload,
  LAYOUT,
  type Layout,
  type LayoutEdge,
  type LayoutNode,
  type ViewMode,
} from "./types.js";

/**
 * Build a tree-map layout from forest data.
 *
 * Strategy:
 *   - Dedup nodes by id (forest payload may have one entry per node, but
 *     adjacency from parentId is what we need).
 *   - Build children adjacency, dedup, sort by timestamp.
 *   - Find roots (parentId not in nodeMap, or null).
 *   - For each root, recursively compute subtree width, then assign x/y.
 *   - Pack roots left-to-right per project, with project blocks separated
 *     by a larger gap.
 *
 * Subagents (`isSidechain: true`) appear as additional roots — they have
 * `parentUuid: null` in their own JSONL files. We render them as siblings
 * of the main session tree they belong to.
 */
export function buildLayout(
  payload: ForestPayload,
  mode: ViewMode,
  scopeProject: string | null,
): Layout {
  // Filter nodes by scope
  const scopeNodes = scopeProject
    ? payload.nodes.filter((n) => n.projectSlug === scopeProject)
    : payload.nodes;

  // Index for quick lookup
  const nodeMap = new Map<string, ForestNode>();
  for (const n of scopeNodes) nodeMap.set(n.id, n);

  // Build children adjacency
  const childrenOf = new Map<string, Set<string>>();
  for (const n of scopeNodes) {
    if (n.parentId == null) continue;
    if (!nodeMap.has(n.parentId)) continue; // out of scope
    let kids = childrenOf.get(n.parentId);
    if (!kids) {
      kids = new Set();
      childrenOf.set(n.parentId, kids);
    }
    kids.add(n.id);
  }

  // Sort children by (timestamp, id) for determinism
  const sortedChildren = new Map<string, string[]>();
  for (const [parentId, set] of childrenOf) {
    const arr = [...set].sort((a, b) => {
      const ta = nodeMap.get(a)?.timestamp ?? "";
      const tb = nodeMap.get(b)?.timestamp ?? "";
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a.localeCompare(b);
    });
    sortedChildren.set(parentId, arr);
  }

  // Forks set (for highlighting): parent uuids whose children belong to 2+ sessions
  const forkParents = new Set<string>();
  for (const f of payload.forks) {
    if (nodeMap.has(f.parentUuid)) forkParents.add(f.parentUuid);
  }

  // Find roots: nodes whose parent isn't in our scope
  const roots: string[] = [];
  for (const n of scopeNodes) {
    if (n.parentId == null || !nodeMap.has(n.parentId)) {
      roots.push(n.id);
    }
  }
  // Sort roots by (project, timestamp) so per-project ordering is stable
  roots.sort((a, b) => {
    const na = nodeMap.get(a)!;
    const nb = nodeMap.get(b)!;
    if (na.projectSlug !== nb.projectSlug) return na.projectSlug.localeCompare(nb.projectSlug);
    if (na.timestamp < nb.timestamp) return -1;
    if (na.timestamp > nb.timestamp) return 1;
    return a.localeCompare(b);
  });

  // Compute subtree widths (memoized DFS)
  const subtreeWidth = new Map<string, number>();
  const visited = new Set<string>();
  const computeWidth = (id: string): number => {
    if (subtreeWidth.has(id)) return subtreeWidth.get(id)!;
    if (visited.has(id)) return LAYOUT.nodeSpacingH; // cycle defense
    visited.add(id);
    const kids = sortedChildren.get(id);
    if (!kids || kids.length === 0) {
      subtreeWidth.set(id, LAYOUT.nodeSpacingH);
      return LAYOUT.nodeSpacingH;
    }
    let total = 0;
    for (const k of kids) total += computeWidth(k);
    total += (kids.length - 1) * 0; // children are immediately adjacent
    subtreeWidth.set(id, Math.max(total, LAYOUT.nodeSpacingH));
    return subtreeWidth.get(id)!;
  };
  for (const r of roots) computeWidth(r);

  // Lay out: per-project view = one project's roots packed left-to-right.
  // all-projects view = projects laid out left-to-right with extra gap.
  const projectBands = new Map<string, { minX: number; maxX: number; y: number }>();
  const layoutNodes = new Map<string, LayoutNode>();
  const edges: LayoutEdge[] = [];

  let cursorX = 0;
  let lastProject: string | null = null;

  for (const rootId of roots) {
    const rootNode = nodeMap.get(rootId)!;
    if (lastProject !== null && rootNode.projectSlug !== lastProject) {
      // Project boundary in all-projects mode
      cursorX += mode === "all-projects" ? LAYOUT.projectGap : 0;
    }
    lastProject = rootNode.projectSlug;
    const rootWidth = subtreeWidth.get(rootId)!;
    placeTree(rootId, cursorX, mode === "all-projects" ? LAYOUT.projectLabelHeight : 0, {
      nodeMap,
      sortedChildren,
      subtreeWidth,
      layoutNodes,
      edges,
      forkParents,
      payloadIndex: payload,
    });
    // Track project band
    const band = projectBands.get(rootNode.projectSlug);
    if (!band) {
      projectBands.set(rootNode.projectSlug, {
        minX: cursorX,
        maxX: cursorX + rootWidth,
        y: 0,
      });
    } else {
      band.maxX = cursorX + rootWidth;
    }
    cursorX += rootWidth + LAYOUT.treeGap;
  }

  // Compute bounds
  const bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  if (layoutNodes.size > 0) {
    bounds.minX = Infinity;
    bounds.minY = Infinity;
    bounds.maxX = -Infinity;
    bounds.maxY = -Infinity;
    for (const n of layoutNodes.values()) {
      if (n.x < bounds.minX) bounds.minX = n.x;
      if (n.y < bounds.minY) bounds.minY = n.y;
      if (n.x > bounds.maxX) bounds.maxX = n.x;
      if (n.y > bounds.maxY) bounds.maxY = n.y;
    }
    bounds.minX -= LAYOUT.nodeRadius * 2;
    bounds.minY -= LAYOUT.nodeRadius * 2;
    bounds.maxX += LAYOUT.nodeRadius * 2;
    bounds.maxY += LAYOUT.nodeRadius * 2;
  }

  return { nodes: layoutNodes, edges, bounds, projectBands };
}

function placeTree(
  id: string,
  xLeft: number,
  yTop: number,
  ctx: {
    nodeMap: Map<string, ForestNode>;
    sortedChildren: Map<string, string[]>;
    subtreeWidth: Map<string, number>;
    layoutNodes: Map<string, LayoutNode>;
    edges: LayoutEdge[];
    forkParents: Set<string>;
    payloadIndex: ForestPayload;
  },
): void {
  const node = ctx.nodeMap.get(id);
  if (!node) return;
  if (ctx.layoutNodes.has(id)) return;
  const myWidth = ctx.subtreeWidth.get(id)!;
  const centerX = xLeft + myWidth / 2;
  const layoutNode: LayoutNode = {
    id,
    x: centerX,
    y: yTop,
    projectSlug: node.projectSlug,
    sessionId: node.sessionId,
    role: node.role,
    subtype: node.subtype,
    isSidechain: node.isSidechain,
    isFork: ctx.forkParents.has(id),
    isShared: node.sessionsIn > 1,
    preview: node.preview,
  };
  ctx.layoutNodes.set(id, layoutNode);

  const kids = ctx.sortedChildren.get(id);
  if (!kids || kids.length === 0) return;
  let cx = xLeft;
  for (const kid of kids) {
    const kw = ctx.subtreeWidth.get(kid)!;
    placeTree(kid, cx, yTop + LAYOUT.nodeSpacingV, ctx);
    ctx.edges.push({
      fromId: id,
      toId: kid,
      isFork: kids.length > 1,
    });
    cx += kw;
  }
}
