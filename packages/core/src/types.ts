export type MemoryStatus = "active" | "stale";

// The saveable memory taxonomy, shared with the hosted platform's `type_hint` so a memory means the same
// thing whichever client wrote it. One source of truth: the zod enum, the DB CHECK, and the docs
// all derive from this list.
//   fact       : a stable truth about the world or the user ("the staging DB runs on Postgres")
//   preference : how the user likes things done ("prefers pnpm over npm")
//   episode    : a time-bound event or decision ("shipped the viewer on 2026-07-05")
//   procedure  : reusable how-to steps ("to release: bump VERSION, tag, push")
export const MEMORY_TYPES = ["fact", "preference", "episode", "procedure"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Memory {
  id: string;
  ownerId: string;
  status: MemoryStatus;
  // Saved memories carry a MemoryType; recall results for ingested context chunks carry the
  // sentinel "context" (their real discriminator is `kind`, below, not this field).
  memoryType: MemoryType | "context";
  canonical: string | null;
  content: string;
  summary: string | null;
  // Version lineage: every version of one belief shares a rootId; the newest active row is the
  // current version. See history(). Chunks (kind "context") aren't versioned; rootId falls back
  // to their own id and version is 1.
  rootId: string;
  version: number;
  // valid-from of this version (asserted_at). stale_since is the valid-to, exposed via status.
  assertedAt: string;
  createdAt: string;
  /** Cosine similarity to the query (the meaning signal alone), present on recall results. */
  similarity?: number;
  /** Fused reciprocal-rank-fusion score; the order recall results should be trusted in. */
  rrfScore?: number;
  /** Set on recall results: a saved memory, or a chunk of an ingested context document. */
  kind?: "memory" | "context";
  /** Where a context chunk came from; surfaces show this so provenance is always clear. */
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

// "versioned": the save restated an existing belief, so a new version was appended to its
// lineage (the prior version is now stale). See [[node-versioning]].
export type SaveOutcome = "added" | "merged" | "conflict" | "versioned";

export interface SaveResult {
  id: string;
  /** What the belief pipeline did: fresh memory, dedup merge, new version, or a flagged conflict. */
  outcome: SaveOutcome;
  /** Set when outcome is "conflict": the id of the pending decision to resolve. */
  conflictId?: string;
  /** Set when outcome is "versioned": the new version number (>= 2). */
  version?: number;
}

export interface UpdateInput {
  /** The memory to edit; must be an active belief. Its lineage gains a new current version. */
  id: string;
  content: string;
  canonical?: string;
  ownerId?: string;
}

export interface UpdateResult {
  /** The id of the new current version (a fresh row; the edited one is now stale). */
  id: string;
  rootId: string;
  version: number;
}

export interface RecallOptions {
  limit?: number;
  ownerId?: string;
  /**
   * Restrict to memories asserted on one calendar day ("YYYY-MM-DD"), ranked by
   * similarity. The temporal arm: "plans for today" has no lexical or semantic overlap
   * with the plan's content, but its date does. Context chunks are excluded (files have
   * no assertion day).
   */
  assertedOn?: string;
  /**
   * Also search chunks attached to this assistant chat session. Global chunks are always
   * searched; a chat's attachments are visible only to its own recalls.
   */
  sessionId?: string;
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

/** An entity with usage counts: the management list in the schema tab. */
export interface EntityDetail extends Entity {
  /** Active mention edges pointing at this entity. */
  mentions: number;
  /** Distinct active memories that mention it. */
  memories: number;
  /** Distinct context documents whose chunks mention it. */
  documents: number;
}

export interface GraphMemory {
  id: string;
  canonical: string | null;
  content: string;
  memoryType: MemoryType;
}

// A context document as a graph node. Documents, not chunks, are the display granularity:
// one PDF can be hundreds of chunks, and a force graph of chunks is a hairball nobody reads.
export interface GraphDocument {
  id: string;
  title: string;
  path: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  /** On document -> entity edges: how many of the document's chunks mention the entity. */
  weight?: number;
}

// The memory graph the viewer renders: one graph, two granularities. Memories, entities, and
// context documents as nodes; chunk-level 'mention' edges are rolled up to document -> entity
// so context connects to memory through the shared entity layer.
export interface Graph {
  memories: GraphMemory[];
  entities: Entity[];
  documents: GraphDocument[];
  edges: GraphEdge[];
}

export interface IndexResult {
  /** Memories processed this run (entity extraction + mention edges). */
  indexed: number;
  /** Context chunks processed this run; same extraction, edges roll up per document. */
  chunksIndexed: number;
}

/** One item finished during an index run: the real-time progress signal. */
export interface IndexProgressEvent {
  kind: "memory" | "chunk";
  id: string;
  /** Human-readable identity: memory content snippet, or "doc title › section". */
  label: string;
  /** 1-based position within this kind's pending set. */
  index: number;
  /** Total pending items of this kind in this run. */
  total: number;
  /** Names of the entities extracted from this item. */
  entities: string[];
  /** Typed entity-to-entity relationships stored from this item. */
  relationships?: number;
  /** Present when the item was skipped without an LLM call (formula-dominated chunk). */
  skipped?: "math-dense";
  /** Present when this item failed (extraction error); the item stays unindexed for retry. */
  error?: string;
}

// ---- Index run sessions (persistent, session-grouped logs for the Console) ----

export type IndexRunTrigger = "index" | "rebuild";
/** 'warning' = finished with failed items; 'interrupted' = the daemon died mid-run. */
export type IndexRunStatus = "running" | "success" | "warning" | "error" | "interrupted";

/** One index()/reindex() pass: the session row the Console lists, with status + totals. */
export interface IndexRun {
  id: string;
  trigger: IndexRunTrigger;
  status: IndexRunStatus;
  /** Items (memories + chunks) this run set out to process. */
  batchSize: number;
  memoriesIndexed: number;
  chunksIndexed: number;
  itemsFailed: number;
  /** Entity links made across the run (mentions per item, not distinct entities). */
  entitiesLinked: number;
  relationsCreated: number;
  startedAt: string;
  finishedAt: string | null;
}

export type IndexEventLevel = "info" | "success" | "warning" | "error";

/** One per-item log line under a run: what the Console shows when a session is expanded. */
export interface IndexRunEvent {
  id: string;
  level: IndexEventLevel;
  message: string;
  itemId: string | null;
  metadata: {
    entities?: string[];
    relationships?: number;
    skipped?: string;
    error?: string;
  };
  createdAt: string;
}

// ---- Assistant chat (the viewer's assistant tab; docs/design/assistant-tab.md) ----

/** One recall hit the assistant grounded an answer in. `n` matches the [n] markers. */
export interface AssistantSource {
  n: number;
  kind: "memory" | "context";
  id: string;
  title: string;
  snippet: string;
  similarity?: number;
  /** The memory's assertion day (YYYY-MM-DD); absent on context chunks. */
  date?: string;
  /** The saved memory's type ("fact", "procedure", ...); absent on context chunks. */
  memoryType?: MemoryType;
  /** The fused reciprocal-rank-fusion score this hit was ordered by. */
  rrfScore?: number;
  /** The top-level graph node this source maps to (the memory, or its parent document). */
  graphNodeId?: string;
}

export interface AssistantSession {
  id: string;
  title: string;
  isStarred: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: AssistantSource[];
  createdAt: string;
}

/** A chat-search hit: the session plus the message snippet that matched. */
export interface AssistantSessionHit extends AssistantSession {
  snippet: string;
}

export interface AssistantChatResult {
  sessionId: string;
  messageId: string;
  answer: string;
  sources: AssistantSource[];
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

// ---- Chat attachments (files uploaded into one assistant session's scope) ----

export interface ContextAttachInput {
  /** Filename with extension: picks the extractor and titles the document. */
  filename: string;
  /** Raw file bytes (the browser upload, base64-decoded by the server). */
  bytes: Uint8Array;
  /** Attach to this chat; omitted = a fresh session is created and returned. */
  sessionId?: string;
  ownerId?: string;
}

export interface ContextAttachResult extends ContextAddResult {
  /** The session the file is scoped to (newly created when none was passed). */
  sessionId: string;
}

export interface ContextChunk {
  id: string;
  chunkIndex: number;
  content: string;
  headingPath: string | null;
  /** 1-based PDF page, when the chunk came from a PDF. */
  page: number | null;
}

// One document exploded to chunk granularity: what the viewer fetches when a document node
// is expanded. Edges are the chunk -> entity 'mention' edges the graph rollup summarizes.
export interface DocumentChunks {
  chunks: ContextChunk[];
  edges: GraphEdge[];
}

// The four human-in-the-loop resolution actions. All reversible.
export type ResolveDecision =
  | { action: "keep_new" } // supersede: the new memory wins, existing ones go stale
  | { action: "keep_existing"; candidateId: string } // an existing memory wins, the new one goes stale
  | { action: "keep_both" } // mark them distinct; both stay active
  | { action: "merge"; content: string; canonical?: string }; // a reconciled memory supersedes both
