import { describe, expect, it } from "vitest";
import { buildLayout } from "./layout.js";
import { DEFAULT_VISIBILITY, LAYOUT, type ForestNode, type ForestPayload } from "./types.js";

/** Build a ForestNode with sensible defaults — tests only override what they care about. */
function mkNode(p: Partial<ForestNode> & Pick<ForestNode, "id" | "sessionId" | "timestamp">): ForestNode {
  return {
    id: p.id,
    parentId: p.parentId ?? null,
    sessionId: p.sessionId,
    projectSlug: p.projectSlug ?? "proj-a",
    role: p.role ?? "user",
    subtype: p.subtype ?? "prompt",
    isSidechain: p.isSidechain ?? false,
    timestamp: p.timestamp,
    preview: p.preview ?? `node ${p.id}`,
    sessionsIn: p.sessionsIn ?? 1,
    outputTokens: p.outputTokens ?? 0,
  };
}

function mkPayload(nodes: ForestNode[], forks: ForestPayload["forks"] = []): ForestPayload {
  const sessionIds = new Set(nodes.map((n) => n.sessionId));
  const projectSlugs = new Set(nodes.map((n) => n.projectSlug));
  return {
    nodes,
    forks,
    projects: [...projectSlugs].map((slug) => ({
      slug,
      sessionCount: new Set(nodes.filter((n) => n.projectSlug === slug).map((n) => n.sessionId)).size,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    })),
    sessionCount: sessionIds.size,
    activeSessionId: null,
    activeSessionAt: null,
    sessionTitles: {},
  };
}

describe("buildLayout", () => {
  describe("empty / degenerate", () => {
    it("handles an empty payload without crashing", () => {
      const l = buildLayout(mkPayload([]), "per-project", null);
      expect(l.nodes.size).toBe(0);
      expect(l.edges.length).toBe(0);
      expect(l.sessionBands.length).toBe(0);
      expect(l.subagentCountByParent.size).toBe(0);
    });

    it("returns a valid Layout when all nodes are filtered out by visibility", () => {
      const nodes = [
        mkNode({ id: "a", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z", role: "user", subtype: "tool-result" }),
      ];
      const vis = { ...DEFAULT_VISIBILITY, toolResult: false, prompt: false, assistantText: false };
      const l = buildLayout(mkPayload(nodes), "per-project", null, vis);
      expect(l.nodes.size).toBe(0);
    });
  });

  describe("grid (default) direction", () => {
    it("places a linear prompt → assistant chain with parent above child", () => {
      const nodes = [
        mkNode({ id: "a", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "b", sessionId: "s1", timestamp: "2026-05-24T10:00:05Z", parentId: "a", role: "assistant", subtype: "text" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null);
      expect(l.nodes.size).toBe(2);
      const a = l.nodes.get("a")!;
      const b = l.nodes.get("b")!;
      expect(b.y).toBeGreaterThan(a.y);
      // First child sits directly below parent (same column in vertical-fork mode)
      expect(b.x).toBe(a.x);
      // Edge present
      expect(l.edges.some((e) => e.fromId === "a" && e.toId === "b")).toBe(true);
    });

    it("marks only the first real prompt in a session as the session start", () => {
      const nodes = [
        mkNode({ id: "p1", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "a1", sessionId: "s1", timestamp: "2026-05-24T10:00:05Z", parentId: "p1", role: "assistant", subtype: "text" }),
        mkNode({ id: "p2", sessionId: "s1", timestamp: "2026-05-24T10:01:00Z", parentId: "a1" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null);
      expect(l.nodes.get("p1")!.isSessionStart).toBe(true);
      expect(l.nodes.get("p2")!.isSessionStart).toBe(false);
      expect(l.nodes.get("a1")!.isSessionStart).toBe(false);
    });

    it("stacks fork siblings vertically with horizontal step", () => {
      const nodes = [
        mkNode({ id: "root", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "c1", sessionId: "s1", timestamp: "2026-05-24T10:00:05Z", parentId: "root", role: "assistant", subtype: "text" }),
        mkNode({ id: "c2", sessionId: "s1", timestamp: "2026-05-24T10:00:06Z", parentId: "root", role: "assistant", subtype: "text" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null);
      const c1 = l.nodes.get("c1")!;
      const c2 = l.nodes.get("c2")!;
      // Both children have y > root
      expect(c1.y).toBeGreaterThan(l.nodes.get("root")!.y);
      expect(c2.y).toBeGreaterThan(l.nodes.get("root")!.y);
      // Second sibling steps right
      expect(c2.x).toBeGreaterThan(c1.x);
      // And sits below the first
      expect(c2.y).toBeGreaterThan(c1.y);
    });

    it("populates session bands and forest bounds", () => {
      const nodes = [
        mkNode({ id: "a", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "b", sessionId: "s1", timestamp: "2026-05-24T10:00:05Z", parentId: "a", role: "assistant", subtype: "text" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null);
      expect(l.sessionBands.length).toBe(1);
      const band = l.sessionBands[0]!;
      expect(band.sessionId).toBe("s1");
      expect(band.minY).toBeLessThan(band.maxY);
      expect(band.tokenSpark).toBeInstanceOf(Array);
      expect(l.bounds.maxX).toBeGreaterThan(l.bounds.minX);
      expect(l.bounds.maxY).toBeGreaterThan(l.bounds.minY);
    });

    it("wraps independent sessions into rows", () => {
      const nodes = Array.from({ length: 6 }, (_, i) =>
        mkNode({
          id: `s${i + 1}a`,
          sessionId: `s${i + 1}`,
          timestamp: `2026-05-24T10:0${i}:00Z`,
        }),
      );
      const l = buildLayout(mkPayload(nodes), "per-project", null);
      const positions = nodes.map((n) => l.nodes.get(n.id)!);
      expect(new Set(positions.map((n) => n.x)).size).toBeGreaterThan(1);
      expect(new Set(positions.map((n) => n.y)).size).toBeGreaterThan(1);
    });

    it("applies custom session origins for spaces", () => {
      const nodes = [
        mkNode({ id: "s1a", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "s2a", sessionId: "s2", timestamp: "2026-05-24T10:01:00Z" }),
      ];
      const l = buildLayout(
        mkPayload(nodes),
        "per-project",
        null,
        DEFAULT_VISIBILITY,
        "grid",
        null,
        "dots",
        { s2: { x: 420, y: 160 } },
      );
      const s2Band = l.sessionBands.find((b) => b.sessionId === "s2")!;
      const s2Node = l.nodes.get("s2a")!;
      expect(s2Band.minX).toBe(420);
      expect(s2Band.minY).toBe(160);
      expect(s2Node.x).toBeGreaterThan(s2Band.minX);
      expect(s2Node.y).toBeGreaterThan(s2Band.minY);
      expect(l.bounds.maxX).toBeGreaterThan(s2Band.minX);
      expect(l.bounds.maxY).toBeGreaterThan(s2Band.minY);
    });

    it("counts subagent roots per spawning parent", () => {
      const nodes = [
        mkNode({ id: "main", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "tool", sessionId: "s1", timestamp: "2026-05-24T10:00:05Z", parentId: "main", role: "assistant", subtype: "tool-only" }),
        // Two subagent roots both attached to the spawning Task tool_use
        mkNode({ id: "sub1", sessionId: "s1", timestamp: "2026-05-24T10:00:06Z", parentId: "tool", isSidechain: true }),
        mkNode({ id: "sub2", sessionId: "s1", timestamp: "2026-05-24T10:00:07Z", parentId: "tool", isSidechain: true }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null);
      expect(l.subagentCountByParent.get("tool")).toBe(2);
    });
  });

  describe("timeline direction", () => {
    it("places sessions in separate left-to-right columns by start time", () => {
      const nodes = [
        // Session 2 (newer start) — should be to the right
        mkNode({ id: "s2a", sessionId: "s2", timestamp: "2026-05-24T11:00:00Z" }),
        // Session 1 (older start) — should be on the left
        mkNode({ id: "s1a", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "s1b", sessionId: "s1", timestamp: "2026-05-24T10:00:05Z", parentId: "s1a" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null, DEFAULT_VISIBILITY, "timeline");
      const s1a = l.nodes.get("s1a")!;
      const s2a = l.nodes.get("s2a")!;
      expect(s1a.x).toBeLessThan(s2a.x);
    });

    it("Y is proportional to time within a session, capped by MAX_GAP", () => {
      const nodes = [
        mkNode({ id: "a", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        // 10-minute gap — should produce a moderate Y delta
        mkNode({ id: "b", sessionId: "s1", timestamp: "2026-05-24T10:10:00Z", parentId: "a" }),
        // 1-week gap — must be capped, not literally 7*24*60*6 = 60,480 px tall
        mkNode({ id: "c", sessionId: "s1", timestamp: "2026-05-31T10:10:00Z", parentId: "b" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null, DEFAULT_VISIBILITY, "timeline");
      const a = l.nodes.get("a")!;
      const b = l.nodes.get("b")!;
      const c = l.nodes.get("c")!;
      const ab = b.y - a.y;
      const bc = c.y - b.y;
      expect(ab).toBeGreaterThan(0);
      // 10 minute gap × 6 px/min = 60 px (within [16, 140] window)
      expect(ab).toBeGreaterThanOrEqual(16);
      expect(ab).toBeLessThanOrEqual(140);
      // Week-long gap must be clamped to MAX_GAP (140 px) — not thousands
      expect(bc).toBeLessThanOrEqual(140);
      // nodeGapToPrev should be populated with real ms values
      expect(l.nodeGapToPrev?.get("b")).toBe(10 * 60 * 1000);
      expect(l.nodeGapToPrev?.get("c")).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  describe("column direction", () => {
    it("walks the chain horizontally to the right, prompts continue vertically", () => {
      const nodes = [
        mkNode({ id: "p1", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "a1", sessionId: "s1", timestamp: "2026-05-24T10:00:05Z", parentId: "p1", role: "assistant", subtype: "text" }),
        mkNode({ id: "p2", sessionId: "s1", timestamp: "2026-05-24T10:01:00Z", parentId: "a1" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null, DEFAULT_VISIBILITY, "column");
      const p1 = l.nodes.get("p1")!;
      const a1 = l.nodes.get("a1")!;
      const p2 = l.nodes.get("p2")!;
      // a1 is on the right of p1, same row
      expect(a1.x).toBeGreaterThan(p1.x);
      expect(a1.y).toBe(p1.y);
      // p2 is below p1 (new prompt = new row)
      expect(p2.y).toBeGreaterThan(p1.y);
      expect(p2.x).toBe(p1.x);
    });

    it("aligns session heads horizontally across sessions", () => {
      const nodes = [
        mkNode({ id: "s1p1", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({ id: "s1a1", sessionId: "s1", timestamp: "2026-05-24T10:00:05Z", parentId: "s1p1", role: "assistant", subtype: "text" }),
        mkNode({ id: "s2p1", sessionId: "s2", timestamp: "2026-05-24T10:01:00Z" }),
        mkNode({ id: "s2a1", sessionId: "s2", timestamp: "2026-05-24T10:01:05Z", parentId: "s2p1", role: "assistant", subtype: "text" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null, DEFAULT_VISIBILITY, "column");
      const s1p1 = l.nodes.get("s1p1")!;
      const s2p1 = l.nodes.get("s2p1")!;
      expect(s2p1.x).toBeGreaterThan(s1p1.x);
      expect(s2p1.y).toBe(s1p1.y);
    });
  });

  describe("cards mode", () => {
    it("attaches per-node cardHeight that varies with preview length", () => {
      const nodes = [
        mkNode({ id: "short", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z", preview: "hi" }),
        mkNode({
          id: "long",
          sessionId: "s1",
          timestamp: "2026-05-24T10:00:05Z",
          parentId: "short",
          role: "assistant",
          subtype: "text",
          preview: "x".repeat(500),
        }),
      ];
      const l = buildLayout(
        mkPayload(nodes),
        "per-project",
        null,
        DEFAULT_VISIBILITY,
        "grid",
        null,
        "cards",
      );
      const short = l.nodes.get("short")!;
      const long = l.nodes.get("long")!;
      expect(short.cardHeight).toBeGreaterThan(0);
      expect(long.cardHeight).toBeGreaterThan(short.cardHeight!);
      expect(l.bounds.maxX).toBeGreaterThanOrEqual(short.x + LAYOUT.cardWidth);
      expect(l.sessionBands[0]!.maxX).toBeGreaterThanOrEqual(short.x + LAYOUT.cardWidth);
    });
  });

  describe("compact markers", () => {
    it("marks the next visible node after a hidden /compact command", () => {
      const nodes = [
        mkNode({ id: "p1", sessionId: "s1", timestamp: "2026-05-24T10:00:00Z" }),
        mkNode({
          id: "compact",
          sessionId: "s1",
          timestamp: "2026-05-24T10:01:00Z",
          parentId: "p1",
          subtype: "slash-command",
          preview: "<command-name>/compact</command-name>",
        }),
        mkNode({ id: "p2", sessionId: "s1", timestamp: "2026-05-24T10:02:00Z", parentId: "compact" }),
      ];
      const l = buildLayout(mkPayload(nodes), "per-project", null);
      expect(l.nodes.has("compact")).toBe(false);
      expect(l.nodes.get("p2")!.isCompactBoundary).toBe(true);
      expect(l.nodes.get("p1")!.isCompactBoundary).toBe(false);
    });
  });
});
