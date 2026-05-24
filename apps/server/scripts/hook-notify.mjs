#!/usr/bin/env node
/**
 * cc-map SessionStart hook.
 *
 * Wire into ~/.claude/settings.json:
 *
 *   "hooks": {
 *     "SessionStart": [
 *       {
 *         "matcher": "*",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node C:/Users/bnakk/projects/cc-map/apps/server/scripts/hook-notify.mjs"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Reads the SessionStart payload from stdin (JSON), POSTs to the local server.
 * Fast and fire-and-forget — does not block Claude Code startup.
 *
 * Reads token from ~/.cc-map/token.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 1500;

const TOKEN_PATH = join(homedir(), ".cc-map", "token");
const PORT = process.env.CC_MAP_PORT ?? 5781;

async function main() {
  // Read stdin (hook payload) — Claude Code sends a JSON object
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) stdin += chunk;

  let payload = {};
  try {
    payload = JSON.parse(stdin);
  } catch {
    process.exit(0); // nothing to do
  }

  const sessionId = payload.session_id ?? payload.sessionId;
  const cwd = payload.cwd ?? null;
  if (!sessionId) process.exit(0);

  let token = "";
  try {
    token = (await readFile(TOKEN_PATH, "utf8")).trim();
  } catch {
    process.exit(0); // server not initialized yet
  }
  if (!token) process.exit(0);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/hook/session-start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionId, cwd, source: payload.source ?? null }),
      signal: controller.signal,
    });
  } catch {
    // server probably not running; ignore silently so Claude Code isn't slowed
  } finally {
    clearTimeout(timer);
  }
}

void main();
