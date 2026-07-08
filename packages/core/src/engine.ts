import type {
  Conflict,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  DocumentChunks,
  Graph,
  IndexResult,
  Memory,
  RecallOptions,
  ResolveDecision,
  SaveInput,
  SaveResult,
} from "./types.js";

// The engine contract the surfaces (CLI, MCP, viewer) depend on. Both the local Memloom and
// the HttpMemloomClient implement it, so a surface can talk to an in-process engine or a
// running `memloom serve` interchangeably (the single-owner model, D1).
export interface MemoryEngine {
  save(input: SaveInput): Promise<SaveResult>;
  recall(query: string, opts?: RecallOptions): Promise<Memory[]>;
  /** All active memories, newest first — browsing, where recall is querying. */
  memories(ownerId?: string): Promise<Memory[]>;
  index(ownerId?: string): Promise<IndexResult>;
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
}
