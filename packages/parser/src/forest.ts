import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extractSidecarHint, extractTaskSpawn, parseFile, parseLineToNode } from "./jsonl.js";
import type { Forest, ForkInfo, GraphNode, SessionMeta } from "./types.js";

interface SidecarAggregate {
  aiTitle?: string;
  toolsUsed: Set<string>;
}

/** Walk a file once to extract sidecar info (ai-title, tools used) that isn't a graph node. */
async function extractSidecars(filePath: string): Promise<Map<string, SidecarAggregate>> {
  const out = new Map<string, SidecarAggregate>();
  try {
    const text = await readFile(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const hint = extractSidecarHint(line);
      if (!hint) continue;
      let cur = out.get(hint.sessionId);
      if (!cur) {
        cur = { toolsUsed: new Set() };
        out.set(hint.sessionId, cur);
      }
      if (hint.aiTitle) cur.aiTitle = hint.aiTitle;
      if (hint.toolNames) {
        for (const n of hint.toolNames) cur.toolsUsed.add(n);
      }
    }
  } catch {
    // skip
  }
  return out;
}

export interface DiscoveredFile {
  filePath: string;
  projectSlug: string;
  sessionId: string;
  isSidechain: boolean;
}

/**
 * Walk ~/.claude/projects/ and return every JSONL file we care about.
 *
 * Structure observed:
 *   projects/<slug>/<sessionId>.jsonl                ← main session transcript
 *   projects/<slug>/<sessionId>/subagents/agent-*.jsonl  ← subagent transcripts
 *
 * `projectSlug` = directory name directly under `projects/`.
 * `sessionId` for main file = file basename (without .jsonl).
 * `sessionId` for subagent = the parent <sessionId> directory name.
 */
export async function discoverFiles(projectsRoot: string): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const projectDirs = await safeReaddir(projectsRoot);
  for (const projectSlug of projectDirs) {
    const projectPath = join(projectsRoot, projectSlug);
    if (!(await isDir(projectPath))) continue;
    const entries = await safeReaddir(projectPath);
    for (const entry of entries) {
      const fullPath = join(projectPath, entry);
      if (entry.endsWith(".jsonl")) {
        const sessionId = entry.slice(0, -".jsonl".length);
        out.push({ filePath: fullPath, projectSlug, sessionId, isSidechain: false });
      } else if (await isDir(fullPath)) {
        // Possible <sessionId>/subagents/
        const subPath = join(fullPath, "subagents");
        if (await isDir(subPath)) {
          const subFiles = await safeReaddir(subPath);
          for (const subFile of subFiles) {
            if (!subFile.endsWith(".jsonl")) continue;
            out.push({
              filePath: join(subPath, subFile),
              projectSlug,
              sessionId: entry, // parent <sessionId> dir
              isSidechain: true,
            });
          }
        }
      }
    }
  }
  return out;
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build a Forest from a stream of GraphNodes. Computes:
 *   - childrenOf adjacency, deduped + sorted by timestamp
 *   - sessionsContainingNode (which sessions each uuid appears in — `--fork-session`
 *     copies messages with the same uuid into new session files, so this is plural)
 *   - roots (nodes with no parent or whose parent isn't in `nodes`)
 *   - per-session metadata (counts include shared messages from forked sessions)
 *   - forks: uuids whose children belong to 2+ sessions = the fork POINT
 *
 * IMPORTANT: build adjacency from the raw stream BEFORE dedup. Otherwise, when
 * the same uuid appears in 3 forked-session files, dedup would discard 2 copies
 * and we'd lose 2/3 of the (parent → child) edges.
 *
 * Pure function — caller is responsible for getting the nodes.
 */
export function buildForest(nodes: Iterable<GraphNode>): Forest {
  const nodeMap = new Map<string, GraphNode>();
  const sessionsContainingNodeSet = new Map<string, Set<string>>();
  const childrenOfSet = new Map<string, Set<string>>();
  // For fork detection: parent uuid -> set of sessionIds its child-edges live in
  const parentToChildSessions = new Map<string, Set<string>>();

  // Per-session metadata accumulators. Count each appearance, including
  // shared-via-fork copies — that matches the user's mental model of "how
  // many messages did session X have."
  const sessionsAcc = new Map<string, SessionMeta>();

  for (const node of nodes) {
    // Dedup nodes (last-write-wins, but they should be content-equal for shared uuids)
    nodeMap.set(node.id, node);

    // Track every session this uuid appears in
    let setS = sessionsContainingNodeSet.get(node.id);
    if (!setS) {
      setS = new Set();
      sessionsContainingNodeSet.set(node.id, setS);
    }
    setS.add(node.sessionId);

    // Build edges from the raw stream — once per file appearance
    if (node.parentId != null) {
      let kids = childrenOfSet.get(node.parentId);
      if (!kids) {
        kids = new Set();
        childrenOfSet.set(node.parentId, kids);
      }
      kids.add(node.id);

      let sess = parentToChildSessions.get(node.parentId);
      if (!sess) {
        sess = new Set();
        parentToChildSessions.set(node.parentId, sess);
      }
      sess.add(node.sessionId);
    }

    // Per-session metadata. Each file-appearance counts.
    const isPrompt = node.classification.role === "user" && node.classification.subtype === "prompt";
    const existing = sessionsAcc.get(node.sessionId);
    if (!existing) {
      sessionsAcc.set(node.sessionId, {
        sessionId: node.sessionId,
        projectSlug: node.projectSlug,
        filePath: "",
        startedAt: node.timestamp,
        lastActivityAt: node.timestamp,
        cwd: node.cwd,
        nodeCount: 1,
        promptCount: isPrompt ? 1 : 0,
        aiTitle: null,
        totalUsage: {
          inputTokens: node.usage?.inputTokens ?? 0,
          outputTokens: node.usage?.outputTokens ?? 0,
          cacheReadTokens: node.usage?.cacheReadTokens ?? 0,
          cacheCreationTokens: node.usage?.cacheCreationTokens ?? 0,
        },
        toolsUsed: [],
      });
    } else {
      existing.nodeCount += 1;
      if (isPrompt) existing.promptCount += 1;
      if (!existing.startedAt || node.timestamp < existing.startedAt) {
        existing.startedAt = node.timestamp;
      }
      if (!existing.lastActivityAt || node.timestamp > existing.lastActivityAt) {
        existing.lastActivityAt = node.timestamp;
      }
      if (!existing.cwd && node.cwd) existing.cwd = node.cwd;
      if (node.usage) {
        existing.totalUsage.inputTokens += node.usage.inputTokens;
        existing.totalUsage.outputTokens += node.usage.outputTokens;
        existing.totalUsage.cacheReadTokens += node.usage.cacheReadTokens;
        existing.totalUsage.cacheCreationTokens += node.usage.cacheCreationTokens;
      }
    }
  }

  // Convert children sets to timestamp-sorted arrays
  const childrenOf = new Map<string, string[]>();
  for (const [parentId, set] of childrenOfSet) {
    const arr = [...set].sort((a, b) => {
      const na = nodeMap.get(a)?.timestamp ?? "";
      const nb = nodeMap.get(b)?.timestamp ?? "";
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    childrenOf.set(parentId, arr);
  }

  // Roots: deduped nodes whose parent isn't in nodeMap
  const roots: string[] = [];
  for (const node of nodeMap.values()) {
    if (node.parentId == null || !nodeMap.has(node.parentId)) {
      roots.push(node.id);
    }
  }
  roots.sort((a, b) => {
    const na = nodeMap.get(a)?.timestamp ?? "";
    const nb = nodeMap.get(b)?.timestamp ?? "";
    return na < nb ? -1 : na > nb ? 1 : 0;
  });

  // Forks: parent uuids whose children's edges originated from 2+ sessions
  const forks: ForkInfo[] = [];
  for (const [parentUuid, sessionSet] of parentToChildSessions) {
    if (sessionSet.size >= 2) {
      forks.push({ parentUuid, sessionIds: [...sessionSet].sort() });
    }
  }

  // Project index
  const projectsBySession = new Map<string, string>();
  const sessionsByProject = new Map<string, string[]>();
  for (const meta of sessionsAcc.values()) {
    projectsBySession.set(meta.sessionId, meta.projectSlug);
    const arr = sessionsByProject.get(meta.projectSlug);
    if (arr) arr.push(meta.sessionId);
    else sessionsByProject.set(meta.projectSlug, [meta.sessionId]);
  }
  for (const arr of sessionsByProject.values()) {
    arr.sort((a, b) => {
      const sa = sessionsAcc.get(a)?.startedAt ?? "";
      const sb = sessionsAcc.get(b)?.startedAt ?? "";
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }

  // Materialize sessionsContainingNode as arrays
  const sessionsContainingNode = new Map<string, string[]>();
  for (const [uuid, set] of sessionsContainingNodeSet) {
    sessionsContainingNode.set(uuid, [...set].sort());
  }

  return {
    nodes: nodeMap,
    sessionsContainingNode,
    childrenOf,
    roots,
    sessions: sessionsAcc,
    projectsBySession,
    sessionsByProject,
    forks,
  };
}

/**
 * High-level: discover + parse + build forest. Convenience for one-shot use.
 *
 * Subagent attachment: each subagent file's first message has `parentUuid: null`
 * but its `sessionId` + `timestamp` match the spawning assistant's Task tool_use
 * in the parent session file. We build a spawn index during parsing and rewrite
 * the subagent root's parentId so the forest reflects the actual conversation
 * graph (instead of subagents floating as orphan roots).
 */
export async function loadForest(projectsRoot: string): Promise<Forest> {
  const files = await discoverFiles(projectsRoot);
  const allNodes: GraphNode[] = [];
  // sessionId -> assistant turns that fired a Task call
  const spawnIndex = new Map<string, { uuid: string; timestamp: string }[]>();
  await Promise.all(
    files.map(async (f) => {
      try {
        const text = await readFile(f.filePath, "utf8");
        for (const line of text.split(/\r?\n/)) {
          const node = parseLineToNode(line, { projectSlug: f.projectSlug, sessionId: f.sessionId });
          if (node) allNodes.push(node);
          const spawn = extractTaskSpawn(line);
          if (spawn) {
            let arr = spawnIndex.get(spawn.sessionId);
            if (!arr) {
              arr = [];
              spawnIndex.set(spawn.sessionId, arr);
            }
            arr.push({ uuid: spawn.uuid, timestamp: spawn.timestamp });
          }
        }
      } catch {
        // skip unreadable files
      }
    }),
  );

  // Attach subagent roots to spawning assistants. Match by sessionId + timestamp
  // (within a 5-second tolerance; spawning Task call writes both records nearly simultaneously).
  let attachedCount = 0;
  for (const n of allNodes) {
    if (!n.isSidechain || n.parentId !== null) continue;
    const spawns = spawnIndex.get(n.sessionId);
    if (!spawns) continue;
    let best: { uuid: string; diffMs: number } | null = null;
    const nodeTs = new Date(n.timestamp).getTime();
    for (const s of spawns) {
      const diff = Math.abs(new Date(s.timestamp).getTime() - nodeTs);
      if (diff < 5000 && (!best || diff < best.diffMs)) {
        best = { uuid: s.uuid, diffMs: diff };
      }
    }
    if (best && best.uuid !== n.id) {
      n.parentId = best.uuid;
      attachedCount += 1;
    }
  }
  if (attachedCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`[loadForest] attached ${attachedCount} subagent root(s) to spawning Task assistants`);
  }

  const forest = buildForest(allNodes);
  // Backfill filePath on session metas
  for (const f of files) {
    if (f.isSidechain) continue;
    const meta = forest.sessions.get(f.sessionId);
    if (meta && !meta.filePath) meta.filePath = f.filePath;
  }
  // Backfill aiTitle + toolsUsed by scanning every file once for sidecar records
  const toolsBySession = new Map<string, Set<string>>();
  await Promise.all(
    files.map(async (f) => {
      const hints = await extractSidecars(f.filePath);
      for (const [sid, h] of hints) {
        const meta = forest.sessions.get(sid);
        if (meta && h.aiTitle && !meta.aiTitle) meta.aiTitle = h.aiTitle;
        if (h.toolsUsed.size > 0) {
          let acc = toolsBySession.get(sid);
          if (!acc) { acc = new Set(); toolsBySession.set(sid, acc); }
          for (const t of h.toolsUsed) acc.add(t);
        }
      }
    }),
  );
  for (const [sid, tools] of toolsBySession) {
    const meta = forest.sessions.get(sid);
    if (meta) meta.toolsUsed = [...tools].sort();
  }
  return forest;
}

/** Resolve the project's session filePath for a sessionId. Falls back to deriving from convention. */
export function sessionFilePath(projectsRoot: string, projectSlug: string, sessionId: string): string {
  return join(projectsRoot, projectSlug, `${sessionId}.jsonl`);
}

/** For tests: ensure pure-function buildForest doesn't accidentally use globals. */
export function _internals() {
  return { basename, dirname };
}
