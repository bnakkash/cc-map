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
  type NodeStyle,
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
  nodeStyle: NodeStyle = "dots",
): Layout {
  // Default vertical step (dots, or column-mode prompt placement). Card-mode
  // uses per-node heights computed from preview text length instead — fixed
  // SPACING_V caused short cards to leave gaps and long cards to overlap.
  const SPACING_V = LAYOUT.nodeSpacingV;
  const SPACING_H = nodeStyle === "cards" ? LAYOUT.cardSpacingH : LAYOUT.nodeSpacingH;
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

  /**
   * Card mode: per-node visual card height (no inter-card spacing).
   *
   * Cards grow vertically to fit text instead of being a fixed-size box, which
   * would either overlap on long messages or waste space on short ones. We
   * estimate wrapped line count from `preview.length / cardCharsPerLine`,
   * capped at `cardMaxLines`. The renderer uses the same formula and reads
   * the value back from `LayoutNode.cardHeight`.
   */
  const cardHeightFor = (id: string): number => {
    const n = nodeMap.get(id);
    const text = n?.preview ?? "";
    const rawLines = Math.max(1, Math.ceil(text.length / LAYOUT.cardCharsPerLine));
    const lines = Math.min(rawLines, LAYOUT.cardMaxLines);
    return LAYOUT.cardHeaderHeight + LAYOUT.cardLineHeight * lines + LAYOUT.cardPadding * 2;
  };

  /** Vertical layout step for a node: card height + spacing in card mode, fixed in dot mode. */
  const ownHeight = (id: string): number => {
    if (nodeStyle !== "cards") return SPACING_V;
    return cardHeightFor(id) + LAYOUT.cardSpacingV;
  };

  // Forks set (for highlighting): parent uuids whose children belong to 2+ sessions
  const forkParents = new Set<string>();
  for (const f of payload.forks) {
    if (nodeMap.has(f.parentUuid)) forkParents.add(f.parentUuid);
  }

  // Subagent counts per spawning parent uuid — computed from the RAW scope nodes
  // so it's accurate even when subagents are hidden by visibility filter.
  // A subagent "root" is a sidechain node with a non-null parentId (parser
  // attaches the spawning Task tool_use uuid as parentId).
  const subagentCountByParent = new Map<string, number>();
  for (const n of scopeNodes) {
    if (!n.isSidechain || n.parentId == null) continue;
    subagentCountByParent.set(n.parentId, (subagentCountByParent.get(n.parentId) ?? 0) + 1);
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

  // ───── Grid mode: VERTICAL stacking of fork siblings ─────
  // Each tree stays narrow (children of the same parent stack below each other
  // rather than fanning side-by-side). Subsequent siblings are offset slightly
  // to the right of the spine so edges can be traced visually.
  //
  // Width(node) = max(child widths + per-sibling offset)
  // Height(node) = nodeSpacingV (own row) + sum(child heights)
  const SIBLING_X_OFFSET: number = SPACING_H;
  const subtreeWidth = new Map<string, number>();
  const subtreeHeight = new Map<string, number>();
  const widthVisited = new Set<string>();
  const heightVisited = new Set<string>();
  const computeWidth = (id: string): number => {
    if (subtreeWidth.has(id)) return subtreeWidth.get(id)!;
    if (widthVisited.has(id)) return SPACING_H;
    widthVisited.add(id);
    const kids = sortedChildren.get(id);
    if (!kids || kids.length === 0) {
      subtreeWidth.set(id, SPACING_H);
      return SPACING_H;
    }
    let maxKidWidth: number = SPACING_H;
    for (let i = 0; i < kids.length; i++) {
      const kw = computeWidth(kids[i]!);
      const candidate = kw + i * SIBLING_X_OFFSET;
      if (candidate > maxKidWidth) maxKidWidth = candidate;
    }
    subtreeWidth.set(id, maxKidWidth);
    return subtreeWidth.get(id)!;
  };
  const computeHeight = (id: string): number => {
    if (subtreeHeight.has(id)) return subtreeHeight.get(id)!;
    if (heightVisited.has(id)) return ownHeight(id);
    heightVisited.add(id);
    const myH = ownHeight(id);
    const kids = sortedChildren.get(id);
    if (!kids || kids.length === 0) {
      subtreeHeight.set(id, myH);
      return myH;
    }
    let totalKidHeight = 0;
    for (const k of kids) {
      totalKidHeight += computeHeight(k);
    }
    subtreeHeight.set(id, myH + totalKidHeight);
    return subtreeHeight.get(id)!;
  };
  for (const r of roots) {
    computeWidth(r);
    computeHeight(r);
  }

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
      const node: LayoutNode = {
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
        timestamp: n.timestamp,
        outputTokens: n.outputTokens,
      };
      if (nodeStyle === "cards") node.cardHeight = cardHeightFor(n.id);
      layoutNodes.set(n.id, node);
    };

    // Horizontal step between adjacent chain nodes. In dot mode the chain is a
    // tight 18px stagger (dots are 4px). In card mode each card is 260px wide,
    // so we step by cardWidth + a small gap to avoid overlap.
    const CHAIN_STEP_H = nodeStyle === "cards" ? LAYOUT.cardWidth + 16 : LAYOUT.columnSideH;

    /** Place a subtree in column-mode. Returns the max Y reached (for sibling placement). */
    const placeColumnSubtree = (rootId: string, baseX: number, baseY: number): number => {
      if (layoutNodes.has(rootId)) return baseY;
      const rootNode = nodeMap.get(rootId);
      if (!rootNode) return baseY;
      // Walk linear chain to the right. Collect any prompt children along the way for placement below.
      // Track tallest card in this row so the next row doesn't overlap it.
      let cur: string = rootId;
      let x = baseX;
      let rowMaxH = 0;
      const promptChildren: string[] = [];
      const seenInChain = new Set<string>();
      while (true) {
        const node = nodeMap.get(cur);
        if (!node) break;
        if (seenInChain.has(cur)) break; // cycle defense
        seenInChain.add(cur);
        placeNode(node, x, baseY);
        if (nodeStyle === "cards") {
          const h = cardHeightFor(cur);
          if (h > rowMaxH) rowMaxH = h;
        }
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
        x += CHAIN_STEP_H;
        cur = nextSideKid;
      }
      // Vertical step from this row to the next prompt. In card mode use the
      // tallest card in the row + spacing so the next row clears it; in dot
      // mode use the fixed columnSpineV.
      const stepV = nodeStyle === "cards"
        ? rowMaxH + LAYOUT.cardSpacingV
        : LAYOUT.columnSpineV;
      let nextY = baseY + stepV;
      for (const pId of promptChildren) {
        if (layoutNodes.has(pId)) continue;
        const promptNode = nodeMap.get(pId);
        if (promptNode && promptNode.parentId && layoutNodes.has(promptNode.parentId)) {
          edges.push({ fromId: promptNode.parentId, toId: pId, isFork: false });
        }
        const childStep = nodeStyle === "cards"
          ? cardHeightFor(pId) + LAYOUT.cardSpacingV
          : LAYOUT.columnSpineV;
        nextY = placeColumnSubtree(pId, baseX, nextY) + childStep;
      }
      return Math.max(baseY, nextY - (nodeStyle === "cards" ? LAYOUT.cardSpacingV : LAYOUT.columnSpineV));
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
    const sparks = buildTokenSparks(layoutNodes);
    const sessionBands: SessionBand[] = [];
    for (const a of bandAcc.values()) {
      sessionBands.push({
        sessionId: a.sessionId, projectSlug: a.projectSlug,
        minX: a.minX - LAYOUT.nodeRadius - 2, maxX: a.maxX + LAYOUT.nodeRadius + 2,
        minY: a.minY - LAYOUT.nodeRadius - 2, maxY: a.maxY + LAYOUT.nodeRadius + 2,
        nodeCount: a.nodeCount, firstPrompt: a.firstPrompt,
        tokenSpark: sparks.get(a.sessionId)?.values ?? [],
        sparkNodeIds: sparks.get(a.sessionId)?.ids ?? [],
      });
    }
    sessionBands.sort((a, b) => a.minY - b.minY || a.minX - b.minX);

    return { nodes: layoutNodes, edges, bounds, projectBands, sessionBands, sequenceLinks: [], subagentCountByParent };
  }

  // ───── Timeline layout: Y proportional to timestamp within each session ─────
  // One column per session, ordered left-to-right by session start time. Within
  // a column, vertical gaps between adjacent messages reflect real elapsed
  // time — so burst sessions look tight and "came back next day" gaps look
  // distinct. Gap is clamped [MIN_GAP, MAX_GAP] so a 1-week pause isn't a mile
  // of empty space and a 5-second reply isn't invisible.
  if (direction === "timeline") {
    const layoutNodes = new Map<string, LayoutNode>();
    const edges: LayoutEdge[] = [];
    const projectBands = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();

    const COLUMN_W = nodeStyle === "cards" ? LAYOUT.cardWidth + 60 : 90;
    const PX_PER_MIN = 6;
    const MIN_GAP = 16;
    const MAX_GAP = 140;

    const sessionsInOrder = [...new Set(visibleNodes.map((n) => n.sessionId))].sort((a, b) => {
      const sa = sessionStartTime.get(a) ?? "";
      const sb = sessionStartTime.get(b) ?? "";
      return sa.localeCompare(sb);
    });

    const baseY = mode === "all-projects" ? LAYOUT.projectLabelHeight : 0;
    const nodeGapToPrev = new Map<string, number>();
    const timelineAnchors = new Map<
      string,
      { x: number; xRight: number; lastY: number; lastTs: number }
    >();

    for (let i = 0; i < sessionsInOrder.length; i++) {
      const sid = sessionsInOrder[i]!;
      const colX = i * COLUMN_W;
      const nodesInSession = visibleNodes
        .filter((n) => n.sessionId === sid)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      if (nodesInSession.length === 0) continue;
      const proj = nodesInSession[0]!.projectSlug;

      let prevTs: number | null = null;
      let cy = baseY;
      for (const n of nodesInSession) {
        const ts = Date.parse(n.timestamp);
        if (prevTs !== null && Number.isFinite(ts) && Number.isFinite(prevTs)) {
          const dMin = Math.max(0, (ts - prevTs) / 60000);
          const gap = Math.min(MAX_GAP, Math.max(MIN_GAP, dMin * PX_PER_MIN));
          cy += gap;
          nodeGapToPrev.set(n.id, ts - prevTs);
        }
        const node: LayoutNode = {
          id: n.id,
          x: colX,
          y: cy,
          projectSlug: n.projectSlug,
          sessionId: n.sessionId,
          role: n.role,
          subtype: n.subtype,
          isSidechain: n.isSidechain,
          isFork: forkParents.has(n.id),
          isShared: n.sessionsIn > 1,
          preview: n.preview,
          timestamp: n.timestamp,
          outputTokens: n.outputTokens,
        };
        if (nodeStyle === "cards") {
          node.cardHeight = cardHeightFor(n.id);
          // Advance cy past the card body so the next message lands below it.
          // (Gap is added at top of next iter; here we account for the card's own height.)
          cy += node.cardHeight;
        }
        layoutNodes.set(n.id, node);
        if (Number.isFinite(ts)) prevTs = ts;
      }

      // Record anchor: latest node's Y + ts so the now-line can extrapolate
      // using the same gap formula. xRight reflects how wide the column needs
      // to be for the now-line span (covers the card width in cards mode).
      const lastNode = nodesInSession[nodesInSession.length - 1]!;
      const lastTs = Date.parse(lastNode.timestamp);
      if (Number.isFinite(lastTs)) {
        timelineAnchors.set(sid, {
          x: colX,
          xRight: colX + (nodeStyle === "cards" ? LAYOUT.cardWidth : 30),
          lastY: layoutNodes.get(lastNode.id)?.y ?? cy,
          lastTs,
        });
      }

      // Project band
      const minY = baseY;
      const maxY = cy;
      const maxX = colX + (nodeStyle === "cards" ? LAYOUT.cardWidth : 0);
      const pb = projectBands.get(proj);
      if (!pb) projectBands.set(proj, { minX: colX, maxX, minY, maxY });
      else {
        pb.minX = Math.min(pb.minX, colX);
        pb.maxX = Math.max(pb.maxX, maxX);
        pb.maxY = Math.max(pb.maxY, maxY);
      }
    }

    // Edges from parent → child (chronologically: in timeline mode the child is
    // visually below the parent inside the same column; cross-session forks go
    // sideways to another column)
    for (const [parentId, kids] of sortedChildren) {
      if (!layoutNodes.has(parentId)) continue;
      for (const kid of kids) {
        if (!layoutNodes.has(kid)) continue;
        const parentSession = layoutNodes.get(parentId)!.sessionId;
        const kidSession = layoutNodes.get(kid)!.sessionId;
        edges.push({ fromId: parentId, toId: kid, isFork: parentSession !== kidSession });
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

    // Session bands + sparks
    const bandAcc = new Map<string, { sessionId: string; projectSlug: string; minX: number; maxX: number; minY: number; maxY: number; nodeCount: number; firstPromptTs: string; firstPrompt: string }>();
    for (const ln of layoutNodes.values()) {
      let acc = bandAcc.get(ln.sessionId);
      const cardOffsetX = nodeStyle === "cards" ? LAYOUT.cardWidth : 0;
      const cardOffsetY = nodeStyle === "cards" ? (ln.cardHeight ?? 0) : 0;
      if (!acc) {
        acc = { sessionId: ln.sessionId, projectSlug: ln.projectSlug, minX: ln.x, maxX: ln.x + cardOffsetX, minY: ln.y, maxY: ln.y + cardOffsetY, nodeCount: 0, firstPromptTs: "", firstPrompt: "" };
        bandAcc.set(ln.sessionId, acc);
      }
      acc.minX = Math.min(acc.minX, ln.x);
      acc.maxX = Math.max(acc.maxX, ln.x + cardOffsetX);
      acc.minY = Math.min(acc.minY, ln.y);
      acc.maxY = Math.max(acc.maxY, ln.y + cardOffsetY);
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
    const sparks = buildTokenSparks(layoutNodes);
    const sessionBands: SessionBand[] = [];
    for (const a of bandAcc.values()) {
      sessionBands.push({
        sessionId: a.sessionId, projectSlug: a.projectSlug,
        minX: a.minX - LAYOUT.nodeRadius - 2, maxX: a.maxX + LAYOUT.nodeRadius + 2,
        minY: a.minY - LAYOUT.nodeRadius - 2, maxY: a.maxY + LAYOUT.nodeRadius + 2,
        nodeCount: a.nodeCount, firstPrompt: a.firstPrompt,
        tokenSpark: sparks.get(a.sessionId)?.values ?? [],
        sparkNodeIds: sparks.get(a.sessionId)?.ids ?? [],
      });
    }
    sessionBands.sort((a, b) => a.minX - b.minX || a.minY - b.minY);

    return { nodes: layoutNodes, edges, bounds, projectBands, sessionBands, sequenceLinks: [], subagentCountByParent, nodeGapToPrev, timelineAnchors };
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

  // ───── Macro layout: SESSIONS stack vertically ─────
  // Each root tree is placed at x=0 and cursorY advances by its height.
  // Roots from the same session are contiguous (because of root sort order),
  // so a session forms a vertical block. Projects separated by projectGap.
  let cursorY = mode === "all-projects" ? LAYOUT.projectLabelHeight : 0;
  let lastProject: string | null = null;
  let lastSession: string | null = null;
  void targetRowWidth;

  for (const rootId of roots) {
    const rootNode = nodeMap.get(rootId)!;
    const rootWidth = subtreeWidth.get(rootId)!;
    const rootHeight = subtreeHeight.get(rootId)!;
    // Project boundary in all-projects mode
    if (lastProject !== null && rootNode.projectSlug !== lastProject) {
      if (mode === "all-projects") cursorY += LAYOUT.projectGap;
    }
    // Session boundary within same project — small gap between sessions
    if (lastSession !== null && rootNode.sessionId !== lastSession) {
      cursorY += LAYOUT.treeGap;
    }
    lastProject = rootNode.projectSlug;
    lastSession = rootNode.sessionId;

    placeTree(rootId, 0, cursorY, {
      nodeMap,
      sortedChildren,
      subtreeWidth,
      subtreeHeight,
      layoutNodes,
      edges,
      forkParents,
      payloadIndex: payload,
      spacingV: SPACING_V,
      spacingH: SPACING_H,
      ownHeight,
      cardHeightFor,
      nodeStyle,
    });

    // Project band: track the y-range that this project occupies + max width
    const band = projectBands.get(rootNode.projectSlug);
    if (!band) {
      projectBands.set(rootNode.projectSlug, {
        minX: 0,
        maxX: rootWidth,
        minY: cursorY,
        maxY: cursorY + rootHeight,
      });
    } else {
      band.maxX = Math.max(band.maxX, rootWidth);
      band.maxY = cursorY + rootHeight;
    }
    cursorY += rootHeight + LAYOUT.nodeSpacingV;
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
  const sparks = buildTokenSparks(layoutNodes);
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
      tokenSpark: sparks.get(a.sessionId)?.values ?? [],
      sparkNodeIds: sparks.get(a.sessionId)?.ids ?? [],
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

  return { nodes: layoutNodes, edges, bounds, projectBands, sessionBands, sequenceLinks, subagentCountByParent };
}

function placeTree(
  id: string,
  xLeft: number,
  yTop: number,
  ctx: {
    nodeMap: Map<string, ForestNode>;
    sortedChildren: Map<string, string[]>;
    subtreeWidth: Map<string, number>;
    subtreeHeight: Map<string, number>;
    layoutNodes: Map<string, LayoutNode>;
    edges: LayoutEdge[];
    forkParents: Set<string>;
    payloadIndex: ForestPayload;
    spacingV: number;
    spacingH: number;
    ownHeight: (id: string) => number;
    cardHeightFor: (id: string) => number;
    nodeStyle: NodeStyle;
  },
): void {
  const node = ctx.nodeMap.get(id);
  if (!node) return;
  if (ctx.layoutNodes.has(id)) return;
  const myOwn = ctx.ownHeight(id);
  const layoutNode: LayoutNode = {
    id,
    x: xLeft,
    y: yTop,
    projectSlug: node.projectSlug,
    sessionId: node.sessionId,
    role: node.role,
    subtype: node.subtype,
    isSidechain: node.isSidechain,
    isFork: ctx.forkParents.has(id),
    isShared: node.sessionsIn > 1,
    preview: node.preview,
    timestamp: node.timestamp,
    outputTokens: node.outputTokens,
  };
  if (ctx.nodeStyle === "cards") layoutNode.cardHeight = ctx.cardHeightFor(id);
  ctx.layoutNodes.set(id, layoutNode);

  const kids = ctx.sortedChildren.get(id);
  if (!kids || kids.length === 0) return;

  // First child sits immediately below the parent's own footprint
  // (myOwn includes the per-row padding/spacing). Subsequent siblings step
  // right by ctx.spacingH so fork branches are distinguishable from the spine.
  let cy = yTop + myOwn;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i]!;
    const kh = ctx.subtreeHeight.get(kid)!;
    const cx = xLeft + i * ctx.spacingH;
    placeTree(kid, cx, cy, ctx);
    ctx.edges.push({
      fromId: id,
      toId: kid,
      isFork: kids.length > 1,
    });
    cy += kh;
  }
}

/**
 * Compute "where would wall-clock now land" in a session's timeline Y-space.
 * Uses the same clamped-gap formula as the timeline placement code so the
 * now-line is consistent with how the existing nodes were placed.
 */
export function timelineNowY(
  anchor: { lastY: number; lastTs: number },
  nowMs: number,
): number {
  const PX_PER_MIN = 6;
  const MIN_GAP = 16;
  const MAX_GAP = 140;
  const dMin = Math.max(0, (nowMs - anchor.lastTs) / 60000);
  const gap = Math.min(MAX_GAP, Math.max(MIN_GAP, dMin * PX_PER_MIN));
  return anchor.lastY + gap;
}

/**
 * Per-session output-tokens series + parallel node-id array. Restricted to
 * assistant turns (users don't produce output tokens), chronological order.
 * Used by the session-band sparkline overlay; the node-id array lets the
 * UI map a hovered bar back to a specific message.
 */
function buildTokenSparks(layoutNodes: Map<string, LayoutNode>): Map<string, { values: number[]; ids: string[] }> {
  const bySession = new Map<string, LayoutNode[]>();
  for (const n of layoutNodes.values()) {
    if (n.role !== "assistant") continue;
    let arr = bySession.get(n.sessionId);
    if (!arr) {
      arr = [];
      bySession.set(n.sessionId, arr);
    }
    arr.push(n);
  }
  const result = new Map<string, { values: number[]; ids: string[] }>();
  for (const [sid, nodes] of bySession) {
    nodes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    result.set(sid, { values: nodes.map((n) => n.outputTokens), ids: nodes.map((n) => n.id) });
  }
  return result;
}
