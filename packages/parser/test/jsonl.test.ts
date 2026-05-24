import { describe, expect, it } from "vitest";
import { parseLineToNode } from "../src/jsonl.js";

const ctx = { projectSlug: "proj", sessionId: "sess" };

describe("parseLineToNode", () => {
  it("parses a real-looking user line", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: "p1",
      sessionId: "sess",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "C:/x",
      gitBranch: "main",
      message: { role: "user", content: "hello world" },
    });
    const node = parseLineToNode(line, ctx);
    expect(node).not.toBeNull();
    expect(node!.id).toBe("u1");
    expect(node!.parentId).toBe("p1");
    expect(node!.classification).toEqual({ role: "user", subtype: "prompt" });
    expect(node!.preview).toBe("hello world");
  });

  it("returns null on malformed JSON", () => {
    expect(parseLineToNode("not json", ctx)).toBeNull();
  });

  it("returns null on metadata record types", () => {
    const line = JSON.stringify({
      type: "ai-title",
      sessionId: "sess",
      title: "x",
    });
    expect(parseLineToNode(line, ctx)).toBeNull();
  });

  it("returns null on empty line", () => {
    expect(parseLineToNode("", ctx)).toBeNull();
  });

  it("falls back to ctx.sessionId if record sessionId missing", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "assistant", content: "hi" },
    });
    const node = parseLineToNode(line, ctx);
    expect(node!.sessionId).toBe("sess");
  });
});
