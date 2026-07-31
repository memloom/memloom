import type { StorageAdapter } from "./storage.js";

// Test-only helper. Deliberately not exported from index.ts: tsup builds from that entry
// alone, so nothing here ships in the package.
//
// Booting PGLite costs about six seconds; running every migration against it costs half a
// second; the tests themselves cost milliseconds. A suite that opens one store per test
// therefore spends effectively all of its wall clock on Postgres startup. Opening the store
// once per FILE and emptying it between tests keeps each test just as isolated for a fraction
// of the time.
//
// Emptying rather than dropping the schema, because the schema carries the vector extension
// and the migration ledger, and re-creating those would put the six seconds straight back.

/**
 * Empty every table except the migration ledger, so the next test starts on a store that is
 * fresh in every way that matters and already migrated.
 *
 * Table names are discovered rather than listed: a hard-coded list silently stops covering a
 * table the moment someone adds one, and the failure mode is state leaking between tests,
 * which is exactly the bug this exists to prevent.
 *
 * Safe to call before the first migration has run (no tables, nothing to do). `_memloom_meta`
 * IS emptied, which drops the embedding fingerprint; `init()` re-stamps it and is idempotent,
 * so callers reset and then init.
 */
export async function truncateAll(storage: StorageAdapter): Promise<void> {
  // current_schema() rather than a literal 'public': the Postgres factory in testkit.ts runs
  // each store inside its own temp schema on the search path, and a hard-coded 'public' would
  // quietly truncate nothing there while reporting success.
  const tables = await storage.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables
     WHERE schemaname = current_schema() AND tablename <> '_memloom_migrations'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.name}"`).join(", ");
  await storage.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
