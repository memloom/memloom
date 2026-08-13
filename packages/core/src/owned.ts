import type { Memloom } from "./memloom.js";
import type {
  Conflict,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  ContextProgressEvent,
  DeleteOwnerResult,
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

  // resolveConflict() takes no ownerId on the engine: it reads the owner off the conflict row
  // and acts on whoever that is. Correct for a single-owner store, a cross-tenant write here.
  // The check belongs on this side of the seam, where an owner is actually in hand.
  async resolveConflict(
    conflictId: string,
    decision: ResolveDecision,
    provenance: ResolutionProvenance = {},
  ): Promise<void> {
    await this.#assertOwns(conflictId);
    return this.#engine.resolveConflict(conflictId, decision, provenance);
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

  // Both queues, because resolveConflict() serves both: an id it does not find in
  // memory_dedup_decisions it re-dispatches to the entity fold path. Checking only the memory
  // queue would refuse an owner their own entity conflicts — a guard that reads as ownership
  // enforcement while actually removing a feature.
  //
  // Same message whether the conflict belongs to someone else or does not exist: which of the
  // two it is, is itself another tenant's business.
  async #assertOwns(conflictId: string): Promise<void> {
    const [memory, entity] = await Promise.all([
      this.#engine.conflicts(this.ownerId),
      this.#engine.entityConflicts(this.ownerId),
    ]);
    const mine = memory.some((c) => c.id === conflictId) || entity.some((c) => c.id === conflictId);
    if (!mine) {
      throw new Error(`memloom: no conflict ${conflictId}`);
    }
  }
}

export function bindOwner(engine: Memloom, ownerId: string): OwnedMemloom {
  return new BoundMemloom(engine, ownerId);
}
