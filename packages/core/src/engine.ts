import type { SchemaInfo } from "./schema.js";
import type {
  AgentMemoryFolderEvent,
  AgentMemoryImportOptions,
  AgentMemoryImportResult,
  Conflict,
  ConflictAutoEvent,
  ConflictAutoResult,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  DocumentChunks,
  Graph,
  ImportCaptureScope,
  ImportOptions,
  ImportResult,
  ImportSessionEvent,
  ImportStatus,
  IndexProgressEvent,
  IndexResult,
  Memory,
  NotionListedPage,
  NotionScope,
  NotionStatus,
  NotionSyncEvent,
  NotionSyncOptions,
  NotionSyncResult,
  RecallOptions,
  RelatedEntities,
  ResolveDecision,
  ResolvedConflict,
  SaveInput,
  SaveResult,
  UpdateInput,
  UpdateResult,
} from "./types.js";

// The engine contract the surfaces (CLI, MCP, viewer) depend on. Both the local Memloom and
// the HttpMemloomClient implement it, so a surface can talk to an in-process engine or a
// running `memloom serve` interchangeably (the single-owner model).
export interface MemoryEngine {
  save(input: SaveInput): Promise<SaveResult>;
  recall(query: string, opts?: RecallOptions): Promise<Memory[]>;
  /** All active memories, newest first: the browse path, where recall is the query path. */
  memories(ownerId?: string): Promise<Memory[]>;
  /** Edit a belief: append a new current version and stale the prior one (explicit, no funnel). */
  update(input: UpdateInput): Promise<UpdateResult>;
  /** The full version chain of a belief, newest first: pass any version's id. */
  history(memoryId: string, ownerId?: string): Promise<Memory[]>;
  /** Delete a belief outright: every version, its edges, and pending conflicts naming it. */
  deleteMemory(memoryId: string, ownerId?: string): Promise<void>;
  /**
   * The complete text of one recall hit (a memory or a context chunk) by its id: the
   * fetch-the-rest path when a recall surface truncated the passage (PASSAGE_CHARS).
   */
  passage(id: string, ownerId?: string): Promise<string | null>;
  /**
   * Import Claude Code sessions as distilled, provenance-carrying memories through the belief
   * pipeline. Bounded by default; idempotent via the per-session ledger. `onProgress` fires
   * after each session completes.
   */
  /** Distill agent session transcripts into memories. Claude Code is the only agent today. */
  importSessions(
    opts?: ImportOptions,
    onProgress?: (event: ImportSessionEvent) => void,
  ): Promise<ImportResult>;
  /**
   * Import memories agents already saved on disk (Claude Code memory folders, Copilot's
   * memory-tool folder) through the belief pipeline. No LLM extraction: the files are
   * distilled memories already. Idempotent via per-memory content-hash ledger rows.
   * `onProgress` fires after each folder completes.
   */
  importAgentMemories(
    opts?: AgentMemoryImportOptions,
    onProgress?: (event: AgentMemoryFolderEvent) => void,
  ): Promise<AgentMemoryImportResult>;
  /** Hook capture state for `memloom status`: scope, last notify, spend, ledger totals. */
  importStatus(): Promise<ImportStatus>;
  /** Set (connect) or clear (disconnect) the hook capture scope. */
  setImportScope(scope: ImportCaptureScope): Promise<void>;
  /** Everything the Notion integration can see, marked with what is selected. */
  notionListPages(): Promise<NotionListedPage[]>;
  /** Set (connect) or clear (disconnect) the Notion sync selection. */
  setNotionScope(scope: NotionScope): Promise<void>;
  /**
   * Sync selected Notion items into context documents: one search call finds what changed,
   * only changed items are fetched. `onProgress` fires after each item.
   */
  notionSync(
    opts?: NotionSyncOptions,
    onProgress?: (event: NotionSyncEvent) => void,
  ): Promise<NotionSyncResult>;
  /** Connector state for `memloom notion status`: token, scope, last sync, doc counts. */
  notionStatus(): Promise<NotionStatus>;
  /** Extract entities from unindexed rows. `onProgress` fires after each item completes. */
  index(ownerId?: string, onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult>;
  /** Wipe all extracted entities/edges and re-run indexing from scratch (recovery path). */
  reindex(ownerId?: string, onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult>;
  graph(ownerId?: string): Promise<Graph>;
  /**
   * The graph neighbourhood of one entity, by id, name, or a folded-away spelling. Null when
   * nothing matches. On the engine contract rather than Memloom-only because the MCP server
   * talks to the daemon over HTTP: this is the surface that answers "who is X connected to".
   */
  relatedEntities(
    target: string,
    opts?: { ownerId?: string; entityType?: string; limit?: number },
  ): Promise<RelatedEntities | null>;
  conflicts(ownerId?: string): Promise<Conflict[]>;
  /** Resolved conflicts, newest first: the revertable history behind the pending queue. */
  resolvedConflicts(ownerId?: string): Promise<ResolvedConflict[]>;
  resolveConflict(conflictId: string, decision: ResolveDecision): Promise<void>;
  revertConflict(conflictId: string): Promise<void>;
  /**
   * LLM pass over pending conflicts with provenance context; decisive verdicts resolve
   * (revertably), "unsure" stays pending for a human.
   */
  autoResolveConflicts(
    ownerId?: string,
    onProgress?: (event: ConflictAutoEvent) => void,
  ): Promise<ConflictAutoResult>;
  /** Ingest (or re-ingest) a file as context: chunk, embed, store. Mirrors; re-add replaces. */
  contextAdd(input: ContextAddInput): Promise<ContextAddResult>;
  contextList(ownerId?: string): Promise<ContextDocument[]>;
  /** One document at chunk granularity: chunks in order + their chunk -> entity edges. */
  contextChunks(documentId: string, ownerId?: string): Promise<DocumentChunks>;
  contextRemove(documentId: string, ownerId?: string): Promise<void>;
  /** The graph vocabulary (entity types, relations, predicates, proposals) with usage counts. */
  describeSchema(ownerId?: string): Promise<SchemaInfo>;
  /** Enable or disable a vocabulary entry (system or user tier); system rows only disable. */
  setSchemaStatus(id: string, status: "active" | "disabled", ownerId?: string): Promise<void>;
  /** Permanently remove a DISABLED user-tier vocabulary entry (system rows only disable). */
  deleteSchemaEntry(id: string, ownerId?: string): Promise<void>;
  /** Background auto-index state; `available` is false when no LLM is configured. */
  getAutoIndex(): Promise<{ enabled: boolean; available: boolean }>;
  /** Turn background auto-indexing on or off (persisted; refused when unavailable). */
  setAutoIndex(enabled: boolean): Promise<void>;
}
