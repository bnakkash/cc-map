import { describe, expect, it } from "vitest";
import { classify, extractPreview } from "../src/classifier.js";

describe("classify", () => {
  it("marks plain user string as prompt", () => {
    const r = classify({ type: "user", message: { role: "user", content: "hello can you help" } });
    expect(r).toEqual({ role: "user", subtype: "prompt" });
  });

  it("marks slash command invocations", () => {
    const r = classify({
      type: "user",
      message: { role: "user", content: "<command-name>/model</command-name>" },
    });
    expect(r).toEqual({ role: "user", subtype: "slash-command" });
  });

  it("marks slash command output", () => {
    const r = classify({
      type: "user",
      message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" },
    });
    expect(r).toEqual({ role: "user", subtype: "slash-output" });
  });

  it("marks system reminder", () => {
    const r = classify({
      type: "user",
      message: { role: "user", content: "<system-reminder>hi</system-reminder>" },
    });
    expect(r).toEqual({ role: "user", subtype: "system-reminder" });
  });

  it("marks tool_result block array", () => {
    const r = classify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "result" }],
      },
    });
    expect(r).toEqual({ role: "user", subtype: "tool-result" });
  });

  it("marks assistant with text subtype for plain-text replies", () => {
    const r = classify({ type: "assistant", message: { role: "assistant", content: "hi" } });
    expect(r).toEqual({ role: "assistant", subtype: "text" });
  });

  it("ignores non-graph types", () => {
    expect(classify({ type: "ai-title" })).toBeNull();
    expect(classify({ type: "last-prompt" })).toBeNull();
    expect(classify({ type: "queue-operation" })).toBeNull();
  });

  it("text array with only system-reminder counts as system-reminder, not prompt", () => {
    const r = classify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>foo</system-reminder>" }],
      },
    });
    expect(r).toEqual({ role: "user", subtype: "system-reminder" });
  });
});

describe("extractPreview", () => {
  it("trims whitespace and caps length", () => {
    const { preview, length } = extractPreview("hello\n\n  world  ");
    expect(preview).toBe("hello world");
    expect(length).toBe("hello\n\n  world  ".length);
  });

  it("extracts text from array of text blocks", () => {
    const { preview } = extractPreview([
      { type: "text", text: "part one" },
      { type: "text", text: "part two" },
    ]);
    expect(preview).toBe("part one part two");
  });

  it("summarizes tool_use blocks", () => {
    const { preview } = extractPreview([{ type: "tool_use", name: "Read", id: "x" }]);
    expect(preview).toContain("[tool_use: Read]");
  });
});
