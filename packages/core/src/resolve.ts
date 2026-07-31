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

/**
 * Timestamps as ISO strings. The drivers hand back Date objects, and a stringified Date carries
 * a zone name ("GMT+0200") that Postgres refuses to parse when the value is fed back in as a
 * parameter. Anything that round-trips a timestamp through SQL goes through here.
 */
export function toIsoTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * markStale, but returning the stale_since each row actually got. Each UPDATE has its own
 * now(), so a caller that needs the written value (reconciliation's revert guard) cannot read it
 * back in a second query without racing a concurrent write. Ids that were not active are
 * absent from the result.
 */
export async function markStaleReturning(
  storage: StorageAdapter,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const staled = new Map<string, string>();
  for (const id of ids) {
    const rows = await storage.query<{ id: string; stale_since: string }>(
      `UPDATE memory_objects SET status = 'stale', stale_since = now(), updated_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING id, stale_since`,
      [id],
    );
    const row = rows[0];
    if (row) staled.set(row.id, toIsoTimestamp(row.stale_since));
  }
  return staled;
}

/**
 * Reactivate a memory only while it is still stale AND its stale_since is the one the caller
 * recorded. Returns false when someone else (a human resolution, a later run) staled it since,
 * so an undo is exact or it is a no-op, never a clobber.
 */
export async function reactivateIfUntouched(
  storage: StorageAdapter,
  id: string,
  staleSince: string,
): Promise<boolean> {
  const rows = await storage.query<{ id: string }>(
    `UPDATE memory_objects SET status = 'active', stale_since = NULL, updated_at = now()
     WHERE id = $1 AND status = 'stale' AND stale_since = $2::timestamptz
     RETURNING id`,
    [id, staleSince],
  );
  return rows.length > 0;
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
): Promise<boolean> {
  const existing = await storage.query<{ id: string }>(
    `SELECT id FROM memory_edges
     WHERE owner_id = $1 AND from_id = $2 AND to_id = $3 AND relation = $4 AND active
     LIMIT 1`,
    [ownerId, fromId, toId, relation],
  );
  if (existing[0]) return false;
  await storage.query(
    `INSERT INTO memory_edges (owner_id, from_id, to_id, relation, confidence, source_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ownerId, fromId, toId, relation, opts?.confidence ?? null, opts?.sourceId ?? null],
  );
  return true;
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
