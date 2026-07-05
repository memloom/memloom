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
