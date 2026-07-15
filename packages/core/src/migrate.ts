import { buildMigrations } from "./migrations.js";
import type { StorageAdapter } from "./storage.js";

// Idempotent migration runner. Applies any migration not yet recorded, each in its own
// transaction, in id order. Safe to call on every startup. `dims` sets the vector(N) column
// width to match the embedding provider.

/**
 * The vector(N) width the store was actually created with, or null on an uninitialized store.
 * pgvector keeps the dimension in atttypmod (no header offset; -1 means unconstrained).
 * Callers that plan to run migrations with a DIFFERENT dims (the reembed CLI) must check this
 * BEFORE migrate(): a pending migration built with new dims against old-width columns would
 * produce mismatched SQL.
 */
export async function storedEmbeddingDims(storage: StorageAdapter): Promise<number | null> {
  const rows = await storage.query<{ dims: number | null }>(
    `SELECT atttypmod AS dims FROM pg_attribute
     WHERE attrelid = to_regclass('memory_objects') AND attname = 'embedding'`,
  );
  const dims = rows[0]?.dims;
  return dims == null || dims === -1 ? null : dims;
}

export async function migrate(storage: StorageAdapter, dims: number): Promise<void> {
  await storage.exec(
    `CREATE TABLE IF NOT EXISTS _memloom_migrations (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );

  const rows = await storage.query<{ id: string }>("SELECT id FROM _memloom_migrations");
  const applied = new Set(rows.map((r) => r.id));

  for (const migration of buildMigrations(dims)) {
    if (applied.has(migration.id)) continue;
    await storage.tx(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO _memloom_migrations (id) VALUES ($1)", [migration.id]);
    });
  }
}
