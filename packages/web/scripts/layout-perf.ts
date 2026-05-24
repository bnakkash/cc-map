// Smoke test: fetch /api/forest, build a layout, report timings.
// Usage: npx tsx packages/web/scripts/layout-perf.ts <token>
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildLayout } from "../src/canvas/layout.js";
import type { ForestPayload } from "../src/canvas/types.js";

const token = (await readFile(join(homedir(), ".cc-map", "token"), "utf8")).trim();

const t0 = Date.now();
const res = await fetch("http://127.0.0.1:5781/api/forest", {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const payload = (await res.json()) as ForestPayload;
console.log(`fetched in ${Date.now() - t0}ms: ${payload.nodes.length} nodes, ${payload.forks.length} forks, ${payload.projects.length} projects`);

// Per-project layout for the largest project
const top = [...payload.projects].sort((a, b) => b.sessionCount - a.sessionCount)[0]!;
const t1 = Date.now();
const layoutPerProject = buildLayout(payload, "per-project", top.slug);
console.log(`per-project (${top.slug}, ${top.sessionCount} sessions): ${layoutPerProject.nodes.size} laid out in ${Date.now() - t1}ms`);
console.log(`  bounds: ${JSON.stringify(layoutPerProject.bounds)}`);

// All-projects layout
const t2 = Date.now();
const layoutAll = buildLayout(payload, "all-projects", null);
console.log(`all-projects: ${layoutAll.nodes.size} laid out in ${Date.now() - t2}ms`);
console.log(`  bounds: ${JSON.stringify(layoutAll.bounds)}`);
console.log(`  project bands: ${layoutAll.projectBands.size}`);
