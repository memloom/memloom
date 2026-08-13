import type { Memloom } from "./memloom.js";
import type {
  Conflict,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  ContextProgressEvent,
  DeleteOwnerResult,
  EntityConflict,
  EntityDetail,
  Graph,
  IndexProgressEvent,
  IndexResult,
  Memory,
  RecallOptions,
  RelatedEntities,
  ResolutionProvenance,
  ResolveDecision,
  SaveInput,
  SaveResult,
  UpdateInput,
  UpdateResult,
} from "./types.js";

// The multi-tenant surface. `Memloom` itself defaults every ownerId to SENTINEL_OWNER, which
// is right for the embedded tier (one human, one store, no argument to pass) and dangerous
// for a host that serves many people: a single forgotten argument reads and writes a SHARED
// owner, with no error, and one user's memories surface in another's session. That is not a
// bug you find in review — every call still compiles and every test still passes.
//
// So a host never calls the engine directly. It calls forOwner(userId) once per request and
// works through the handle, where the owner is bound and there is no argument left to
// forget. The ergonomics are the safety property: the wrong thing is unspellable.

/** Owner-bound arguments: the handle supplies ownerId, so callers cannot pass their own. */
type Unowned<T> = Omit<T, "ownerId">;

/**
 * One tenant's view of the store, with ownerId bound. Obtained from `Memloom.forOwner()`.
 *
 * A deliberate subset of the engine, not a mirror of it: the memory, context and entity
 * operations a host app runs per user. Store-wide machinery (migrations, reconcile settings,
 * embedding fingerprints, the import and sync connectors) stays on the engine, because it
 * belongs to whoever operates the store rather than to any one tenant.
 */
export interface OwnedMemloom {
  /** The owner every call on this handle is scoped to. */
  readonly ownerId: string;

  save(input: Unowned<SaveInput>): Promise<SaveResult>;
  recall(query: string, opts?: Unowned<RecallOptions>): Promise<Memory[]>;
  memories(): Promise<Memory[]>;
  update(input: Unowned<UpdateInput>): Promise<UpdateResult>;
  history(memoryId: string): Promise<Memory[]>;
  passage(id: string): Promise<string | null>;
  deleteMemory(memoryId: string): Promise<void>;

  /** Erase this tenant entirely. See Memloom.deleteOwner(). */
  erase(): Promise<DeleteOwnerResult>;

  index(onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult>;

  conflicts(): Promise<Conflict[]>;
  /**
   * Pending entity folds: two names the indexer thinks are one person or place. A separate
   * queue from conflicts(), but resolveConflict() takes ids from either, so listing both is
   * what makes the ids reachable without going around the handle.
   */
  entityConflicts(): Promise<EntityConflict[]>;
  /** Rejects a conflict id belonging to another owner rather than resolving it. */
  resolveConflict(
    conflictId: string,
    decision: ResolveDecision,
    provenance?: ResolutionProvenance,
  ): Promise<void>;

  graph(): Promise<Graph>;
  listEntities(): Promise<EntityDetail[]>;
  relatedEntities(
    target: string,
    opts?: { entityType?: string; limit?: number },
  ): Promise<RelatedEntities | null>;

  contextAdd(
    input: Unowned<ContextAddInput>,
    onProgress?: (event: ContextProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<ContextAddResult>;
  contextList(): Promise<ContextDocument[]>;
  contextRemove(documentId: string): Promise<void>;
}

class BoundMemloom implements OwnedMemloom {
  readonly ownerId: string;
  readonly #engine: Memloom;

  constructor(engine: Memloom, ownerId: string) {
    this.#engine = engine;
    this.ownerId = ownerId;
  }

  save(input: Unowned<SaveInput>): Promise<SaveResult> {
    return this.#engine.save({ ...input, ownerId: this.ownerId });
  }

  recall(query: string, opts: Unowned<RecallOptions> = {}): Promise<Memory[]> {
    return this.#engine.recall(query, { ...opts, ownerId: this.ownerId });
  }

  memories(): Promise<Memory[]> {
    return this.#engine.memories(this.ownerId);
  }

  update(input: Unowned<UpdateInput>): Promise<UpdateResult> {
    return this.#engine.update({ ...input, ownerId: this.ownerId });
  }

  history(memoryId: string): Promise<Memory[]> {
    return this.#engine.history(memoryId, this.ownerId);
  }

  passage(id: string): Promise<string | null> {
    return this.#engine.passage(id, this.ownerId);
  }

  deleteMemory(memoryId: string): Promise<void> {
    return this.#engine.deleteMemory(memoryId, this.ownerId);
  }

  erase(): Promise<DeleteOwnerResult> {
    return this.#engine.deleteOwner(this.ownerId);
  }

  index(onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult> {
    return this.#engine.index(this.ownerId, onProgress);
  }

  conflicts(): Promise<Conflict[]> {
    return this.#engine.conflicts(this.ownerId);
  }

  entityConflicts(): Promise<EntityConflict[]> {
    return this.#engine.entityConflicts(this.ownerId);
  }

  // The engine's ownerId argument is what makes this safe: without it resolveConflict() reads
  // the owner off the conflict row and acts on whoever that turns out to be, which is right for
  // a single-owner store and a cross-tenant write here.
  resolveConflict(
    conflictId: string,
    decision: ResolveDecision,
    provenance: ResolutionProvenance = {},
  ): Promise<void> {
    return this.#engine.resolveConflict(conflictId, decision, provenance, this.ownerId);
  }

  graph(): Promise<Graph> {
    return this.#engine.graph(this.ownerId);
  }

  listEntities(): Promise<EntityDetail[]> {
    return this.#engine.listEntities(this.ownerId);
  }

  relatedEntities(
    target: string,
    opts: { entityType?: string; limit?: number } = {},
  ): Promise<RelatedEntities | null> {
    return this.#engine.relatedEntities(target, { ...opts, ownerId: this.ownerId });
  }

  contextAdd(
    input: Unowned<ContextAddInput>,
    onProgress?: (event: ContextProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<ContextAddResult> {
    return this.#engine.contextAdd({ ...input, ownerId: this.ownerId }, onProgress, signal);
  }

  contextList(): Promise<ContextDocument[]> {
    return this.#engine.contextList(this.ownerId);
  }

  contextRemove(documentId: string): Promise<void> {
    return this.#engine.contextRemove(documentId, this.ownerId);
  }
}

export function bindOwner(engine: Memloom, ownerId: string): OwnedMemloom {
  return new BoundMemloom(engine, ownerId);
}
