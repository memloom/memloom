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
  /**
   * Transcript context, set by the session import: lets a flagged contradiction be judged
   * at save time with evidence the dedup classifier alone lacks. Absent on manual saves,
   * where a human is present and a pending conflict is the right outcome.
   */
  context?: { excerpt: string };
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
  /**
   * Set on "conflict" when transcript context let the resolver settle it at save time.
   * The resolution is applied and revertable; the conflict never waits in the queue.
   */
  autoResolution?: "keep_new" | "keep_existing" | "keep_both";
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
  /**
   * Cosine to the incoming belief, for ordering the queue. A similarity, not a confidence:
   * nothing records how sure the classifier was. Null when either side has no vector.
   */
  similarity?: number | null;
}

export interface Conflict {
  id: string;
  createdAt: string;
  incoming: { id: string; canonical: string | null; content: string };
  candidates: ConflictCandidate[];
}

/** A resolved conflict from the decision log: the revertable history behind the pending queue. */
export interface ResolvedConflict extends Conflict {
  resolution: "keep_new" | "keep_existing" | "keep_both" | "merge";
  resolvedAt: string;
  /** Who decided. 'human' on everything settled before the provenance columns existed. */
  decidedBy: "auto" | "llm" | "human";
  /** Which model, when decidedBy is 'llm'. */
  model: string | null;
  /** The decider's own words, when it left any. */
  reason: string | null;
}

/** An entity pair a decision settled as two different things, with why. */
export interface SettledEntityPair {
  id: string;
  incomingName: string;
  candidateName: string;
  decidedBy: "auto" | "llm" | "human";
  model: string | null;
  reason: string | null;
  resolvedAt: string;
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
  /** Folded-in spellings that still resolve here. Empty for an entity nothing merged into. */
  aliases: string[];
}

/**
 * One reversible fold: the record that a variant spelling was absorbed into a canonical
 * entity. The absorbed row is gone from memory_entities but fully recoverable from here.
 */
export interface EntityMerge {
  id: string;
  canonicalId: string;
  canonicalName: string;
  /** The absorbed entity's original id, restored verbatim on revert. */
  sourceId: string;
  sourceName: string;
  sourceType: string;
  decidedBy: "auto" | "llm" | "human";
  score: number | null;
  reason: string | null;
  /** Which model decided, when decidedBy is 'llm'. Null for every other kind of fold. */
  model: string | null;
  createdAt: string;
  revertedAt: string | null;
}

/** A candidate canonical an uncertain fold could go to. */
export interface EntityConflictCandidate {
  id: string;
  name: string;
  entityType: string;
  mentions: number;
  score: number;
  reason: string;
}

/**
 * An uncertain fold awaiting arbitration. Lives in the same memory_dedup_decisions table
 * with the same revert semantics as a memory conflict, under action = 'entity_merge'; it is
 * read separately because its shape is entity-shaped, not memory-shaped.
 */
export interface EntityConflict {
  id: string;
  createdAt: string;
  incoming: { id: string; name: string; entityType: string; mentions: number };
  candidates: EntityConflictCandidate[];
}

/** What one resolution pass over the entity table did. */
export interface EntityResolutionResult {
  /** Entities considered. */
  examined: number;
  /** Pairs that survived blocking and were judged. */
  pairs: number;
  /** Folds applied without asking (deterministic orthographic matches). */
  merged: number;
  /** Uncertain folds written to the conflicts surface. */
  queued: number;
  /**
   * Uncertain folds not written because the queue is already as deep as it is allowed to
   * get. They are the lowest-impact ones (fewest mentions on the weaker side) and a later
   * pass picks them up as waiting questions get answered. Reported rather than dropped
   * silently, so "nothing queued" never hides "there was more to ask about".
   */
  deferred: number;
  /** Pairs skipped because they were already merged, queued, or settled as distinct. */
  skipped: number;
  /**
   * The memory_entity_merges rows this pass created, in order. Empty on a dry run. A caller that
   * has to be able to undo its own pass (reconciliation) needs the ids, and reading them back by
   * timestamp afterwards would race with a concurrent fold.
   */
  mergeIds: string[];
}

/** One stated relationship between two entities, as seen from the entity being asked about. */
export interface EntityLink {
  /** The predicate the extractor recorded ("works_on", "uses", "part_of"). */
  relation: string;
  /** "out" when the asked-about entity is the subject, "in" when it is the object. */
  direction: "out" | "in";
  confidence: number | null;
}

/** One entity connected to the entity being asked about, and how. */
export interface RelatedEntity extends Entity {
  /** Total active mention edges pointing at this entity, for weighing how central it is. */
  mentions: number;
  /** Folded-in spellings that resolve here. */
  aliases: string[];
  /**
   * Stated relationships between the two, if the extractor recorded any. Empty means the
   * connection is co-mention only: they turn up in the same memories without the graph ever
   * having asserted how they relate.
   */
  links: EntityLink[];
  /** Distinct sources (memories and chunks) that mention both. */
  sharedSources: number;
}

/**
 * The neighbourhood of one entity. Answers "who is connected to X", where X may be given by
 * id, by name, or by a folded-away spelling: an alias resolves to its canonical, and
 * `matchedAlias` says so, because being told "Bob is Robert" is part of the answer.
 */
export interface RelatedEntities {
  entity: EntityDetail;
  /** The spelling asked for, when it was an alias rather than the canonical name. */
  matchedAlias: string | null;
  related: RelatedEntity[];
  /** Neighbours beyond `limit`, so a truncated answer never reads as a complete one. */
  truncated: number;
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

/**
 * One step of a slow context ingest, streamed as NDJSON while `context add` runs.
 * Only extractors that take minutes emit these; a markdown file streams nothing.
 */
export interface ContextProgressEvent {
  /** The file being ingested, so a batch of several stays legible. */
  path: string;
  /** For media: "decoding" | "transcribing" | "checking" | "repairing". */
  stage: string;
  /** 1-based position within the stage; 0 when the stage has no countable units. */
  done: number;
  total: number;
  /** How far into the recording this step reached. */
  seconds: number;
  audioSeconds: number;
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

// ---- Re-embedding (the offline provider-switch migration; `memloom reembed`) ----

/** One page of rows re-embedded: the progress signal for the CLI's per-table counters. */
export interface ReembedProgressEvent {
  table: "memories" | "entities" | "chunks" | "messages";
  /** Rows embedded so far in this table during this run. */
  done: number;
  /** Rows pending in this table when the run started. */
  total: number;
}

export interface ReembedOptions {
  /** Re-embed even when the fingerprint already matches and nothing is missing. */
  force?: boolean;
  onProgress?: (event: ReembedProgressEvent) => void;
}

export interface ReembedResult {
  outcome: "reembedded" | "up-to-date";
  /** Fingerprint the store was stamped with before this run (null on a never-stamped store). */
  previousFingerprint: string | null;
  /** The current provider's fingerprint; what the store is stamped with afterwards. */
  fingerprint: string;
  counts: { memories: number; entities: number; chunks: number; messages: number };
}

// ---- Assistant chat (the viewer's assistant tab) ----

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

export interface ContextAddUrlInput {
  /** http(s) URL. Stored normalized (tracking params and fragment stripped) as the path. */
  url: string;
  /**
   * Rendered HTML from a caller that already loaded the page, so the daemon skips the
   * fetch. This is how a browser extension saves a single-page app or a page behind a
   * login: the DOM it hands over is the one the user was looking at.
   */
  html?: string;
  ownerId?: string;
}

/**
 * "converted": an upload:// snapshot became this linked document (a link is the stronger
 * identity: it can refresh from disk). "exists": an upload was skipped because the same
 * content, or a linked file with the same name, is already in the store.
 */
export type ContextAddOutcome = "added" | "updated" | "unchanged" | "converted" | "exists";

export interface ContextAddResult {
  documentId: string;
  outcome: ContextAddOutcome;
  title: string;
  chunks: number;
  /** Where the document lives: set for "converted" (the new real path) and "exists" (the existing doc's path). */
  path?: string;
  /** "converted" only: false when the snapshot's content matched, so chunks and their indexed entities were kept. */
  rechunked?: boolean;
  /** Duplicate upload snapshots deleted while processing this link. */
  absorbed?: number;
}

/**
 * One voice diarization found in a recording. Stored as jsonb on the document row, because
 * a roster is per-recording metadata, not content: renaming a speaker must not look like
 * the file changed.
 */
export interface DocumentSpeaker {
  /** 1-based, ordered by first appearance: the first voice heard is speaker 1. */
  id: number;
  /** The generated transcript label, "Speaker 1". Never changes once stored. */
  label: string;
  /** What the user named this voice; null until they do. */
  name: string | null;
  /** Total talk time in seconds, so a UI can put the host before a one-line guest. */
  seconds: number;
  /** A clean stretch of this voice alone, for "play a sample" in a labeling UI. */
  sampleStart: number;
  sampleEnd: number;
  /**
   * L2-normalized voice embedding from this recording's clearest segment. Stored now so a
   * future voice library can match "is this Alice again?" across recordings without
   * re-running diarization. Null when embedding extraction failed.
   */
  embedding: number[] | null;
}

/** The roster plus what produced it: embeddings from different models never compare. */
export interface SpeakerRoster {
  version: 1;
  /** Which embedding model the vectors came from, e.g. "wespeaker-en-voxceleb-resnet34-lm". */
  embeddingModel: string;
  speakers: DocumentSpeaker[];
}

export interface ContextDocument {
  id: string;
  path: string;
  title: string;
  kind: string;
  chunkCount: number;
  updatedAt: string;
  /** Present on diarized recordings; absent on text documents and pre-diarization ingests. */
  speakers?: SpeakerRoster | null;
  /**
   * Keep this document current as the file changes. On by default, but only meaningful when
   * `watchable` is true: an upload or a web page has no file to watch, and the column carries
   * its default on those rows rather than a considered answer.
   */
  watching?: boolean;
  /** There is a file on disk behind this document, so watching it means something. */
  watchable?: boolean;
  /** When the file stopped being findable on disk. The chunks stay either way. */
  missingAt?: string | null;
}

// ---- Watched roots (the folders a person linked, as opposed to the files inside them) ----

/**
 * A folder someone linked. Adding a folder creates one document per file in it and would
 * otherwise forget the folder itself, which is the only record that files arriving LATER were
 * asked for too.
 */
export interface ContextRoot {
  id: string;
  path: string;
  watching: boolean;
  /** Documents in the store whose path sits under this root, right now. */
  documents: number;
  /** The catch-up watermark: a rescan only looks at entries touched since this. */
  lastScanAt: string | null;
  createdAt: string;
}

/** Everything the watcher has an eye on: linked folders, plus files linked on their own. */
export interface SyncTargets {
  roots: ContextRoot[];
  /**
   * `updatedAt` is a file's own catch-up watermark, the equivalent of a root's lastScanAt. A
   * file modified while the daemon was down fires no event, so without something to compare
   * its mtime against there is nothing that would ever notice the edit.
   */
  files: { id: string; path: string; updatedAt: string }[];
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

// ---- Session import (`memloom import sessions`) ----

export interface ImportOptions {
  /**
   * Which agent's sessions to import. Claude Code is the only supported agent today and
   * the default; the option exists so `import sessions --agent codex` can slot in without
   * a rename.
   */
  agent?: "claude-code";
  /** Sessions modified in the last N days. Default 14. */
  days?: number;
  /** Newest-first cap after the day window. Default 20. */
  maxSessions?: number;
  /** Case-insensitive substring match on the encoded project directory name. */
  project?: string;
  /** Allowlist form of `project`: a session matches when ANY entry matches. Hook and sweep. */
  projects?: string[];
  /**
   * Explicit session files instead of discovery (the hook's just-ended transcript). Bypasses
   * the day window, the cap, and the quiet check: a session-end signal is definitive.
   */
  paths?: string[];
  /**
   * An unattended run (hook, sweep): enforce the per-day distillation call budget so capture
   * can never silently burn credits. Attended CLI runs are uncapped; the user is watching.
   */
  unattended?: boolean;
  /** Discover, parse, chunk, and count only: zero LLM calls, zero writes, ledger untouched. */
  dryRun?: boolean;
  /** Ignore ledger watermarks and reprocess every discovered session from line zero. */
  force?: boolean;
  /** Override ~/.claude/projects (tests). */
  root?: string;
  ownerId?: string;
}

/** The hook capture scope: named project-dir substrings, everything, or not configured. */
export type ImportCaptureScope = { projects: string[] } | "all" | null;

/** What `memloom status` renders: capture config, last hook activity, and today's spend. */
export interface ImportStatus {
  scope: ImportCaptureScope;
  /** ISO time the daemon last received a session-end notify; null = never. */
  lastNotifyAt: string | null;
  /** The last notify's failure ("no LLM provider configured", a 402, ...); null = clean. */
  lastNotifyError: string | null;
  /** Unattended distillation calls spent today, against the cap. */
  todayUnattendedCalls: number;
  unattendedDailyCap: number;
  /** Ledger totals: sessions ever imported and memories they saved. */
  sessionsImported: number;
  memoriesSaved: number;
}

/** One session finished during an import run: the per-session progress line. */
export interface ImportSessionEvent {
  path: string;
  project: string;
  sessionId: string;
  /** 1-based position in this run. */
  index: number;
  total: number;
  /**
   * "distilling": the session's chunks are about to be processed (emitted before the LLM
   * work so long sessions show progress instead of silence). "partial": a provider failure
   * stopped this session mid-way; processed chunks are saved.
   */
  outcome: "imported" | "up-to-date" | "dry-run" | "partial" | "distilling";
  /** Set on "partial": the provider error that stopped the session (and the run). */
  error?: string;
  /** Set on "distilling": the 1-based chunk now being processed (of `chunks`). */
  chunk?: number;
  chunks: number;
  saved: number;
  merged: number;
  versioned: number;
  conflicts: number;
  /** Contradictions the resolver settled at save time using transcript context (revertable). */
  autoResolved: number;
  /** Distillation reply items dropped as untypeable. */
  dropped: number;
  truncated: number;
  redactions: number;
  malformed: number;
}

export interface ImportResult {
  /** Sessions processed (or planned, on a dry run). */
  sessions: number;
  skipped: {
    sidecars: number;
    active: number;
    outsideWindow: number;
    overCap: number;
    /** Already fully processed per the ledger (watermark at end of file, prefix intact). */
    upToDate: number;
  };
  saved: number;
  merged: number;
  versioned: number;
  conflicts: number;
  /** Contradictions the resolver settled at save time using transcript context (revertable). */
  autoResolved: number;
  dropped: number;
  truncated: number;
  redactions: number;
  malformed: number;
  /** The cost line: what this run actually spent. All zero on a dry run. */
  calls: { extraction: number; embedding: number; classifier: number };
  dryRun: boolean;
  /**
   * Set when a provider failure stopped the run early. Everything distilled and saved before
   * the failure is kept and watermarked, so a re-run resumes instead of re-spending.
   */
  error?: string;
}

// ---- Agent memory import (`memloom import agent-memory`) ----

export interface AgentMemoryImportOptions {
  /** Which agents to read. Default: all supported ("claude-code", "copilot"). */
  agents?: string[];
  /** Case-insensitive substring match on the Claude Code project directory name. */
  project?: string;
  /** Parse and count only: zero provider calls, zero writes, ledger untouched. */
  dryRun?: boolean;
  /** Ignore the ledger's unchanged check and reprocess every memory file. */
  force?: boolean;
  /** Override ~/.claude/projects (tests). */
  claudeRoot?: string;
  /** Override the per-OS Copilot candidates (tests). */
  copilotRoots?: string[];
  ownerId?: string;
}

/** One memory folder finished during an agent-memory import run: the progress line. */
export interface AgentMemoryFolderEvent {
  agent: string;
  /** Claude Code: the project directory name; Copilot: "global". */
  label: string;
  path: string;
  /** 1-based position in this run. */
  index: number;
  total: number;
  outcome: "imported" | "up-to-date" | "dry-run" | "partial";
  /** Set on "partial": the provider error that stopped the folder (and the run). */
  error?: string;
  /** Markdown files read (the MEMORY.md index is not counted). */
  files: number;
  /** Memories parsed out of those files. */
  memories: number;
  /** Memories skipped because their ledger hash is unchanged since the last run. */
  unchanged: number;
  saved: number;
  merged: number;
  versioned: number;
  conflicts: number;
  redactions: number;
}

export interface AgentMemoryImportResult {
  /** Folders processed (or planned, on a dry run). */
  folders: number;
  files: number;
  memories: number;
  unchanged: number;
  saved: number;
  merged: number;
  versioned: number;
  conflicts: number;
  redactions: number;
  /** The cost line. Agent memories are already distilled: no extraction calls, ever. */
  calls: { embedding: number; classifier: number };
  dryRun: boolean;
  /**
   * Set when a provider failure stopped the run early. Everything saved before the failure
   * is kept and ledgered, so a re-run resumes instead of re-spending.
   */
  error?: string;
}

// The four human-in-the-loop resolution actions. All reversible.
/** Progress from the conflict auto-resolver: one event per examined conflict. */
export interface ConflictAutoEvent {
  conflictId: string;
  /** 1-based position in this pass. */
  index: number;
  total: number;
  verdict: "keep_new" | "keep_existing" | "keep_both" | "unsure";
  reason: string;
  /** Leading snippet of the incoming memory, for display. */
  content: string;
}

export interface ConflictAutoResult {
  examined: number;
  /** Conflicts a decisive verdict resolved (sum of the three buckets below). */
  resolved: number;
  keepNew: number;
  keepExisting: number;
  keepBoth: number;
  /** Left pending for a human. */
  unsure: number;
}

/**
 * Progress from the entity arbiter: one event per pair the model was asked about. The same
 * shape as ConflictAutoEvent, because both are one paid call per queued item and the wait is
 * the same wait: a run of fifty is a minute of nothing without it.
 */
export interface EntityAutoEvent {
  conflictId: string;
  /** 1-based position in this pass. */
  index: number;
  total: number;
  verdict: "same" | "distinct" | "unsure";
  reason: string;
  /** The two names, for display. */
  pair: string;
}

/**
 * Who settled a conflict and why. Recorded on the decision row itself, which is the only place
 * a verdict that changed nothing ("these are different things") can be read back from.
 */
export interface ResolutionProvenance {
  decidedBy?: "auto" | "llm" | "human";
  /** Which model, when decidedBy is 'llm'. */
  model?: string;
  score?: number;
  /** The decider's own words. */
  reason?: string;
}

export type ResolveDecision =
  | { action: "keep_new" } // supersede: the new memory wins, existing ones go stale
  | { action: "keep_existing"; candidateId: string } // an existing memory wins, the new one goes stale
  | { action: "keep_both" } // mark them distinct; both stay active
  | { action: "merge"; content: string; canonical?: string }; // a reconciled memory supersedes both

/** One Notion item the integration can see (a page or a database's data source). */
export interface NotionItemRef {
  id: string;
  object: "page" | "data_source";
  title: string;
}

/** The pages and data sources the user selected for sync; null = connector off. */
export type NotionScope = { items: NotionItemRef[] } | null;

/** One row of `notion connect`'s listing: visible item plus whether it is selected. */
export interface NotionListedPage extends NotionItemRef {
  lastEdited: string;
  url: string | null;
  selected: boolean;
  /**
   * The listed item this one lives under, when that item is also in the listing:
   * a subpage's parent page, a database's containing page, a row-page's data source.
   * null for top-level items and for parents the integration cannot see.
   */
  parentId: string | null;
  /** What kind of listed item parentId points at; "data_source" marks a database row. */
  parentType: "page" | "data_source" | null;
}

export interface NotionSyncOptions {
  /** Refetch every selected item, ignoring last_edited_time watermarks. */
  force?: boolean;
  /** List what would sync without fetching content or writing anything. */
  dryRun?: boolean;
  /**
   * If a sync is already running (usually the daemon's poll), wait for it and then run
   * this one, instead of refusing. The CLI passes this; the poll never does.
   */
  wait?: boolean;
  ownerId?: string;
}

/** Per-item progress during a sync run. */
export interface NotionSyncEvent {
  id: string;
  title: string;
  object: "page" | "data_source";
  index: number;
  total: number;
  /**
   * "waiting": another sync holds the lock; this run starts when it finishes (id and
   * title are empty on this one event). "fetching": progress while a changed item's
   * content downloads (Notion allows about 3 requests/second, so long pages emit
   * several); `chunks` carries blocks so far. "fresh": last_edited_time unchanged,
   * content not fetched. "unchanged": fetched but the content hash matched, chunks
   * kept. "would-sync": dry run only.
   */
  outcome:
    | "waiting"
    | "fetching"
    | "added"
    | "updated"
    | "unchanged"
    | "fresh"
    | "would-sync"
    | "error";
  chunks: number;
  error?: string;
  /** The page hit the per-page block cap: its newest blocks were NOT synced. */
  truncated?: boolean;
  /**
   * Incremental fetch: only `refetched` of the page's `sections` top-level sections had
   * edits and were re-downloaded; the rest came from the cached block tree. Absent on
   * full fetches (first sync, --force, or the nothing-localized fallback).
   */
  sections?: number;
  refetched?: number;
}

export interface NotionSyncResult {
  items: number;
  added: number;
  updated: number;
  unchanged: number;
  fresh: number;
  errors: number;
  /** Items that hit the per-page block cap; their tail was not synced. */
  truncated: number;
  dryRun: boolean;
  /** The last item error, when any item failed; the run continues past item failures. */
  error?: string;
}

export interface NotionStatus {
  /** Whether NOTION_TOKEN is set in the daemon's environment. */
  tokenPresent: boolean;
  /** A sync run (manual or the poll) is executing right now. */
  syncing: boolean;
  scope: NotionScope;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  /** Synced notion:// documents currently in the store, and their chunk total. */
  documents: number;
  chunks: number;
}

// Reconciliation: the consolidation pass. A pass acts unasked when SQL proves the store is wrong
// and the ledger can undo it, and asks first whenever it would spend money. Every run is one
// revertable unit recorded in memory_reconcile_runs / memory_reconcile_actions.

export type ReconcileMode = "dry_run" | "apply";
export type ReconcileTrigger = "manual" | "idle" | "startup";
export type ReconcileRunStatus = "running" | "success" | "error" | "aborted";
/**
 * retire and fold change state; question and conflict ask the human.
 *
 * 'possible' is a contradiction the re-check found and nobody has confirmed. It is not a conflict
 * on purpose: the pass runs at roughly 40 percent precision, so these wait in the ledger where
 * dismissing one costs a click, and approving one is what writes the real conflict row.
 */
export type ReconcileActionKind = "retire" | "question" | "conflict" | "fold" | "possible";
export type ReconcileDecision = "approved" | "rejected" | "snoozed";

/**
 * The five passes, in cost order. The first two are free and act on their own; the rest spend
 * money and stay off until the user turns them on.
 */
export type ReconcilePass =
  | "invariants"
  | "entities"
  | "llm_entities"
  | "llm_conflicts"
  | "llm_recheck";

export const RECONCILE_PASSES: readonly ReconcilePass[] = [
  "invariants",
  "entities",
  "llm_entities",
  "llm_conflicts",
  "llm_recheck",
];

/** Passes that cost nothing and therefore need no permission and no scheduling argument. */
export const FREE_RECONCILE_PASSES: readonly ReconcilePass[] = ["invariants", "entities"];

export type ReconcileSettings = Record<ReconcilePass, boolean> & {
  /** Run on daemon startup when the last run is older than the catch-up window. */
  startupCatchUp: boolean;
};

export interface ReconcileAction {
  id: string;
  runId: string;
  kind: ReconcileActionKind;
  /** The detector that produced it: 'duplicate_content', 'multi_head', ... */
  class: string;
  memoryId: string | null;
  reason: string;
  /** True only when a run in 'apply' mode actually changed this memory's status. */
  applied: boolean;
  /** The stale_since this run wrote. revertReconcile restores only while it is unchanged. */
  staledAt: string | null;
  /** False when the finding was recorded but held back by a per-run cap. */
  surfaced: boolean;
  decision: ReconcileDecision | null;
  /** Set when kind is 'fold': the memory_entity_merges row revertReconcile undoes. */
  mergeId: string | null;
  /** Set when kind is 'conflict': the queue row this finding became, so a surface can link it. */
  conflictId: string | null;
  /** Set when kind is 'possible': the older belief of the pair. memoryId holds the newer one. */
  candidateId: string | null;
  createdAt: string;
}

/**
 * One unconfirmed contradiction, with the spans that make it readable without opening either
 * memory. The quotes were verified against the two contents before this row was written, so they
 * are guaranteed to occur in them.
 */
export interface PossibleContradiction {
  /** The reconcile action id. Answering quotes this back. */
  id: string;
  runId: string;
  newMemory: { id: string; content: string };
  oldMemory: { id: string; content: string };
  /** Verbatim spans from newMemory.content and oldMemory.content. */
  newQuote: string;
  oldQuote: string;
  /** The model's own words, kept short by the prompt. */
  reason: string;
  model: string | null;
  /** Cosine between the two beliefs. The same ordering signal the conflict queue uses. */
  similarity: number | null;
  foundAt: string;
}

/** What answering a possible contradiction did. */
export interface PossibleAnswer {
  /** Set when the answer was 'approved': the conflict row it became. */
  conflictId: string | null;
  decision: ReconcileDecision;
}

export interface ReconcileRun {
  id: string;
  mode: ReconcileMode;
  trigger: ReconcileTrigger;
  status: ReconcileRunStatus;
  scanned: number;
  retired: number;
  /** Entities folded into another. Reversed through revertEntityMerge, not through markStale. */
  folded: number;
  questions: number;
  conflictsRaised: number;
  /** Unconfirmed contradictions the re-check recorded. Not conflicts until a human says so. */
  possible: number;
  llmCalls: number;
  /** What this run actually cost, written per call so it survives a crash. */
  spentUsd: number;
  spentInputTokens: number;
  spentOutputTokens: number;
  /** Set when the run failed: the message, so a surface can say why without guessing. */
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  revertedAt: string | null;
}

/**
 * What the contradiction re-check WOULD cost. A dry run never spends it: the window is counted
 * and priced, not judged. Tokens are derived from the real dedup prompt template and the actual
 * content lengths in the window; `usd` is null unless a price for `model` is known.
 */
export interface ReconcileEstimate {
  /** Active memories in the re-check window (saved since the last successful run). */
  window: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  usd: number | null;
}

export interface ReconcileOptions {
  mode?: ReconcileMode;
  trigger?: ReconcileTrigger;
  ownerId?: string;
  /**
   * Which passes to run. Defaults to the user's saved settings. A trigger that must stay free
   * (startup, idle) passes FREE_RECONCILE_PASSES explicitly rather than trusting the settings.
   */
  passes?: readonly ReconcilePass[];
  /**
   * Keep re-checking past the per-run ceiling until nothing is due or this much has been billed.
   * Omitted means one page and stop, which is the default cost ceiling.
   */
  budgetUsd?: number | null;
}

/** What the model made of the uncertain entity pairs, when pass 3 ran. */
export interface ReconcileArbitration {
  /** Pairs sent to the model. One call each; the queue's own limit is the ceiling. */
  calls: number;
  folded: number;
  /** Pairs the model said are different things. Recorded, so it is never asked again. */
  rejected: number;
  /** Left pending for a human: the model said unsure, or gave no usable answer. */
  unsure: number;
  settled: Array<{ conflictId: string; class: string; reason: string }>;
}

/**
 * One belief checked by the contradiction re-check, emitted as it happens.
 *
 * A sweep is one model call per belief and can run for minutes, so the run has to say where it is
 * rather than going quiet until the end. Only the re-check emits: the other passes finish in
 * seconds and have nothing to report along the way.
 */
export interface ReconcileProgressEvent {
  runId: string;
  pass: ReconcilePass;
  /** 1-based position in this run's sweep. */
  checked: number;
  /** Beliefs this run will check. Known up front, unlike a poll of the run row. */
  total: number;
  /** Possible contradictions recorded so far. */
  found: number;
  /** Billed so far on this run, from the provider's own figures. */
  spentUsd: number;
}

export interface ReconcileReport {
  run: ReconcileRun;
  /** Every finding, surfaced or held back by a cap. */
  actions: ReconcileAction[];
  estimate: ReconcileEstimate;
  /** Findings recorded but not shown, by kind, because a per-run cap was reached. */
  heldBack: { retire: number; question: number; conflict: number };
  /** Which passes actually ran, after settings and mode were applied. */
  passes: ReconcilePass[];
  /** Deterministic entity resolution, present when the 'entities' pass ran. */
  entities?: EntityResolutionResult;
  /** Model arbitration of uncertain entity pairs, present when the 'llm_entities' pass ran. */
  arbitration?: ReconcileArbitration;
  /** The existing conflict auto-resolver, present when the 'llm_conflicts' pass ran. */
  autoResolved?: ConflictAutoResult;
  /** The contradiction re-check, present when the 'llm_recheck' pass ran. */
  recheck?: ReconcileRecheckResult;
}

/**
 * What the contradiction re-check did. `claimed` against `verified` is the honest measure of how
 * much the model asserted versus how much it could back with quotes from both memories.
 */
export interface ReconcileRecheckResult {
  /** Beliefs that were due when the run started. */
  window: number;
  /** One per belief actually judged. The only number that costs money. */
  calls: number;
  /** Contradictions the model asserted. */
  claimed: number;
  /** Of those, the ones whose quotes were found in both memories. Only these are recorded. */
  verified: number;
  /** Beliefs still due when the run stopped. */
  remaining: number;
  /** What the run actually cost, from the provider's own billed figures. */
  spentUsd: number;
  spentInputTokens: number;
  spentOutputTokens: number;
  /**
   * Why it stopped short. 'cap' is the per-run ceiling with no budget set, 'budget' is the spend
   * limit, 'aborted' is a stop, 'unpriced' means a budget was set but the provider reported no
   * cost so the run refused to page blind, and 'failed' means every call in a page failed. null
   * means nothing is due any more.
   */
  stoppedBy: "budget" | "aborted" | "cap" | "unpriced" | "failed" | null;
}

export interface ReconcileRevertResult {
  runId: string;
  /** Memories returned to 'active'. */
  restored: number;
  /** Entity folds undone through revertEntityMerge. */
  unfolded: number;
  /** Actions left alone because the store moved on after the run. */
  skipped: number;
}
