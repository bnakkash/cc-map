export type {
  ClassifiedRole,
  Delta,
  ForkInfo,
  Forest,
  GraphNode,
  NodeClassification,
  RawRecord,
  SessionMeta,
  UserSubtype,
} from "./types.js";

export { classify, extractPreview } from "./classifier.js";
export { parseFile, parseLineToNode, tailFromOffset } from "./jsonl.js";
export { buildForest, discoverFiles, loadForest, sessionFilePath } from "./forest.js";
export { startWatcher } from "./watcher.js";
