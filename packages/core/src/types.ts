export type MemoryStatus = "active" | "stale";

export interface Memory {
  id: string;
  ownerId: string;
  status: MemoryStatus;
  memoryType: string;
  canonical: string | null;
  content: string;
  summary: string | null;
  assertedAt: string;
  createdAt: string;
  /** Cosine similarity to the query (the meaning signal alone), present on recall results. */
  similarity?: number;
  /** Fused reciprocal-rank-fusion score; the order recall results should be trusted in. */
  rrfScore?: number;
}

export interface SaveInput {
  content: string;
  canonical?: string;
  memoryType?: string;
  /** Defaults to the fixed sentinel owner in the embedded (single-user) tier. */
  ownerId?: string;
}

export type SaveOutcome = "added" | "merged" | "conflict";

export interface SaveResult {
  id: string;
  /** What the belief pipeline did: a fresh memory, a dedup merge, or a flagged conflict. */
  outcome: SaveOutcome;
  /** Set when outcome is "conflict": the id of the pending decision to resolve. */
  conflictId?: string;
}

export interface RecallOptions {
  limit?: number;
  ownerId?: string;
}

export interface ConflictCandidate {
  id: string;
  canonical: string | null;
  content: string;
  relation: string;
  reason: string;
}

export interface Conflict {
  id: string;
  createdAt: string;
  incoming: { id: string; canonical: string | null; content: string };
  candidates: ConflictCandidate[];
}

export interface Entity {
  id: string;
  name: string;
  entityType: string;
}

export interface GraphMemory {
  id: string;
  canonical: string | null;
  content: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
}

// The memory graph the viewer renders: memories + entities as nodes, edges between them.
export interface Graph {
  memories: GraphMemory[];
  entities: Entity[];
  edges: GraphEdge[];
}

export interface IndexResult {
  indexed: number;
}

// The four human-in-the-loop resolution actions. All reversible.
export type ResolveDecision =
  | { action: "keep_new" } // supersede: the new memory wins, existing ones go stale
  | { action: "keep_existing"; candidateId: string } // an existing memory wins, the new one goes stale
  | { action: "keep_both" } // mark them distinct; both stay active
  | { action: "merge"; content: string; canonical?: string }; // a reconciled memory supersedes both
