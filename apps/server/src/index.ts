import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkToken, extractToken, loadOrCreateToken } from "./auth.js";
import { CONFIG } from "./config.js";
import { ServerState, type ServerEvent } from "./state.js";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_RE = SESSION_ID_RE;

const fastify = Fastify({
  logger: { level: "info" },
});

const token = await loadOrCreateToken();
const state = await ServerState.load();
const stopWatcher = state.startWatching();

// Token middleware: every /api/* route requires a valid token, except hook
// (which carries its own token via the hook config).
fastify.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  const provided = extractToken(req);
  if (!checkToken(provided, token)) {
    reply.code(401).send({ error: "unauthorized" });
  }
});

// CORS: only allow localhost (other ports might be the UI dev server).
fastify.addHook("onSend", async (_req, reply, payload) => {
  reply.header("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return payload;
});
fastify.options("/*", async (_req, reply) => reply.send());

// ───── routes ─────

fastify.get("/api/health", async () => ({ ok: true, version: "0.0.1" }));

/**
 * GET /api/forest — lightweight whole-forest topology for the tree-map view.
 * Excludes full message content (only preview ≤ 80 chars) to keep the payload
 * manageable. ~7-10MB for ~40k nodes. Compressed by Fastify if Accept-Encoding allows.
 */
fastify.get("/api/forest", async () => {
  const nodes: Array<{
    id: string;
    parentId: string | null;
    sessionId: string;
    projectSlug: string;
    role: "user" | "assistant";
    subtype: string | null;
    isSidechain: boolean;
    timestamp: string;
    preview: string;
    sessionsIn: number;
    /** Output tokens for assistant turns (0 otherwise). Used for sparkline. */
    outputTokens: number;
  }> = [];
  for (const n of state.forest.nodes.values()) {
    const sessIn = state.forest.sessionsContainingNode.get(n.id);
    nodes.push({
      id: n.id,
      parentId: n.parentId,
      sessionId: n.sessionId,
      projectSlug: n.projectSlug,
      role: n.classification.role,
      subtype: n.classification.role === "user" ? n.classification.subtype : null,
      isSidechain: n.isSidechain,
      timestamp: n.timestamp,
      preview: n.preview.slice(0, 80),
      sessionsIn: sessIn ? sessIn.length : 1,
      outputTokens: n.usage?.outputTokens ?? 0,
    });
  }
  const projects = [...state.forest.sessionsByProject.entries()].map(([slug, sids]) => {
    const projectMetas = sids
      .map((sid) => state.forest.sessions.get(sid))
      .filter((m): m is NonNullable<typeof m> => m != null);
    const totalInput = projectMetas.reduce((s, m) => s + m.totalUsage.inputTokens, 0);
    const totalOutput = projectMetas.reduce((s, m) => s + m.totalUsage.outputTokens, 0);
    const totalCacheRead = projectMetas.reduce((s, m) => s + m.totalUsage.cacheReadTokens, 0);
    const totalCacheCreate = projectMetas.reduce((s, m) => s + m.totalUsage.cacheCreationTokens, 0);
    return {
      slug,
      sessionCount: sids.length,
      tokens: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheCreation: totalCacheCreate },
    };
  });
  const sessionTitles: Record<string, { aiTitle: string | null; tokens: { input: number; output: number; cacheRead: number; cacheCreation: number } }> = {};
  for (const m of state.forest.sessions.values()) {
    sessionTitles[m.sessionId] = {
      aiTitle: m.aiTitle,
      tokens: {
        input: m.totalUsage.inputTokens,
        output: m.totalUsage.outputTokens,
        cacheRead: m.totalUsage.cacheReadTokens,
        cacheCreation: m.totalUsage.cacheCreationTokens,
      },
    };
  }
  // "Active session": prefer the one registered by the SessionStart hook.
  // Fall back to the most-recently-touched session (works without the hook).
  const hookActive = state.getActiveSession();
  let activeSessionId = hookActive.sessionId;
  if (!activeSessionId) {
    let bestTs = "";
    for (const s of state.forest.sessions.values()) {
      if (s.lastActivityAt && s.lastActivityAt > bestTs) {
        bestTs = s.lastActivityAt;
        activeSessionId = s.sessionId;
      }
    }
  }
  return {
    nodes,
    forks: state.forest.forks,
    projects,
    sessionCount: state.forest.sessions.size,
    activeSessionId,
    activeSessionAt: hookActive.at,
    sessionTitles,
  };
});

fastify.get("/api/sessions", async () => {
  const list = [...state.forest.sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    projectSlug: s.projectSlug,
    cwd: s.cwd,
    nodeCount: s.nodeCount,
    promptCount: s.promptCount,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
  }));
  list.sort((a, b) => {
    const ta = a.lastActivityAt ?? "";
    const tb = b.lastActivityAt ?? "";
    return tb.localeCompare(ta);
  });
  return { sessions: list, activeSession: state.getActiveSession() };
});

fastify.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/chips", async (req, reply) => {
  const { sessionId } = req.params;
  if (!SESSION_ID_RE.test(sessionId)) {
    return reply.code(400).send({ error: "invalid sessionId" });
  }
  const meta = state.forest.sessions.get(sessionId);
  if (!meta) return reply.code(404).send({ error: "session not found" });

  // Gather all nodes belonging to this session, in timestamp order
  const chips: Array<{
    id: string;
    parentId: string | null;
    role: string;
    subtype: string | null;
    timestamp: string;
    preview: string;
    contentLength: number;
    isSidechain: boolean;
    sharedWith: string[];
  }> = [];
  for (const node of state.forest.nodes.values()) {
    const sessions = state.forest.sessionsContainingNode.get(node.id) ?? [node.sessionId];
    if (!sessions.includes(sessionId)) continue;
    chips.push({
      id: node.id,
      parentId: node.parentId,
      role: node.classification.role,
      subtype: node.classification.role === "user" ? node.classification.subtype : null,
      timestamp: node.timestamp,
      preview: node.preview,
      contentLength: node.contentLength,
      isSidechain: node.isSidechain,
      sharedWith: sessions.filter((s) => s !== sessionId),
    });
  }
  chips.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { sessionId, meta, chips };
});

fastify.get<{
  Params: { sessionId: string; uuid: string };
}>("/api/sessions/:sessionId/nodes/:uuid", async (req, reply) => {
  const { sessionId, uuid } = req.params;
  if (!SESSION_ID_RE.test(sessionId)) return reply.code(400).send({ error: "invalid sessionId" });
  if (!UUID_RE.test(uuid)) return reply.code(400).send({ error: "invalid uuid" });
  const map = await state.getFullSessionNodes(sessionId);
  if (!map) return reply.code(404).send({ error: "session not found" });
  const node = map.get(uuid);
  if (!node) return reply.code(404).send({ error: "node not found in session" });
  // Look up the raw record by scanning every file that belongs to this session
  // (main JSONL + any subagent JSONLs). Stop at first match.
  const files = state.getSessionFiles(sessionId);
  let raw: unknown = null;
  for (const f of files) {
    raw = await findRawByUuid(f, uuid);
    if (raw) break;
  }
  return { node, raw };
});

/**
 * POST /api/resume — launch `claude --resume <sessionId>` in a new terminal.
 * Optional `fork: true` adds `--fork-session`. Validates session ID strictly to
 * avoid command injection.
 */
fastify.post<{
  Body: { sessionId?: unknown; cwd?: unknown; fork?: unknown };
}>("/api/resume", async (req, reply) => {
  const { sessionId, cwd, fork } = req.body ?? {};
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return reply.code(400).send({ error: "invalid sessionId" });
  }
  const safeCwd = typeof cwd === "string" && /^[A-Za-z]:[\\/].+/.test(cwd) ? cwd : null;
  const args = ["--resume", sessionId];
  if (fork) args.push("--fork-session");
  // Build the user-facing command string for display + clipboard fallback
  const cmd = `claude ${args.join(" ")}`;
  try {
    const { spawn } = await import("node:child_process");
    if (process.platform === "win32") {
      // Try wt.exe (Windows Terminal) first; fall back to cmd.exe /c start
      const wtArgs: string[] = [];
      if (safeCwd) wtArgs.push("-d", safeCwd);
      wtArgs.push("cmd.exe", "/k", "claude", ...args);
      try {
        spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore" }).unref();
        return { ok: true, command: cmd, launched: "windows-terminal" };
      } catch {
        // fallback
        const cwdArg = safeCwd ? `/d ${safeCwd}` : "";
        spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", `${cwdArg} && claude ${args.join(" ")}`], {
          detached: true,
          stdio: "ignore",
          shell: true,
        }).unref();
        return { ok: true, command: cmd, launched: "cmd" };
      }
    }
    // POSIX (macOS / Linux): just print the command — terminal-launching is messy cross-DE
    return { ok: false, command: cmd, hint: "Copy and run the command manually" };
  } catch (err) {
    return reply.code(500).send({ error: String(err), command: cmd });
  }
});

fastify.post<{
  Body: { sessionId?: unknown; cwd?: unknown; source?: unknown };
}>("/api/hook/session-start", async (req, reply) => {
  const { sessionId, cwd } = req.body ?? {};
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return reply.code(400).send({ error: "invalid sessionId" });
  }
  await state.setActiveSession(sessionId, typeof cwd === "string" ? cwd : null);
  return { ok: true };
});

fastify.get("/api/stream", async (req: FastifyRequest, reply: FastifyReply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Send a hello so clients know they connected
  reply.raw.write(`: connected\n\n`);

  const send = (event: ServerEvent) => {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsub = state.subscribe(send);

  // Keep-alive every 25s
  const keepalive = setInterval(() => {
    reply.raw.write(`: keepalive\n\n`);
  }, 25_000);

  req.raw.on("close", () => {
    clearInterval(keepalive);
    unsub();
  });

  // The promise never resolves — Fastify keeps the connection open
  return new Promise<void>(() => {});
});

// ───── static UI (served from packages/web/dist when present) ─────

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "..", "..", "packages", "web", "dist");

fastify.get("/*", async (req, reply) => {
  if (req.url.startsWith("/api/")) {
    return reply.code(404).send({ error: "not found" });
  }
  // Map / to /index.html
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0]!;
  try {
    const filePath = join(UI_DIR, urlPath);
    const body = await readFile(filePath);
    const ext = urlPath.slice(urlPath.lastIndexOf(".") + 1);
    reply.header("Content-Type", contentTypeFor(ext));
    return reply.send(body);
  } catch {
    // Fallback to index.html for SPA routing
    try {
      const body = await readFile(join(UI_DIR, "index.html"));
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(body);
    } catch {
      return reply
        .code(404)
        .send(`UI not built yet. Run \`npm run build --workspace=@cc-map/web\` first, or use \`npm run dev:web\` for dev mode.`);
    }
  }
});

// ───── helpers ─────

function contentTypeFor(ext: string): string {
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

async function findRawByUuid(filePath: string, uuid: string): Promise<unknown> {
  // Used by /api/sessions/:sid/nodes/:uuid to return the full original record
  // for rendering. Linear scan of the JSONL — fine for one-off requests.
  try {
    const text = await readFile(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(uuid)) continue;
      try {
        const parsed = JSON.parse(line) as { uuid?: string };
        if (parsed.uuid === uuid) return parsed;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return null;
}

// ───── startup ─────

const PORT = CONFIG.port;
try {
  await fastify.listen({ host: CONFIG.host, port: PORT });
  fastify.log.info(`cc-map server listening on http://${CONFIG.host}:${PORT}`);
  fastify.log.info(`Open in browser: http://${CONFIG.host}:${PORT}/?token=${token}`);
  fastify.log.info(`Token also stored at: ${CONFIG.stateDir}\\token`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async () => {
  fastify.log.info("shutting down...");
  try {
    await stopWatcher();
    await fastify.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
