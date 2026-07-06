export type MemoryStatus = "active" | "stale";

// The saveable memory taxonomy, shared with the hosted platform's `type_hint` so a memory means the same
// thing whichever client wrote it. One source of truth: the zod enum, the DB CHECK, and the docs
// all derive from this list.
//   fact       — a stable truth about the world or the user ("the staging DB runs on Postgres")
//   preference — how the user likes things done ("prefers pnpm over npm")
//   episode    — a time-bound event or decision ("shipped the viewer on 2026-07-05")
//   procedure  — reusable how-to steps ("to release: bump VERSION, tag, push")
export const MEMORY_TYPES = ["fact", "preference", "episode", "procedure"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Memory {
  id: string;
  ownerId: string;
  status: MemoryStatus;
  // Saved memories carry a MemoryType; recall results for ingested context chunks carry the
  // sentinel "context" (their real discriminator is `kind`, below — not this field).
  memoryType: MemoryType | "context";
  canonical: string | null;
  content: string;
  summary: string | null;
  assertedAt: string;
  createdAt: string;
  /** Cosine similarity to the query (the meaning signal alone), present on recall results. */
  similarity?: number;
  /** Fused reciprocal-rank-fusion score; the order recall results should be trusted in. */
  rrfScore?: number;
  /** Set on recall results: a saved memory, or a chunk of an ingested context document. */
  kind?: "memory" | "context";
  /** Where a context chunk came from — surfaces show this so provenance is always clear. */
  source?: RecallSource;
}

export interface RecallSource {
  documentId: string;
  title: string;
  path: string;
  headingPath: string | null;
  /** 1-based PDF page, when the chunk came from a PDF. */
  page: number | null;
}

export interface SaveInput {
  content: string;
  canonical?: string;
  /** One of the MEMORY_TYPES; defaults to "fact" when omitted. */
  memoryType?: MemoryType;
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

// ---- Context connector (files mirrored into chunked, searchable rows) ----

export interface ContextAddInput {
  /** Absolute path to a .md, .txt, or .pdf file on the daemon's machine. */
  path: string;
  ownerId?: string;
}

export type ContextAddOutcome = "added" | "updated" | "unchanged";

export interface ContextAddResult {
  documentId: string;
  outcome: ContextAddOutcome;
  title: string;
  chunks: number;
}

export interface ContextDocument {
  id: string;
  path: string;
  title: string;
  kind: string;
  chunkCount: number;
  updatedAt: string;
}

// The four human-in-the-loop resolution actions. All reversible.
export type ResolveDecision =
  | { action: "keep_new" } // supersede: the new memory wins, existing ones go stale
  | { action: "keep_existing"; candidateId: string } // an existing memory wins, the new one goes stale
  | { action: "keep_both" } // mark them distinct; both stay active
  | { action: "merge"; content: string; canonical?: string }; // a reconciled memory supersedes both
