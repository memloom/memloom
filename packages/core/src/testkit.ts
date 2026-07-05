import { randomUUID } from "node:crypto";
import { PgAdapter } from "./pg-adapter.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";

// Test-only helpers (never bundled into the published package — tsup ships only index.ts).
// A StorageFactory yields a fresh, isolated store per call so each test starts clean.

export interface StorageFactory {
  name: string;
  open(): Promise<StorageAdapter>;
}

// PGLite in-memory: every open() is a brand-new empty database. Naturally isolated, no Docker.
export const PgliteFactory: StorageFactory = {
  name: "pglite",
  open: () => PgliteAdapter.open(),
};

// Real Postgres: each open() runs inside a unique temp schema dropped on close, so a shared
// test database stays clean across tests. Gated behind MEMLOOM_TEST_PG_URL.
export function PgAdapterFactory(connectionString: string): StorageFactory {
  return {
    name: "pg",
    open: async () => {
      const base = await PgAdapter.connect(connectionString);
      const schema = `memloom_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await base.exec(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}", public;`);
      const wrapped: StorageAdapter = {
        query: (sql, params) => base.query(sql, params),
        exec: (sql) => base.exec(sql),
        tx: (fn) => base.tx(fn),
        close: async () => {
          await base.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
          await base.close();
        },
      };
      return wrapped;
    },
  };
}
