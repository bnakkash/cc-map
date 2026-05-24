import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Delta,
  type Forest,
  type GraphNode,
  type SessionMeta,
  loadForest,
  parseFile,
  startWatcher,
} from "@cc-map/parser";
import { CONFIG } from "./config.js";

const STATE_FILE = join(CONFIG.stateDir, "state.json");

interface PersistedState {
  /** Last sessionId reported by a Claude Code SessionStart hook. */
  activeSessionId: string | null;
  /** ISO timestamp of when that hook fired. */
  activeSessionAt: string | null;
}

/**
 * Subscriber callback for SSE clients. Each connected EventSource gets one.
 */
type DeltaSubscriber = (event: ServerEvent) => void;

export type ServerEvent =
  | { type: "delta"; added: GraphNode[]; sessionsTouched: SessionMeta[] }
  | { type: "active-session"; sessionId: string | null; at: string | null };

/**
 * In-memory state for the whole server: the forest, the active session marker,
 * and the SSE subscriber list.
 *
 * Mutated by:
 *   - initial load
 *   - the chokidar watcher (`onDelta`)
 *   - the SessionStart hook endpoint (`setActiveSession`)
 */
export class ServerState {
  forest: Forest;
  private persisted: PersistedState;
  private subscribers = new Set<DeltaSubscriber>();
  /** Cache of full per-session node content keyed by sessionId. */
  private fullContentCache = new Map<string, Map<string, GraphNode>>();

  private constructor(forest: Forest, persisted: PersistedState) {
    this.forest = forest;
    this.persisted = persisted;
  }

  static async load(): Promise<ServerState> {
    const t0 = Date.now();
    const [forest, persisted] = await Promise.all([
      loadForest(CONFIG.projectsRoot),
      loadPersisted(),
    ]);
    const elapsed = Date.now() - t0;
    console.log(
      `[state] forest loaded in ${elapsed}ms: ${forest.nodes.size} nodes, ${forest.sessions.size} sessions, ${forest.forks.length} forks`,
    );
    return new ServerState(forest, persisted);
  }

  /** Start watching the JSONL tree for changes. Returns a stop function. */
  startWatching(): () => Promise<void> {
    return startWatcher({
      projectsRoot: CONFIG.projectsRoot,
      onDelta: (delta) => this.applyDelta(delta),
    });
  }

  private applyDelta(delta: Delta) {
    if (delta.added.length === 0) return;
    // Update forest in place.
    for (const n of delta.added) {
      this.forest.nodes.set(n.id, n);
      const set = this.forest.sessionsContainingNode.get(n.id) ?? [];
      if (!set.includes(n.sessionId)) {
        this.forest.sessionsContainingNode.set(n.id, [...set, n.sessionId].sort());
      }
      if (n.parentId != null) {
        const kids = this.forest.childrenOf.get(n.parentId) ?? [];
        if (!kids.includes(n.id)) {
          kids.push(n.id);
          kids.sort((a, b) => {
            const ta = this.forest.nodes.get(a)?.timestamp ?? "";
            const tb = this.forest.nodes.get(b)?.timestamp ?? "";
            return ta < tb ? -1 : ta > tb ? 1 : 0;
          });
          this.forest.childrenOf.set(n.parentId, kids);
        }
      }
      // Invalidate full-content cache for the touched session
      this.fullContentCache.delete(n.sessionId);
    }
    for (const sm of delta.sessionsTouched) {
      const existing = this.forest.sessions.get(sm.sessionId);
      if (existing) {
        existing.nodeCount = Math.max(existing.nodeCount, sm.nodeCount);
        existing.promptCount = Math.max(existing.promptCount, sm.promptCount);
        if (!existing.lastActivityAt || (sm.lastActivityAt && sm.lastActivityAt > existing.lastActivityAt)) {
          existing.lastActivityAt = sm.lastActivityAt;
        }
      } else {
        this.forest.sessions.set(sm.sessionId, sm);
        this.forest.projectsBySession.set(sm.sessionId, sm.projectSlug);
        const arr = this.forest.sessionsByProject.get(sm.projectSlug) ?? [];
        if (!arr.includes(sm.sessionId)) arr.push(sm.sessionId);
        this.forest.sessionsByProject.set(sm.projectSlug, arr);
      }
    }
    this.broadcast({ type: "delta", added: delta.added, sessionsTouched: delta.sessionsTouched });
  }

  async setActiveSession(sessionId: string, cwd: string | null): Promise<void> {
    this.persisted.activeSessionId = sessionId;
    this.persisted.activeSessionAt = new Date().toISOString();
    void cwd; // (could be persisted too if useful)
    await savePersisted(this.persisted);
    this.broadcast({
      type: "active-session",
      sessionId: this.persisted.activeSessionId,
      at: this.persisted.activeSessionAt,
    });
  }

  getActiveSession(): { sessionId: string | null; at: string | null } {
    return {
      sessionId: this.persisted.activeSessionId,
      at: this.persisted.activeSessionAt,
    };
  }

  subscribe(cb: DeltaSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private broadcast(event: ServerEvent) {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Lazy-load all nodes (full content) for a session by re-parsing its file.
   * Cached per-session. Used by the message-pane endpoint.
   */
  async getFullSessionNodes(sessionId: string): Promise<Map<string, GraphNode> | null> {
    const cached = this.fullContentCache.get(sessionId);
    if (cached) return cached;
    const meta = this.forest.sessions.get(sessionId);
    if (!meta) return null;
    // Find the file path. Prefer meta.filePath; otherwise derive.
    let filePath = meta.filePath;
    if (!filePath) {
      filePath = join(CONFIG.projectsRoot, meta.projectSlug, `${sessionId}.jsonl`);
    }
    try {
      const nodes = await parseFile(filePath, {
        projectSlug: meta.projectSlug,
        sessionId,
      });
      const map = new Map<string, GraphNode>();
      for (const n of nodes) map.set(n.id, n);
      this.fullContentCache.set(sessionId, map);
      return map;
    } catch {
      return null;
    }
  }
}

async function loadPersisted(): Promise<PersistedState> {
  try {
    const text = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(text) as Partial<PersistedState>;
    return {
      activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null,
      activeSessionAt: typeof parsed.activeSessionAt === "string" ? parsed.activeSessionAt : null,
    };
  } catch {
    return { activeSessionId: null, activeSessionAt: null };
  }
}

async function savePersisted(state: PersistedState): Promise<void> {
  await mkdir(CONFIG.stateDir, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}
