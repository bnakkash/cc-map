import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG = {
  /** Where the local server binds. 127.0.0.1 only — never bind 0.0.0.0. */
  host: "127.0.0.1",
  /** Port — picked to be unlikely to conflict. Override with CC_MAP_PORT env var. */
  port: Number(process.env.CC_MAP_PORT ?? 5781),
  /** Where we read Claude Code session JSONLs from. */
  projectsRoot: join(homedir(), ".claude", "projects"),
  /** Where we persist our own state (token, last active session). */
  stateDir: join(homedir(), ".cc-map"),
} as const;
