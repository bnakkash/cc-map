import { describe, expect, it } from "vitest";
import { buildForest } from "../src/forest.js";
import type { GraphNode } from "../src/types.js";

function node(over: Partial<GraphNode> & Pick<GraphNode, "id" | "sessionId" | "timestamp">): GraphNode {
  return {
    id: over.id,
    parentId: over.parentId ?? null,
    sessionId: over.sessionId,
    projectSlug: over.projectSlug ?? "proj",
    cwd: over.cwd ?? "/c",
    gitBranch: over.gitBranch ?? "main",
    timestamp: over.timestamp,
    classification: over.classification ?? { role: "user", subtype: "prompt" },
    isSidechain: over.isSidechain ?? false,
    agentId: over.agentId ?? null,
    preview: over.preview ?? "",
    contentLength: over.contentLength ?? 0,
    usage: over.usage ?? null,
  };
}

describe("buildForest", () => {
  it("computes children, roots, and session metadata for a simple chain", () => {
    const a = node({ id: "a", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z" });
    const b = node({
      id: "b",
      parentId: "a",
      sessionId: "s1",
      timestamp: "2026-01-01T00:01:00Z",
      classification: { role: "assistant" },
    });
    const c = node({
      id: "c",
      parentId: "b",
      sessionId: "s1",
      timestamp: "2026-01-01T00:02:00Z",
    });
    const forest = buildForest([a, b, c]);
    expect(forest.roots).toEqual(["a"]);
    expect(forest.childrenOf.get("a")).toEqual(["b"]);
    expect(forest.childrenOf.get("b")).toEqual(["c"]);
    const meta = forest.sessions.get("s1")!;
    expect(meta.nodeCount).toBe(3);
    expect(meta.promptCount).toBe(2);
    expect(meta.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(meta.lastActivityAt).toBe("2026-01-01T00:02:00Z");
  });

  it("detects cross-session forks where children belong to different sessions", () => {
    const root = node({ id: "root", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z" });
    const s1Child = node({
      id: "s1c",
      parentId: "root",
      sessionId: "s1",
      timestamp: "2026-01-01T00:01:00Z",
      classification: { role: "assistant" },
    });
    const s2Child = node({
      id: "s2c",
      parentId: "root",
      sessionId: "s2",
      timestamp: "2026-01-02T00:00:00Z",
      classification: { role: "assistant" },
    });
    const forest = buildForest([root, s1Child, s2Child]);
    expect(forest.forks).toHaveLength(1);
    expect(forest.forks[0]!.parentUuid).toBe("root");
    expect(forest.forks[0]!.sessionIds).toEqual(["s1", "s2"]);
  });

  it("--fork-session: same uuid appears in multiple session files (shared message)", () => {
    // The fork-session mechanism copies messages into new session files
    // with the same uuids. buildForest must not lose edges to dedup.
    const sharedA = node({ id: "shared", sessionId: "sA", timestamp: "2026-01-01T00:00:00Z" });
    const sharedB = node({ id: "shared", sessionId: "sB", timestamp: "2026-01-01T00:00:00Z" });
    const childA = node({
      id: "childA",
      parentId: "shared",
      sessionId: "sA",
      timestamp: "2026-01-01T00:01:00Z",
      classification: { role: "assistant" },
    });
    const childB = node({
      id: "childB",
      parentId: "shared",
      sessionId: "sB",
      timestamp: "2026-01-01T00:02:00Z",
      classification: { role: "assistant" },
    });
    const forest = buildForest([sharedA, sharedB, childA, childB]);
    // shared uuid is in both sessions
    expect(forest.sessionsContainingNode.get("shared")).toEqual(["sA", "sB"]);
    // shared has two children: childA + childB
    expect(forest.childrenOf.get("shared")?.sort()).toEqual(["childA", "childB"]);
    // shared is a fork point: its children belong to different sessions
    expect(forest.forks).toHaveLength(1);
    expect(forest.forks[0]!.parentUuid).toBe("shared");
  });

  it("--fork-session: same parentUuid referenced from same-uuid children across 3 sessions", () => {
    // Reproduces the real-data scenario from cc-map smoke: one parent uuid,
    // a single child uuid that's been replicated to 3 different sessions.
    const parent = node({ id: "p", sessionId: "sA", timestamp: "2026-01-01T00:00:00Z" });
    const c1 = node({
      id: "c",
      parentId: "p",
      sessionId: "sA",
      timestamp: "2026-01-01T00:01:00Z",
    });
    const c2 = node({
      id: "c",
      parentId: "p",
      sessionId: "sB",
      timestamp: "2026-01-01T00:01:00Z",
    });
    const c3 = node({
      id: "c",
      parentId: "p",
      sessionId: "sC",
      timestamp: "2026-01-01T00:01:00Z",
    });
    const forest = buildForest([parent, c1, c2, c3]);
    // c (the deduped node) belongs to 3 sessions
    expect(forest.sessionsContainingNode.get("c")).toEqual(["sA", "sB", "sC"]);
    // p is a fork point — its child-edges originate in 3 sessions
    expect(forest.forks).toHaveLength(1);
    expect(forest.forks[0]!.parentUuid).toBe("p");
    expect(forest.forks[0]!.sessionIds).toEqual(["sA", "sB", "sC"]);
  });

  it("treats nodes whose parent is missing as additional roots", () => {
    const orphan = node({
      id: "orphan",
      parentId: "missing-parent",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const forest = buildForest([orphan]);
    expect(forest.roots).toEqual(["orphan"]);
  });

  it("sorts children by timestamp ascending", () => {
    const p = node({ id: "p", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z" });
    const c2 = node({
      id: "c2",
      parentId: "p",
      sessionId: "s1",
      timestamp: "2026-01-01T00:02:00Z",
    });
    const c1 = node({
      id: "c1",
      parentId: "p",
      sessionId: "s1",
      timestamp: "2026-01-01T00:01:00Z",
    });
    const forest = buildForest([p, c2, c1]);
    expect(forest.childrenOf.get("p")).toEqual(["c1", "c2"]);
  });
});
