import { homedir } from "node:os";
import { join } from "node:path";
import { discoverFiles } from "../src/forest.js";
import { parseFile } from "../src/index.js";

const root = join(homedir(), ".claude", "projects");
const files = await discoverFiles(root);
const maintrak = files.filter((f) => f.projectSlug === "C--Users-bnakk-projects-maintrak");
console.log(`maintrak files: ${maintrak.length}`);
for (const f of maintrak) console.log(`  ${f.isSidechain ? "[SUB]" : "[MAIN]"} ${f.sessionId.slice(0, 8)} ${f.filePath}`);

const FORK_PARENT = "76e24d16-b773-4068-bb06-4cc419fa8a0b";
console.log(`\nLooking for children of parent ${FORK_PARENT}:`);
const childrenBySession = new Map<string, string[]>();
for (const f of maintrak) {
  const nodes = await parseFile(f.filePath, { projectSlug: f.projectSlug, sessionId: f.sessionId });
  for (const n of nodes) {
    if (n.parentId === FORK_PARENT) {
      const arr = childrenBySession.get(n.sessionId) ?? [];
      arr.push(n.id);
      childrenBySession.set(n.sessionId, arr);
      console.log(`  child uuid=${n.id.slice(0, 8)} sessionId=${n.sessionId.slice(0, 8)} role=${n.classification.role} file=${f.sessionId.slice(0, 8)}`);
    }
  }
}
console.log(`\nDistinct child sessionIds: ${childrenBySession.size}`);
for (const [sid, kids] of childrenBySession) {
  console.log(`  ${sid.slice(0, 8)} -> ${kids.length} child(ren)`);
}
