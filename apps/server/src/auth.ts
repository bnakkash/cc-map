import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "./config.js";

const TOKEN_FILE = join(CONFIG.stateDir, "token");

/**
 * Read the API token from ~/.cc-map/token, generating it on first run.
 * The token is what the browser UI and the SessionStart hook both use.
 */
export async function loadOrCreateToken(): Promise<string> {
  await mkdir(CONFIG.stateDir, { recursive: true });
  try {
    const existing = await readFile(TOKEN_FILE, "utf8");
    const trimmed = existing.trim();
    if (trimmed.length >= 32) return trimmed;
  } catch {
    // fall through to create
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

/** Reject requests that don't carry the right token. */
export function checkToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  // constant-time compare avoidance: tokens are random, equal length, not user-controlled timing-sensitive — plain compare is fine here
  return provided === expected;
}

/** Pull the token off a Fastify request: `Authorization: Bearer X` or `?token=X` query. */
export function extractToken(req: {
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
}): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  if (req.query && typeof req.query === "object" && "token" in (req.query as Record<string, unknown>)) {
    const t = (req.query as Record<string, unknown>).token;
    if (typeof t === "string") return t;
  }
  return undefined;
}
