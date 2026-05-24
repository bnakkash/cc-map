# cc-map

Visualize Claude Code CLI sessions. Two views over the same data:

- **Session viewer** — a chip column down the side of every prompt and reply in a session, click to read. Solves the "I sent five prompts without reading the replies and now I have to scroll up forever" problem.
- **Tree-map** (Phase 2) — a 2D pannable canvas of every session you've ever had, with `--fork-session` branches and subagent side-chains visible at once.

Local-only. Reads `~/.claude/projects/` directly. No cloud, no auth beyond the local-server token.

## Status

Phase 1 in progress. See `../../../.claude/plans/i-want-to-start-ticklish-lecun.md` for the full plan and pre-build spike results.

## Layout

```
packages/
  parser/   pure TS, DOM-free, parses Claude Code JSONL into a forest
  web/      React + Vite UI (chip column + message pane; tree-map canvas in Phase 2)
apps/
  server/   Fastify on 127.0.0.1: serves UI, watches files, SessionStart hook endpoint
```

## Quick start

```sh
# 1. install
npm install

# 2. build the UI bundle (served by the local server)
npm run build --workspace=@cc-map/web

# 3. build the parser (server depends on it)
npm run build --workspace=@cc-map/parser

# 4. run the server (watches ~/.claude/projects/ for live updates)
npm run dev
```

On first start the server prints a clickable URL like:

```
http://127.0.0.1:5781/?token=<long-hex>
```

Open it. The token is also saved at `~/.cc-map/token` for re-use.

### Optional: wire the SessionStart hook

Tells the viewer which session you're actively typing in. Without it, the viewer
defaults to the most-recently-touched session, which is wrong when you have
several Claude Code instances open.

```sh
npm run install-hook --workspace=@cc-map/server
```

This adds an entry to `~/.claude/settings.json` that fires a fast POST to the
local server on every Claude Code session start.

### Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Next / previous chip |
| `n` | Jump to next unread reply |
| `/` | Focus the filter input |

### Layout

```
packages/
  parser/   pure TS, DOM-free, parses Claude Code JSONL into a forest
  web/      React + Vite UI (chip column + message pane; tree-map canvas in Phase 2)
apps/
  server/   Fastify on 127.0.0.1: serves UI, watches files, SessionStart hook endpoint
```
