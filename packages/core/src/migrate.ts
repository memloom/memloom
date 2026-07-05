import { MIGRATIONS } from "./migrations.js";
import type { StorageAdapter } from "./storage.js";

// Idempotent migration runner. Applies any migration not yet recorded, each in its own
// transaction, in id order. Safe to call on every startup.

export async function migrate(storage: StorageAdapter): Promise<void> {
  await storage.exec(
    `CREATE TABLE IF NOT EXISTS _memloom_migrations (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );

  const rows = await storage.query<{ id: string }>("SELECT id FROM _memloom_migrations");
  const applied = new Set(rows.map((r) => r.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await storage.tx(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO _memloom_migrations (id) VALUES ($1)", [migration.id]);
    });
  }
}
