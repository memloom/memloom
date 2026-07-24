import type { Graph } from "./api";

// The app polls /memory/graph every 15 seconds; handing GraphView a fresh object for
// unchanged data rebuilds 3,800 nodes and re-initializes the force engine (react-kapsule
// diffs props by reference). Keeping the previous reference when nothing changed makes a
// no-op poll actually a no-op.
export function graphsEqual(a: Graph, b: Graph): boolean {
  if (a === b) return true;
  if (a.memories.length !== b.memories.length) return false;
  if (a.entities.length !== b.entities.length) return false;
  if (a.documents.length !== b.documents.length) return false;
  if (a.edges.length !== b.edges.length) return false;
  // Counts match (the common no-change case gets here): both payloads come from the same
  // daemon serializer, so key order is deterministic and a string compare is exact.
  return JSON.stringify(a) === JSON.stringify(b);
}
