import { buildMigrations } from "./migrations.js";
import type { StorageAdapter } from "./storage.js";

// Idempotent migration runner. Applies any migration not yet recorded, each in its own
// transaction, in id order. Safe to call on every startup. `dims` sets the vector(N) column
// width to match the embedding provider.

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
