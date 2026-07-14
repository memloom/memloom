import type { SchemaInfo } from "./schema.js";
import type {
  Conflict,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  DocumentChunks,
  Graph,
  IndexProgressEvent,
  IndexResult,
  Memory,
  RecallOptions,
  ResolveDecision,
  SaveInput,
  SaveResult,
  UpdateInput,
  UpdateResult,
} from "./types.js";

// The engine contract the surfaces (CLI, MCP, viewer) depend on. Both the local Memloom and
// the HttpMemloomClient implement it, so a surface can talk to an in-process engine or a
// running `memloom serve` interchangeably (the single-owner model, D1).
export interface MemoryEngine {
  save(input: SaveInput): Promise<SaveResult>;
  recall(query: string, opts?: RecallOptions): Promise<Memory[]>;
  /** All active memories, newest first — browsing, where recall is querying. */
  memories(ownerId?: string): Promise<Memory[]>;
  /** Edit a belief: append a new current version and stale the prior one (explicit, no funnel). */
  update(input: UpdateInput): Promise<UpdateResult>;
  /** The full version chain of a belief, newest first — pass any version's id. */
  history(memoryId: string, ownerId?: string): Promise<Memory[]>;
  /** Extract entities from unindexed rows. `onProgress` fires after each item completes. */
  index(ownerId?: string, onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult>;
  /** Wipe all extracted entities/edges and re-run indexing from scratch (recovery path). */
  reindex(ownerId?: string, onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult>;
  graph(ownerId?: string): Promise<Graph>;
  conflicts(ownerId?: string): Promise<Conflict[]>;
  resolveConflict(conflictId: string, decision: ResolveDecision): Promise<void>;
  revertConflict(conflictId: string): Promise<void>;
  /** Ingest (or re-ingest) a file as context: chunk, embed, store. Mirrors — re-add replaces. */
  contextAdd(input: ContextAddInput): Promise<ContextAddResult>;
  contextList(ownerId?: string): Promise<ContextDocument[]>;
  /** One document at chunk granularity: chunks in order + their chunk -> entity edges. */
  contextChunks(documentId: string, ownerId?: string): Promise<DocumentChunks>;
  contextRemove(documentId: string, ownerId?: string): Promise<void>;
  /** The graph vocabulary (entity types, relations, predicates, proposals) with usage counts. */
  describeSchema(ownerId?: string): Promise<SchemaInfo>;
  /** Permanently remove a DISABLED user-tier vocabulary entry (system rows only disable). */
  deleteSchemaEntry(id: string, ownerId?: string): Promise<void>;
}
