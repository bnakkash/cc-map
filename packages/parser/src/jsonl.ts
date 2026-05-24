import { readFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { classify, extractPreview } from "./classifier.js";
import type { GraphNode, NodeUsage, RawRecord } from "./types.js";

/** Pull names of tools invoked in an assistant record (Bash, Edit, Read, etc.). */
export function extractToolNames(record: RawRecord): string[] {
  if (record.type !== "assistant") return [];
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      const t = (b as { type?: unknown }).type;
      if (t === "tool_use") {
        const n = (b as { name?: unknown }).name;
        if (typeof n === "string") names.push(n);
      }
    }
  }
  return names;
}

/** Pull token usage from an assistant record. Returns null for non-assistant or missing data. */
function extractUsage(record: RawRecord): NodeUsage | null {
  if (record.type !== "assistant") return null;
  const msg = record.message as { usage?: unknown } | undefined;
  const u = msg?.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (!u) return null;
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
    cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
    cacheCreationTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
  };
}

/** Info about an assistant's Task tool_use, used to attach subagents to their spawner. */
export interface TaskSpawnHint {
  sessionId: string;
  /** UUID of the assistant turn that fired the Task call. */
  uuid: string;
  /** Timestamp of that assistant turn — matches the subagent's first message timestamp. */
  timestamp: string;
}

export function extractTaskSpawn(line: string): TaskSpawnHint | null {
  if (!line || line.length < 2) return null;
  let r: RawRecord;
  try {
    r = JSON.parse(line) as RawRecord;
  } catch {
    return null;
  }
  if (r.type !== "assistant") return null;
  if (typeof r.sessionId !== "string" || typeof r.uuid !== "string" || typeof r.timestamp !== "string") return null;
  const content = (r.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b && typeof b === "object") {
      const t = (b as { type?: unknown }).type;
      const n = (b as { name?: unknown }).name;
      if (t === "tool_use" && (n === "Task" || n === "Agent")) {
        return { sessionId: r.sessionId, uuid: r.uuid, timestamp: r.timestamp };
      }
    }
  }
  return null;
}

/** Record-extracted session metadata (ai-title, tools used etc). null when none in this line. */
export interface SessionSidecarHint {
  sessionId: string;
  aiTitle?: string;
  /** Tool names invoked in this record (if any) — caller aggregates per session. */
  toolNames?: string[];
}

export function extractSidecarHint(line: string): SessionSidecarHint | null {
  if (!line || line.length < 2) return null;
  let r: RawRecord;
  try {
    r = JSON.parse(line) as RawRecord;
  } catch {
    return null;
  }
  if (r.type === "ai-title" && typeof r.sessionId === "string") {
    const title = (r as { aiTitle?: unknown }).aiTitle;
    const out: SessionSidecarHint = { sessionId: r.sessionId };
    if (typeof title === "string") out.aiTitle = title;
    return out;
  }
  if (r.type === "assistant" && typeof r.sessionId === "string") {
    const tools = extractToolNames(r);
    if (tools.length > 0) {
      return { sessionId: r.sessionId, toolNames: tools };
    }
  }
  return null;
}

/** Set of `type` values that produce graph nodes. Everything else is metadata. */
const GRAPH_TYPES = new Set(["user", "assistant"]);

/**
 * Parse one line of JSONL into a GraphNode, or null if the record is metadata
 * (not a user/assistant message), missing required fields, or malformed.
 */
export function parseLineToNode(
  line: string,
  ctx: { projectSlug: string; sessionId: string },
): GraphNode | null {
  if (!line || line.length < 2) return null;
  let record: RawRecord;
  try {
    record = JSON.parse(line) as RawRecord;
  } catch {
    return null;
  }
  if (!GRAPH_TYPES.has(record.type)) return null;
  if (typeof record.uuid !== "string" || record.uuid.length === 0) return null;
  if (typeof record.timestamp !== "string") return null;

  const classification = classify(record);
  if (!classification) return null;

  const { preview, length } = extractPreview(record.message?.content);
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : ctx.sessionId;

  return {
    id: record.uuid,
    parentId: typeof record.parentUuid === "string" ? record.parentUuid : null,
    sessionId,
    projectSlug: ctx.projectSlug,
    cwd: typeof record.cwd === "string" ? record.cwd : null,
    gitBranch: typeof record.gitBranch === "string" ? record.gitBranch : null,
    timestamp: record.timestamp,
    classification,
    isSidechain: record.isSidechain === true,
    agentId: typeof record.agentId === "string" ? record.agentId : null,
    preview,
    contentLength: length,
    usage: extractUsage(record),
  };
}

/**
 * Parse a whole JSONL file into GraphNodes. Tolerates malformed lines (skips them).
 *
 * NOTE: this reads the whole file into memory. For a 17MB session file this is fine,
 * but if files grow huge we'd want a streaming variant.
 */
export async function parseFile(
  filePath: string,
  ctx: { projectSlug: string; sessionId: string },
): Promise<GraphNode[]> {
  const text = await readFile(filePath, "utf8");
  const out: GraphNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    const node = parseLineToNode(line, ctx);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Tail a file from a given byte offset, returning newly parsed nodes plus the
 * new byte offset to use next time. Handles partial trailing lines by stopping
 * at the last `\n` and leaving the rest for the next call.
 *
 * This is what the chokidar watcher uses on every `change` event.
 */
export async function tailFromOffset(
  filePath: string,
  fromOffset: number,
  ctx: { projectSlug: string; sessionId: string },
): Promise<{ nodes: GraphNode[]; newOffset: number }> {
  const fh = await open(filePath, "r");
  try {
    const stat = await fh.stat();
    if (stat.size <= fromOffset) {
      // File was truncated or unchanged
      return { nodes: [], newOffset: stat.size };
    }
    const length = stat.size - fromOffset;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, fromOffset);
    const text = buf.toString("utf8");

    // Split on \n but if the last segment doesn't end with \n, keep its bytes for next time
    const endsWithNewline = text.endsWith("\n");
    const lines = text.split("\n");
    let tailBytes = 0;
    if (!endsWithNewline && lines.length > 0) {
      const last = lines.pop()!;
      tailBytes = Buffer.byteLength(last, "utf8");
    }

    const nodes: GraphNode[] = [];
    for (const line of lines) {
      const node = parseLineToNode(line, ctx);
      if (node) nodes.push(node);
    }
    return { nodes, newOffset: stat.size - tailBytes };
  } finally {
    await fh.close();
  }
}
