// Shape of one parsed JSONL record from Claude Code that we keep around.
// We deliberately don't model the full set of types — only the ones that become graph nodes.

export type ClassifiedRole = "user" | "assistant";

// Sub-classifications of `type: "user"` records, since "user" in the JSONL covers
// real prompts, slash command invocations, slash command output, and tool results.
export type UserSubtype =
  | "prompt"          // real human-typed prompt
  | "slash-command"   // <command-name>... invocations
  | "slash-output"    // <local-command-stdout>... command output
  | "tool-result"     // assistant's tool_use was answered with a tool_result
  | "system-reminder" // <system-reminder>... injected by the harness
  | "other";          // anything that didn't match (defensive)

export type NodeClassification =
  | { role: "user"; subtype: UserSubtype }
  | { role: "assistant" };

export interface RawRecord {
  // Required for any record we keep
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  // Per-record-type fields, kept loose on purpose
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
  cwd?: string;
  gitBranch?: string;
  version?: string;
  promptId?: string;
  agentId?: string;
  slug?: string;
  [k: string]: unknown;
}

export interface NodeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface GraphNode {
  /** UUID of this record. Globally unique across Claude Code's data. */
  id: string;
  /** UUID of the parent record, or null if root. */
  parentId: string | null;
  /** Session this record belongs to (the JSONL file's sessionId). */
  sessionId: string;
  /** Project slug = name of the project directory under ~/.claude/projects/. */
  projectSlug: string;
  /** Path the session was running in (cwd from the record). */
  cwd: string | null;
  /** Git branch active when this record was written. */
  gitBranch: string | null;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Classification of the record. */
  classification: NodeClassification;
  /** True if this node is part of a subagent ("sidechain") transcript. */
  isSidechain: boolean;
  /** Subagent ID if applicable (only on sidechain nodes). */
  agentId: string | null;
  /** First ~140 chars of message text, plain text. */
  preview: string;
  /** Length in characters of the full message text, for sizing/sorting. */
  contentLength: number;
  /** Token usage (assistant turns only). */
  usage: NodeUsage | null;
}

export interface SessionMeta {
  sessionId: string;
  projectSlug: string;
  filePath: string;
  /** First user prompt timestamp, or first record if no prompts. */
  startedAt: string | null;
  /** Last record's timestamp. */
  lastActivityAt: string | null;
  /** cwd of the first record. */
  cwd: string | null;
  /** Number of graph nodes (user+assistant) in this session. */
  nodeCount: number;
  /** Number of real prompts (excluding slash commands and tool results). */
  promptCount: number;
  /** Claude-generated session title from `type: "ai-title"` records, if any. */
  aiTitle: string | null;
  /** Sum of token usage across all assistant turns in this session. */
  totalUsage: NodeUsage;
}

export interface ForkInfo {
  /** Parent uuid that has children in 2+ different sessionIds. */
  parentUuid: string;
  /** sessionIds that branched off this parent. */
  sessionIds: string[];
}

export interface Forest {
  /**
   * All graph nodes keyed by uuid. Dedup is last-write-wins because
   * `--fork-session` copies messages with the same uuids into the new session.
   * Use `sessionsContainingNode` to recover which sessions each node belongs to.
   */
  nodes: Map<string, GraphNode>;
  /**
   * Which sessions each uuid appears in. A uuid in 2+ sessions = shared by
   * forked sessions. Useful for coloring "shared" nodes in the tree-map.
   */
  sessionsContainingNode: Map<string, string[]>;
  /** Adjacency: uuid -> child uuids (deduped, in timestamp order). */
  childrenOf: Map<string, string[]>;
  /** Nodes whose parentId is null or doesn't exist in `nodes`. */
  roots: string[];
  /** Sessions metadata, keyed by sessionId. */
  sessions: Map<string, SessionMeta>;
  /** sessionId -> projectSlug (denormalized for quick lookup). */
  projectsBySession: Map<string, string>;
  /** projectSlug -> sessionIds (sorted by startedAt ascending). */
  sessionsByProject: Map<string, string[]>;
  /**
   * Cross-session forks: uuids whose children belong to 2+ different sessions.
   * The uuid is the *fork point* (last shared message before divergence).
   */
  forks: ForkInfo[];
}

export interface Delta {
  /** Nodes added since the last delta. */
  added: GraphNode[];
  /** Session metadata updates (created or stats changed). */
  sessionsTouched: SessionMeta[];
}
