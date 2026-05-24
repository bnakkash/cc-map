// Smoke test: load the real ~/.claude/projects/ forest and print summary stats.
// Run with: npx tsx packages/parser/scripts/smoke.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { loadForest } from "../src/index.js";

const root = join(homedir(), ".claude", "projects");
console.log(`Loading forest from ${root} ...`);
const t0 = Date.now();
const forest = await loadForest(root);
const elapsed = Date.now() - t0;

console.log(`Loaded in ${elapsed}ms`);
console.log(`  Nodes: ${forest.nodes.size}`);
console.log(`  Roots: ${forest.roots.length}`);
console.log(`  Sessions: ${forest.sessions.size}`);
console.log(`  Projects: ${forest.sessionsByProject.size}`);
console.log(`  Cross-session forks: ${forest.forks.length}`);

console.log("\nTop 5 sessions by node count:");
const sessions = [...forest.sessions.values()].sort((a, b) => b.nodeCount - a.nodeCount).slice(0, 5);
for (const s of sessions) {
  console.log(
    `  ${s.sessionId.slice(0, 8)}.. ${s.projectSlug.slice(0, 40).padEnd(40)} ` +
      `nodes=${String(s.nodeCount).padStart(5)} prompts=${String(s.promptCount).padStart(4)}`,
  );
}

console.log("\nProjects:");
for (const [slug, sessIds] of forest.sessionsByProject) {
  console.log(`  ${slug.slice(0, 60).padEnd(60)} ${sessIds.length} sessions`);
}

console.log("\nFork examples (first 3):");
for (const fork of forest.forks.slice(0, 3)) {
  const parent = forest.nodes.get(fork.parentUuid);
  console.log(`  parent=${fork.parentUuid.slice(0, 8)} -> ${fork.sessionIds.length} sessions: [${fork.sessionIds.map(s => s.slice(0, 8)).join(", ")}]`);
  if (parent) console.log(`    parent role=${parent.classification.role} preview="${parent.preview.slice(0, 80)}"`);
}

// Classification distribution
const counts = new Map<string, number>();
for (const n of forest.nodes.values()) {
  const key = n.classification.role === "user"
    ? `user:${n.classification.subtype}`
    : "assistant";
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log("\nNode classification:");
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}
