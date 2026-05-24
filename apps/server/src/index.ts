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
  // Re-read the raw record from the file so we can return the full message content,
  // since GraphNode.preview is only the first 140 chars.
  const meta = state.forest.sessions.get(sessionId);
  const filePath = meta?.filePath || join(CONFIG.projectsRoot, meta?.projectSlug ?? "", `${sessionId}.jsonl`);
  const raw = await findRawByUuid(filePath, uuid);
  return { node, raw };
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
