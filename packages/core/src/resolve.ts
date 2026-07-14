import type { StorageAdapter } from "./storage.js";

// Low-level, reversible state operations used by conflict resolution. Every action is
// non-destructive: memories go stale (not deleted), edges deactivate (not removed), so a
// decision can always be reverted.

export async function markStale(storage: StorageAdapter, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await storage.query(
      "UPDATE memory_objects SET status = 'stale', stale_since = now(), updated_at = now() WHERE id = $1",
      [id],
    );
  }
}

export async function reactivate(storage: StorageAdapter, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await storage.query(
      "UPDATE memory_objects SET status = 'active', stale_since = NULL, updated_at = now() WHERE id = $1",
      [id],
    );
  }
}

export async function addEdge(
  storage: StorageAdapter,
  ownerId: string,
  fromId: string,
  toId: string,
  relation: string,
): Promise<void> {
  await storage.query(
    "INSERT INTO memory_edges (owner_id, from_id, to_id, relation) VALUES ($1, $2, $3, $4)",
    [ownerId, fromId, toId, relation],
  );
}

/**
 * Insert an edge unless an active one with the same endpoints and relation already exists.
 * Typed entity-to-entity edges need this: many sources can state the same relationship
 * (mention edges can't duplicate: indexed_at gates re-processing and each source has a
 * distinct from_id). Carries the extractor's confidence and the stating source for
 * provenance.
 */
export async function addEdgeIfAbsent(
  storage: StorageAdapter,
  ownerId: string,
  fromId: string,
  toId: string,
  relation: string,
  opts?: { confidence?: number; sourceId?: string },
): Promise<void> {
  const existing = await storage.query<{ id: string }>(
    `SELECT id FROM memory_edges
     WHERE owner_id = $1 AND from_id = $2 AND to_id = $3 AND relation = $4 AND active
     LIMIT 1`,
    [ownerId, fromId, toId, relation],
  );
  if (existing[0]) return;
  await storage.query(
    `INSERT INTO memory_edges (owner_id, from_id, to_id, relation, confidence, source_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ownerId, fromId, toId, relation, opts?.confidence ?? null, opts?.sourceId ?? null],
  );
}

/** Soft-delete edges of a relation that touch any of the given memory ids (from or to). */
export async function deactivateEdgesTouching(
  storage: StorageAdapter,
  ownerId: string,
  relation: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    await storage.query(
      `UPDATE memory_edges SET active = false
       WHERE owner_id = $1 AND relation = $2 AND active = true AND (from_id = $3 OR to_id = $3)`,
      [ownerId, relation, id],
    );
  }
}
