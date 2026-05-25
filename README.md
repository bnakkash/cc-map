# cc-map

A 2D pannable map of every Claude Code session you've ever had. Watches
`~/.claude/projects/` and renders all sessions as a forest you can pan, zoom,
filter, search, group, and bookmark. Live-updates as you type new prompts in
any active Claude Code instance.

Local-only. No cloud. No data leaves your machine.

![cc-map screenshot placeholder — drop one in here when you take it]()

## What it solves

Originally: "I fired off 5 prompts to Claude Code without reading the replies,
now I can't find reply #2 anywhere." Grew into a workspace for browsing across
all sessions (timelines, projects, forks, subagents) and spawning new ones.

## Quick start

```sh
npm install
npm run dev          # builds parser + web, starts Fastify on 127.0.0.1
```

First start prints a URL with a one-time bearer token (also saved to
`~/.cc-map/token`):

```
http://127.0.0.1:5781/?token=<hex>
```

Open it. The map loads with all your sessions.

## Layout modes

- **grid** — square-ish tree-map; fork siblings stack vertically
- **column** — each session is a row; prompts go down, replies go right
- **timeline** — one column per session, ordered by start time; Y axis is
  *real wall-clock time* (with capped gaps so a week-long pause doesn't blow
  up the canvas). Reveals burst sessions and idle days at a glance.

## Node styles

- **dots** — fast, good for overview
- **cards** — text preview rendered in-place at variable height; click to
  expand inline with full markdown + syntax highlighting

## Color modes

- **role** — user/assistant/subagent semantic colors
- **recency** — zinc → emerald gradient (most recent activity glows)
- **cost** — zinc → amber → red, mapped to assistant output tokens

## Power features

- **Live tip + follow live** — pulsing emerald dot on the active session's
  latest message; off-screen arrow points to it when you've panned away;
  optional auto-recenter as new messages arrive
- **Spaces** — named workspaces grouping curated sessions; `Shift+drag` a
  node onto a Space chip to add it
- **Saved views** — snapshot `(scope, filter, visibility, layout, color)` and
  recall by name; URL-shareable via hash encoding
- **Command palette** (`Cmd/Ctrl+K`) — jump to any session, switch any mode,
  apply any saved view, run any common action
- **Search** — substring match with step-through (`Enter` / `Shift+Enter`),
  recent searches dropdown, in-tooltip match highlighting
- **Minimap** (top-right) — thumbnail with draggable viewport rectangle
- **Bookmark gutter** (left edge) — amber stars at every bookmark's screen Y
- **Multi-select** — `Ctrl/Cmd+click` to accumulate, then bulk bookmark or
  add-to-Space from a floating toolbar
- **Subagent collapse** — `+N subagents` badges on parents when sidechain
  visibility is off; click to expand globally
- **Animated mode transitions** — switching grid ↔ column ↔ timeline morphs
  positions over 450ms so spatial relationships stay readable
- **Daily activity heatmap** in the sidebar (last 5 weeks)

## Sessions you spawn from the map

Right-click any session band or node → context menu has:

- **Resume in Windows Terminal** — opens `claude --resume <id>` in a new
  terminal window
- **Fork from this point** — opens `claude --fork-session <id>` (creates a
  divergent branch)
- **Add to Space**

You can also spawn entirely new sessions inside a Space from the map (Phase 3c).

## Architecture

```
packages/
  parser/   Pure TS. Parses JSONL into a forest. DOM-free so it could run server-side later.
  web/      React 19 + Vite 6 + Tailwind 4. Canvas 2D rendering (not SVG/pixi).
apps/
  server/   Fastify 5 on 127.0.0.1:5174. Bearer-token auth. SSE for live forest deltas.
            Spawn endpoints. Watches ~/.claude/projects/ via chokidar.
```

### Quirks

- **Windows chokidar** on appended files is flaky — `usePolling: true` plus a
  2-second backstop poll in `packages/parser/src/watcher.ts` handles new files
  AND grew-files reliably.
- **`--fork-session`** creates cross-file shared messages with identical
  uuids. The forest builder walks the raw stream BEFORE dedup so the adjacency
  is correct.
- **Active session** detection: server's `activeSessionId` is one-shot at
  load; client recomputes from the latest-timestamp node on every forest
  update, so it stays correct as you type.

## Settings hook (optional)

For more accurate active-session detection when you have multiple Claude Code
instances open:

```sh
npm run install-hook --workspace=@cc-map/server
```

Adds a SessionStart hook entry to `~/.claude/settings.json` that pings the
local server when a Claude Code session starts.

## Develop

```sh
npm run dev                  # server + Vite (port 5174 by default)
npm run dev:web              # web only (no server)
npm run typecheck            # tsc -b in every workspace
npm test                     # vitest (parser + web)
npm run e2e --workspace=packages/web    # playwright smoke tests (after npx playwright install chromium)
```

Tests:

- `packages/parser/test/*.test.ts` — 22 tests for jsonl parser + classifier
- `packages/web/src/canvas/layout.test.ts` — 10 tests for buildLayout
  (grid/column/timeline, fork stacking, subagent count, timeline gap clamping,
  card height)
- `packages/web/tests/smoke.spec.ts` — 7 Playwright smoke tests (need the dev
  server running on 127.0.0.1:5174)

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Cmd/Ctrl+K` | Open command palette |
| `/` | Open search |
| `Enter` / `Shift+Enter` | (in search) next / previous match |
| `Alt+←` / `Alt+→` | Selection history back / forward |
| `↑` `↓` `←` `→` | Cycle through visible nodes in the focused session |
| `Space` | Jump to live tip |
| `b` | Bookmark selected node |
| `0` / `f` | Fit all |
| `1` | Fit most-recent session |
| `?` | Toggle help overlay |
| `g v / g b / g s / g f / g l` | Gmail-style chord shortcuts |
| `Shift+drag node` | Drag-to-Space gesture |
| `Ctrl/Cmd+click` | Toggle node in multi-select |

`?` in the app shows the full cheat sheet.

## License

Private project. Not currently published.
