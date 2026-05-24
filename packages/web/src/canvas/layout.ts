import {
  type Bounds,
  DEFAULT_VISIBILITY,
  type ForestNode,
  type ForestPayload,
  LAYOUT,
  type Layout,
  type LayoutDirection,
  type LayoutEdge,
  type LayoutNode,
  type SequenceLink,
  type SessionBand,
  type ViewMode,
  type VisibilityFilter,
  isNodeVisible,
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
  visibility: VisibilityFilter = DEFAULT_VISIBILITY,
  direction: LayoutDirection = "grid",
  allowedSessions: Set<string> | null = null,
): Layout {
  // Filter nodes by scope (+ optional session allow-list from the facet filter)
  let scopeNodes = scopeProject
    ? payload.nodes.filter((n) => n.projectSlug === scopeProject)
    : payload.nodes;
  if (allowedSessions) {
    scopeNodes = scopeNodes.filter((n) => allowedSessions.has(n.sessionId));
  }

  // Full node map (visible + hidden) used to walk ancestor chains when hiding.
  const fullNodeMap = new Map<string, ForestNode>();
  for (const n of scopeNodes) fullNodeMap.set(n.id, n);

  // Visible nodes
  const visibleNodes = scopeNodes.filter((n) => isNodeVisible(n, visibility));
  const nodeMap = new Map<string, ForestNode>();
  for (const n of visibleNodes) nodeMap.set(n.id, n);

  // Effective-parent resolution: when a node's parent is hidden, walk up until
  // we find a visible ancestor (or null). That visible ancestor becomes the
  // effective parent for layout/edge purposes — so hidden nodes are transparent.
  const effectiveParent = new Map<string, string | null>();
  for (const n of visibleNodes) {
    let pid = n.parentId;
    while (pid != null) {
      const p = fullNodeMap.get(pid);
      if (!p) { pid = null; break; }
      if (isNodeVisible(p, visibility)) break;
      pid = p.parentId;
    }
    effectiveParent.set(n.id, pid);
  }

  // Build children adjacency from EFFECTIVE parents (not raw parentId)
  const childrenOf = new Map<string, Set<string>>();
  for (const n of visibleNodes) {
    const ep = effectiveParent.get(n.id) ?? null;
    if (ep == null) continue;
    if (!nodeMap.has(ep)) continue; // safety
    let kids = childrenOf.get(ep);
    if (!kids) {
      kids = new Set();
      childrenOf.set(ep, kids);
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

  // Per-session start time (earliest VISIBLE node timestamp) for stable ordering.
  const sessionStartTime = new Map<string, string>();
  for (const n of visibleNodes) {
    const cur = sessionStartTime.get(n.sessionId);
    if (!cur || n.timestamp < cur) sessionStartTime.set(n.sessionId, n.timestamp);
  }

  // Find roots: visible nodes whose effective parent is null
  const roots: string[] = [];
  for (const n of visibleNodes) {
    if (effectiveParent.get(n.id) == null) roots.push(n.id);
  }
  // Sort roots by (project, session start time, sessionId, timestamp).
  // Critical: grouping by sessionId keeps a session's multiple roots (main + subagents)
  // contiguous in x, so its band is one tidy box instead of spanning across other sessions.
  roots.sort((a, b) => {
    const na = nodeMap.get(a)!;
    const nb = nodeMap.get(b)!;
    if (na.projectSlug !== nb.projectSlug) return na.projectSlug.localeCompare(nb.projectSlug);
    const sa = sessionStartTime.get(na.sessionId) ?? na.timestamp;
    const sb = sessionStartTime.get(nb.sessionId) ?? nb.timestamp;
    if (sa !== sb) return sa.localeCompare(sb);
    if (na.sessionId !== nb.sessionId) return na.sessionId.localeCompare(nb.sessionId);
    return na.timestamp.localeCompare(nb.timestamp);
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

  // Compute subtree HEIGHTS (depth × spacing) so we can pick a row-wrap target
  // that produces a roughly square overall layout. Without wrapping, 60+ sessions
  // pack into one wide horizontal strip.
  const subtreeHeight = new Map<string, number>();
  const heightVisited = new Set<string>();
  const computeHeight = (id: string): number => {
    if (subtreeHeight.has(id)) return subtreeHeight.get(id)!;
    if (heightVisited.has(id)) return LAYOUT.nodeSpacingV;
    heightVisited.add(id);
    const kids = sortedChildren.get(id);
    if (!kids || kids.length === 0) {
      subtreeHeight.set(id, LAYOUT.nodeSpacingV);
      return LAYOUT.nodeSpacingV;
    }
    let maxKid = 0;
    for (const k of kids) {
      const kh = computeHeight(k);
      if (kh > maxKid) maxKid = kh;
    }
    subtreeHeight.set(id, maxKid + LAYOUT.nodeSpacingV);
    return subtreeHeight.get(id)!;
  };
  for (const r of roots) computeHeight(r);

  // ───── Column-mode layout: prompt spine vertical, side chains right ─────
  // Each visible prompt sits in a vertical column at x = sessionBaseX.
  // Each prompt's response chain (assistant → tool → assistant → ...) extends RIGHT.
  // Multiple sessions stack vertically with a session gap.
  if (direction === "column") {
    const layoutNodes = new Map<string, LayoutNode>();
    const edges: LayoutEdge[] = [];
    const projectBands = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();

    const isPrompt = (n: ForestNode) => n.role === "user" && n.subtype === "prompt";

    const placeNode = (n: ForestNode, x: number, y: number) => {
      layoutNodes.set(n.id, {
        id: n.id,
        x, y,
        projectSlug: n.projectSlug,
        sessionId: n.sessionId,
        role: n.role,
        subtype: n.subtype,
        isSidechain: n.isSidechain,
        isFork: forkParents.has(n.id),
        isShared: n.sessionsIn > 1,
        preview: n.preview,
      });
    };

    /** Place a subtree in column-mode. Returns the max Y reached (for sibling placement). */
    const placeColumnSubtree = (rootId: string, baseX: number, baseY: number): number => {
      if (layoutNodes.has(rootId)) return baseY;
      const rootNode = nodeMap.get(rootId);
      if (!rootNode) return baseY;
      // Walk linear chain to the right. Collect any prompt children along the way for placement below.
      let cur: string = rootId;
      let x = baseX;
      const promptChildren: string[] = [];
      const seenInChain = new Set<string>();
      while (true) {
        const node = nodeMap.get(cur);
        if (!node) break;
        if (seenInChain.has(cur)) break; // cycle defense
        seenInChain.add(cur);
        placeNode(node, x, baseY);
        const kids = sortedChildren.get(cur);
        if (!kids || kids.length === 0) break;
        let nextSideKid: string | null = null;
        for (const k of kids) {
          const kn = nodeMap.get(k);
          if (!kn) continue;
          if (isPrompt(kn)) {
            promptChildren.push(k);
          } else if (!nextSideKid) {
            nextSideKid = k;
          }
        }
        if (!nextSideKid) break;
        edges.push({ fromId: cur, toId: nextSideKid, isFork: false });
        x += LAYOUT.columnSideH;
        cur = nextSideKid;
      }
      // Place prompt children below, sequentially
      let nextY = baseY + LAYOUT.columnSpineV;
      for (const pId of promptChildren) {
        if (layoutNodes.has(pId)) continue;
        // Edge from this prompt's parent (last node we walked) to the prompt — but we've already
        // walked past. Just emit edge from the chain's final node IF the prompt's parent is in chain.
        const promptNode = nodeMap.get(pId);
        if (promptNode && promptNode.parentId && layoutNodes.has(promptNode.parentId)) {
          edges.push({ fromId: promptNode.parentId, toId: pId, isFork: false });
        }
        nextY = placeColumnSubtree(pId, baseX, nextY) + LAYOUT.columnSpineV;
      }
      return Math.max(baseY, nextY - LAYOUT.columnSpineV);
    };

    // Group roots by session, in session-start order
    const sessionsInOrder = [...new Set(
      roots
        .map((r) => nodeMap.get(r)!.sessionId)
    )].sort((a, b) => {
      const sa = sessionStartTime.get(a) ?? "";
      const sb = sessionStartTime.get(b) ?? "";
      return sa.localeCompare(sb);
    });

    let cursorY = mode === "all-projects" ? LAYOUT.projectLabelHeight : 0;
    let lastProject: string | null = null;
    for (const sid of sessionsInOrder) {
      const sessionRoots = roots
        .filter((r) => nodeMap.get(r)!.sessionId === sid)
        .sort((a, b) => {
          const ta = nodeMap.get(a)!.timestamp;
          const tb = nodeMap.get(b)!.timestamp;
          return ta.localeCompare(tb);
        });
      if (sessionRoots.length === 0) continue;
      const proj = nodeMap.get(sessionRoots[0]!)!.projectSlug;
      if (lastProject !== null && proj !== lastProject && mode === "all-projects") {
        cursorY += LAYOUT.projectGap;
      }
      lastProject = proj;

      const startY = cursorY;
      for (const rid of sessionRoots) {
        const reached = placeColumnSubtree(rid, 0, cursorY);
        cursorY = reached + LAYOUT.columnSpineV;
      }
      cursorY += LAYOUT.columnSessionGap;

      // Track project band y-extent
      const pb = projectBands.get(proj);
      const maxX = [...layoutNodes.values()]
        .filter((n) => n.sessionId === sid)
        .reduce((m, n) => Math.max(m, n.x), 0);
      if (!pb) {
        projectBands.set(proj, { minX: 0, maxX, minY: startY, maxY: cursorY });
      } else {
        pb.maxX = Math.max(pb.maxX, maxX);
        pb.maxY = cursorY;
      }
    }

    // Bounds
    const bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    if (layoutNodes.size > 0) {
      bounds.minX = Infinity; bounds.minY = Infinity;
      bounds.maxX = -Infinity; bounds.maxY = -Infinity;
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

    // Session bands (same algorithm as grid mode but using column-placed nodes)
    const bandAcc = new Map<string, { sessionId: string; projectSlug: string; minX: number; maxX: number; minY: number; maxY: number; nodeCount: number; firstPromptTs: string; firstPrompt: string }>();
    for (const ln of layoutNodes.values()) {
      let acc = bandAcc.get(ln.sessionId);
      if (!acc) {
        acc = { sessionId: ln.sessionId, projectSlug: ln.projectSlug, minX: ln.x, maxX: ln.x, minY: ln.y, maxY: ln.y, nodeCount: 0, firstPromptTs: "", firstPrompt: "" };
        bandAcc.set(ln.sessionId, acc);
      }
      acc.minX = Math.min(acc.minX, ln.x); acc.maxX = Math.max(acc.maxX, ln.x);
      acc.minY = Math.min(acc.minY, ln.y); acc.maxY = Math.max(acc.maxY, ln.y);
      acc.nodeCount += 1;
    }
    for (const n of scopeNodes) {
      if (n.role !== "user" || n.subtype !== "prompt") continue;
      const acc = bandAcc.get(n.sessionId);
      if (!acc) continue;
      if (!acc.firstPromptTs || n.timestamp < acc.firstPromptTs) {
        acc.firstPromptTs = n.timestamp;
        acc.firstPrompt = n.preview;
      }
    }
    const sessionBands: SessionBand[] = [];
    for (const a of bandAcc.values()) {
      sessionBands.push({
        sessionId: a.sessionId, projectSlug: a.projectSlug,
        minX: a.minX - LAYOUT.nodeRadius - 2, maxX: a.maxX + LAYOUT.nodeRadius + 2,
        minY: a.minY - LAYOUT.nodeRadius - 2, maxY: a.maxY + LAYOUT.nodeRadius + 2,
        nodeCount: a.nodeCount, firstPrompt: a.firstPrompt,
      });
    }
    sessionBands.sort((a, b) => a.minY - b.minY || a.minX - b.minX);

    return { nodes: layoutNodes, edges, bounds, projectBands, sessionBands, sequenceLinks: [] };
  }

  // Pick a row-wrap width that targets roughly square overall aspect ratio.
  // For one project: aspectTarget = ~1.6 (slightly wider than tall reads better on screens).
  // For all-projects (which has projects side-by-side): aspectTarget = ~1.2.
  const totalTreeWidth = roots.reduce(
    (sum, r) => sum + (subtreeWidth.get(r) ?? 0) + LAYOUT.treeGap,
    0,
  );
  const maxTreeHeight = roots.reduce(
    (max, r) => Math.max(max, subtreeHeight.get(r) ?? 0),
    0,
  );
  const aspectTarget = 1.6;
  const targetRowWidth = Math.max(
    maxTreeHeight * aspectTarget,
    Math.sqrt(totalTreeWidth * maxTreeHeight * aspectTarget),
  );

  // Lay out roots into rows. Project boundaries (in all-projects view) force a new row.
  const projectBands = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
  const layoutNodes = new Map<string, LayoutNode>();
  const edges: LayoutEdge[] = [];

  let cursorX = 0;
  let cursorY = mode === "all-projects" ? LAYOUT.projectLabelHeight : 0;
  let rowMaxHeight = 0;
  let lastProject: string | null = null;

  const newRow = () => {
    cursorY += rowMaxHeight + LAYOUT.rowGap;
    cursorX = 0;
    rowMaxHeight = 0;
  };

  for (const rootId of roots) {
    const rootNode = nodeMap.get(rootId)!;
    const rootWidth = subtreeWidth.get(rootId)!;
    const rootHeight = subtreeHeight.get(rootId)!;
    // Project boundary in all-projects mode → force new row + add project gap
    if (lastProject !== null && rootNode.projectSlug !== lastProject) {
      if (mode === "all-projects") {
        newRow();
        cursorY += LAYOUT.projectGap;
      }
    }
    lastProject = rootNode.projectSlug;
    // No within-project wrap: trees flow continuously as one row per project.
    // Project boundaries still force newRow() above. User can pan/zoom horizontally.
    void rootWidth; void targetRowWidth;
    placeTree(rootId, cursorX, cursorY, {
      nodeMap,
      sortedChildren,
      subtreeWidth,
      layoutNodes,
      edges,
      forkParents,
      payloadIndex: payload,
    });
    // Track project band — needs minY/maxY too so hulls only cover the project's
    // actual Y range, not the full layout height (which would make all hulls overlap).
    const band = projectBands.get(rootNode.projectSlug);
    if (!band) {
      projectBands.set(rootNode.projectSlug, {
        minX: cursorX,
        maxX: cursorX + rootWidth,
        minY: cursorY,
        maxY: cursorY + rootHeight,
      });
    } else {
      band.minX = Math.min(band.minX, cursorX);
      band.maxX = Math.max(band.maxX, cursorX + rootWidth);
      band.minY = Math.min(band.minY, cursorY);
      band.maxY = Math.max(band.maxY, cursorY + rootHeight);
    }
    cursorX += rootWidth + LAYOUT.treeGap;
    if (rootHeight > rowMaxHeight) rowMaxHeight = rootHeight;
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

  // Per-session bounding boxes. CRITICAL: with --fork-session sharing uuids
  // across files, naive "group by node.sessionId" makes a session's band span
  // its divergent fork-children placed deep in the parent session's territory.
  // Instead, attribute each node to the SESSION OF ITS SUBTREE ROOT — the
  // root that contains it in the rendered tree. That gives clean, contiguous bands.
  const nodeToRootSession = new Map<string, string>();
  for (const rootId of roots) {
    const root = nodeMap.get(rootId);
    if (!root) continue;
    const sid = root.sessionId;
    // DFS from this root, tagging untagged descendants.
    const stack: string[] = [rootId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (nodeToRootSession.has(cur)) continue;
      nodeToRootSession.set(cur, sid);
      const kids = sortedChildren.get(cur);
      if (kids) for (const k of kids) stack.push(k);
    }
  }

  const bandAcc = new Map<string, {
    sessionId: string;
    projectSlug: string;
    minX: number; maxX: number; minY: number; maxY: number;
    nodeCount: number;
    firstPromptTs: string;
    firstPrompt: string;
  }>();
  for (const ln of layoutNodes.values()) {
    const sid = nodeToRootSession.get(ln.id) ?? ln.sessionId;
    let acc = bandAcc.get(sid);
    if (!acc) {
      acc = {
        sessionId: sid,
        projectSlug: ln.projectSlug,
        minX: ln.x, maxX: ln.x, minY: ln.y, maxY: ln.y,
        nodeCount: 0,
        firstPromptTs: "",
        firstPrompt: "",
      };
      bandAcc.set(sid, acc);
    }
    acc.minX = Math.min(acc.minX, ln.x);
    acc.maxX = Math.max(acc.maxX, ln.x);
    acc.minY = Math.min(acc.minY, ln.y);
    acc.maxY = Math.max(acc.maxY, ln.y);
    acc.nodeCount += 1;
  }
  // First prompt per session label = earliest user "prompt" — use scopeNodes
  // (regardless of visibility filter) so the label stays informative even when
  // prompts are hidden.
  for (const n of scopeNodes) {
    if (n.role !== "user" || n.subtype !== "prompt") continue;
    const acc = bandAcc.get(n.sessionId);
    if (!acc) continue;
    if (!acc.firstPromptTs || n.timestamp < acc.firstPromptTs) {
      acc.firstPromptTs = n.timestamp;
      acc.firstPrompt = n.preview;
    }
  }
  const sessionBands: SessionBand[] = [];
  for (const a of bandAcc.values()) {
    sessionBands.push({
      sessionId: a.sessionId,
      projectSlug: a.projectSlug,
      minX: a.minX - LAYOUT.nodeRadius - 2,
      maxX: a.maxX + LAYOUT.nodeRadius + 2,
      minY: a.minY - LAYOUT.nodeRadius - 2,
      maxY: a.maxY + LAYOUT.nodeRadius + 2,
      nodeCount: a.nodeCount,
      firstPrompt: a.firstPrompt,
    });
  }
  // Stable sort by minX then minY for consistent draw order
  sessionBands.sort((a, b) => a.minX - b.minX || a.minY - b.minY);

  // Sequence links: when a session has multiple roots (subagents, /compact splits,
  // /clear breaks, etc.), draw dashed lines from end of root N to start of root N+1
  // in timestamp order so the user can see they belong to the same session.
  const rootsBySession = new Map<string, string[]>();
  for (const rootId of roots) {
    const r = nodeMap.get(rootId);
    if (!r) continue;
    const arr = rootsBySession.get(r.sessionId);
    if (arr) arr.push(rootId);
    else rootsBySession.set(r.sessionId, [rootId]);
  }
  // Helper: find the deepest descendant (greatest y) of a root via DFS along sortedChildren
  const deepestDescendant = (rootId: string): string => {
    let bestId = rootId;
    let bestY = layoutNodes.get(rootId)?.y ?? 0;
    const stack: string[] = [rootId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = layoutNodes.get(cur);
      if (node && node.y > bestY) { bestY = node.y; bestId = cur; }
      const kids = sortedChildren.get(cur);
      if (kids) for (const k of kids) stack.push(k);
    }
    return bestId;
  };
  const sequenceLinks: SequenceLink[] = [];
  for (const [sid, rootIds] of rootsBySession) {
    if (rootIds.length < 2) continue;
    // Sort roots by their first node's timestamp
    const sortedRoots = [...rootIds].sort((a, b) => {
      const ta = nodeMap.get(a)?.timestamp ?? "";
      const tb = nodeMap.get(b)?.timestamp ?? "";
      return ta.localeCompare(tb);
    });
    for (let i = 0; i < sortedRoots.length - 1; i++) {
      const fromRoot = sortedRoots[i]!;
      const toRoot = sortedRoots[i + 1]!;
      const fromId = deepestDescendant(fromRoot);
      sequenceLinks.push({
        fromId,
        toId: toRoot,
        sessionId: sid,
        projectSlug: nodeMap.get(toRoot)?.projectSlug ?? "",
      });
    }
  }

  return { nodes: layoutNodes, edges, bounds, projectBands, sessionBands, sequenceLinks };
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
