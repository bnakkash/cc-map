import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildLayout } from "../src/canvas/layout.js";
import { DEFAULT_VISIBILITY, type ForestPayload } from "../src/canvas/types.js";

const token = (await readFile(join(homedir(), ".cc-map", "token"), "utf8")).trim();
const res = await fetch("http://127.0.0.1:5781/api/forest", { headers: { Authorization: `Bearer ${token}` } });
const payload = (await res.json()) as ForestPayload;
console.log(`forest: ${payload.nodes.length} nodes`);

const top = [...payload.projects].sort((a, b) => b.sessionCount - a.sessionCount)[0]!;
for (const dir of ["grid", "column"] as const) {
  const t = Date.now();
  const l = buildLayout(payload, "per-project", top.slug, DEFAULT_VISIBILITY, dir);
  console.log(`${dir}: ${l.nodes.size} nodes, ${l.sessionBands.length} sessions in ${Date.now() - t}ms`);
  console.log(`  bounds: ${JSON.stringify(l.bounds)}`);
}
