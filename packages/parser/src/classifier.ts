import type { AssistantSubtype, NodeClassification, UserSubtype } from "./types.js";

const COMMAND_NAME_RE = /^<command-name>/;
const COMMAND_STDOUT_RE = /^<local-command-stdout>/;
const COMMAND_MESSAGE_RE = /^<command-message>/;
const COMMAND_ARGS_RE = /^<command-args>/;
const SYSTEM_REMINDER_RE = /^<system-reminder>/;

/**
 * Classify a record's role + (for user records) what kind of user record it is.
 *
 * - "prompt" = real human-typed message
 * - "slash-command" = e.g. `<command-name>/model</command-name>...`
 * - "slash-output" = e.g. `<local-command-stdout>Set model to ...</local-command-stdout>`
 * - "tool-result" = content is an array containing a tool_result block
 * - "system-reminder" = harness-injected reminder
 */
export function classify(record: {
  type: string;
  message?: { role?: string; content?: unknown };
}): NodeClassification | null {
  if (record.type === "assistant") {
    return { role: "assistant", subtype: classifyAssistantContent(record.message?.content) };
  }
  if (record.type !== "user") {
    return null;
  }
  const content = record.message?.content;
  const subtype = classifyUserContent(content);
  return { role: "user", subtype };
}

/** Detect whether an assistant turn has any non-empty text block. */
function classifyAssistantContent(content: unknown): AssistantSubtype {
  if (typeof content === "string") {
    return content.trim().length > 0 ? "text" : "other";
  }
  if (Array.isArray(content)) {
    let hasText = false;
    let hasTool = false;
    let hasThinking = false;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const t = (b as { type?: unknown }).type;
      if (t === "text") {
        const txt = (b as { text?: unknown }).text;
        if (typeof txt === "string" && txt.trim().length > 0) hasText = true;
      } else if (t === "tool_use") {
        hasTool = true;
      } else if (t === "thinking") {
        hasThinking = true;
      }
    }
    if (hasText) return "text";
    if (hasTool) return "tool-only";
    if (hasThinking) return "thinking";
    return "other";
  }
  return "other";
}

function classifyUserContent(content: unknown): UserSubtype {
  if (typeof content === "string") {
    const trimmed = content.trimStart();
    if (COMMAND_NAME_RE.test(trimmed) || COMMAND_MESSAGE_RE.test(trimmed) || COMMAND_ARGS_RE.test(trimmed)) {
      return "slash-command";
    }
    if (COMMAND_STDOUT_RE.test(trimmed)) {
      return "slash-output";
    }
    if (SYSTEM_REMINDER_RE.test(trimmed)) {
      return "system-reminder";
    }
    return "prompt";
  }
  if (Array.isArray(content)) {
    let sawToolResult = false;
    let sawText = false;
    let textOnlyAllReminders = true;
    for (const block of content) {
      if (block && typeof block === "object") {
        const t = (block as { type?: unknown }).type;
        if (t === "tool_result") {
          sawToolResult = true;
        } else if (t === "text") {
          sawText = true;
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") {
            const trimmed = text.trimStart();
            if (!SYSTEM_REMINDER_RE.test(trimmed)) {
              textOnlyAllReminders = false;
            }
          } else {
            textOnlyAllReminders = false;
          }
        }
      }
    }
    if (sawToolResult) return "tool-result";
    if (sawText && textOnlyAllReminders) return "system-reminder";
    if (sawText) return "prompt";
    return "other";
  }
  return "other";
}

/** Extract a plaintext preview from a record's message content. */
export function extractPreview(content: unknown, maxLen = 140): { preview: string; length: number } {
  const text = extractText(content);
  return {
    preview: text.slice(0, maxLen).replace(/\s+/g, " ").trim(),
    length: text.length,
  };
}

/**
 * Extract a plaintext preview from a message's content blocks.
 *
 * IMPORTANT: tool_use blocks are deliberately NOT included. A mixed
 * assistant turn (text + tool_use) is classified as "text" so the user can
 * read the reply; if we also surfaced the tool_use stubs in the preview,
 * cards looked like they were showing tool-call content even when the
 * tool-call visibility toggle was off. The user can always inspect the full
 * structured content (including tool_use JSON) via the inline card expand.
 *
 * For pure tool-only assistant turns, this returns an empty string — those
 * are classified as "tool-only" and hidden when the toggle is off anyway.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown; content?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "tool_result" && typeof b.content === "string") {
        parts.push(b.content);
      } else if (b.type === "tool_result" && Array.isArray(b.content)) {
        parts.push(extractText(b.content));
      }
      // tool_use blocks intentionally skipped — see docstring above.
    }
    return parts.join("\n");
  }
  return "";
}
