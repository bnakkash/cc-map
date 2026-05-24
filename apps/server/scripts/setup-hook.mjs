#!/usr/bin/env node
/**
 * Install the cc-map SessionStart hook into ~/.claude/settings.json.
 *
 * Safe to re-run — idempotent. Reads existing settings, adds/updates the hook entry.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const NOTIFY_SCRIPT = resolve(__dirname, "hook-notify.mjs");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const HOOK_TAG = "cc-map:session-start";

async function main() {
  let settings = {};
  try {
    const text = await readFile(SETTINGS_PATH, "utf8");
    settings = JSON.parse(text);
  } catch {
    // file may not exist yet
  }

  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];

  // Remove any existing cc-map matcher (idempotent)
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter((entry) => {
    if (!entry || !Array.isArray(entry.hooks)) return true;
    return !entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes("cc-map") && h.command.includes("hook-notify"));
  });

  settings.hooks.SessionStart.push({
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `node "${NOTIFY_SCRIPT.replace(/\\/g, "/")}"`,
        timeout: 2,
      },
    ],
  });

  await mkdir(join(homedir(), ".claude"), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`✓ Installed cc-map SessionStart hook into ${SETTINGS_PATH}`);
  console.log(`  command: node "${NOTIFY_SCRIPT}"`);
  console.log(`  tag    : ${HOOK_TAG}`);
  console.log(`  Next time you launch \`claude\`, it'll register the session with cc-map.`);
}

void main().catch((err) => {
  console.error("✗ Failed to install hook:", err);
  process.exit(1);
});
