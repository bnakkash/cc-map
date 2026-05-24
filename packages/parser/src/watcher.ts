import chokidar from "chokidar";
import { stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { tailFromOffset } from "./jsonl.js";
import type { Delta, GraphNode, SessionMeta } from "./types.js";

interface FileCursor {
  filePath: string;
  projectSlug: string;
  sessionId: string;
  isSidechain: boolean;
  offset: number;
}

export interface WatcherOptions {
  projectsRoot: string;
  /** Called when new nodes are parsed (debounced per file). */
  onDelta: (delta: Delta) => void;
  /** Initial set of files (with byte-length so we tail from there, not re-read). */
  initialCursors?: { filePath: string; offset: number }[];
}

/**
 * Watch ~/.claude/projects/ for JSONL changes and emit deltas.
 *
 * Strategy: chokidar watches every *.jsonl file recursively. On `add` or `change`,
 * we re-stat the file, tail from our last known byte offset, parse new lines,
 * and emit them. The byte-offset cursor is what makes this safe under partial writes.
 *
 * NOTE: Windows file watching is flaky; chokidar has its own polling fallback that
 * we leave at default. If we see missed updates in practice, bump `usePolling: true`
 * with a short interval.
 */
export function startWatcher(opts: WatcherOptions): () => Promise<void> {
  const cursors = new Map<string, FileCursor>();
  if (opts.initialCursors) {
    for (const ic of opts.initialCursors) {
      const ctx = pathToContext(opts.projectsRoot, ic.filePath);
      if (ctx) {
        cursors.set(ic.filePath, { ...ctx, filePath: ic.filePath, offset: ic.offset });
      }
    }
  }

  const watcher = chokidar.watch(`${opts.projectsRoot.replace(/\\/g, "/")}/**/*.jsonl`, {
    ignoreInitial: false,
    awaitWriteFinish: false,
    persistent: true,
    // Polling is mandatory on Windows for files being APPENDED to (like JSONL
    // logs). Native fs.watch misses append-only writes consistently. Cost: a
    // little CPU. 500ms interval gives near-instant feel without burning.
    usePolling: true,
    interval: 500,
    binaryInterval: 1000,
  });

  const handleChange = async (filePath: string) => {
    let cursor = cursors.get(filePath);
    if (!cursor) {
      const ctx = pathToContext(opts.projectsRoot, filePath);
      if (!ctx) return;
      cursor = { ...ctx, filePath, offset: 0 };
      cursors.set(filePath, cursor);
    }
    try {
      const { nodes, newOffset } = await tailFromOffset(filePath, cursor.offset, {
        projectSlug: cursor.projectSlug,
        sessionId: cursor.sessionId,
      });
      cursor.offset = newOffset;
      if (nodes.length === 0) return;
      const sessions = aggregateSessions(nodes);
      opts.onDelta({ added: nodes, sessionsTouched: sessions });
    } catch {
      // ignore (file may be locked momentarily on Windows)
    }
  };

  const handleAdd = async (filePath: string) => {
    const ctx = pathToContext(opts.projectsRoot, filePath);
    if (!ctx) return;
    if (!cursors.has(filePath)) {
      cursors.set(filePath, { ...ctx, filePath, offset: 0 });
    }
    await handleChange(filePath);
  };

  watcher.on("add", handleAdd);
  watcher.on("change", handleChange);

  return async () => {
    await watcher.close();
  };
}

function pathToContext(
  projectsRoot: string,
  filePath: string,
): { projectSlug: string; sessionId: string; isSidechain: boolean } | null {
  const rel = relative(projectsRoot, filePath);
  const parts = rel.split(sep);
  if (parts.length === 2) {
    const [projectSlug, file] = parts;
    if (projectSlug && file?.endsWith(".jsonl")) {
      return { projectSlug, sessionId: file.slice(0, -".jsonl".length), isSidechain: false };
    }
  }
  if (parts.length === 4) {
    const [projectSlug, sessionId, sub, file] = parts;
    if (projectSlug && sessionId && sub === "subagents" && file?.endsWith(".jsonl")) {
      return { projectSlug, sessionId, isSidechain: true };
    }
  }
  return null;
}

function aggregateSessions(nodes: GraphNode[]): SessionMeta[] {
  const map = new Map<string, SessionMeta>();
  for (const n of nodes) {
    const existing = map.get(n.sessionId);
    const isPrompt = n.classification.role === "user" && n.classification.subtype === "prompt";
    if (!existing) {
      map.set(n.sessionId, {
        sessionId: n.sessionId,
        projectSlug: n.projectSlug,
        filePath: "",
        startedAt: n.timestamp,
        lastActivityAt: n.timestamp,
        cwd: n.cwd,
        nodeCount: 1,
        promptCount: isPrompt ? 1 : 0,
        aiTitle: null,
        totalUsage: {
          inputTokens: n.usage?.inputTokens ?? 0,
          outputTokens: n.usage?.outputTokens ?? 0,
          cacheReadTokens: n.usage?.cacheReadTokens ?? 0,
          cacheCreationTokens: n.usage?.cacheCreationTokens ?? 0,
        },
        toolsUsed: [],
      });
    } else {
      if (n.usage) {
        existing.totalUsage.inputTokens += n.usage.inputTokens;
        existing.totalUsage.outputTokens += n.usage.outputTokens;
        existing.totalUsage.cacheReadTokens += n.usage.cacheReadTokens;
        existing.totalUsage.cacheCreationTokens += n.usage.cacheCreationTokens;
      }
      existing.nodeCount += 1;
      if (isPrompt) existing.promptCount += 1;
      if (!existing.lastActivityAt || n.timestamp > existing.lastActivityAt) {
        existing.lastActivityAt = n.timestamp;
      }
    }
  }
  return [...map.values()];
}

// Re-export node path helpers for tests
export const _testHelpers = { pathToContext, basename, dirname, join };
