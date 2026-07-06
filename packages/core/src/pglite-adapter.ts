import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { acquireDataDirLock, type ReleaseLock } from "./lock.js";
import type { StorageAdapter } from "./storage.js";

// Embedded tier: Postgres compiled to WASM, running in-process. One folder on disk (or
// in-memory when no dataDir is given). Loads pgvector. Holds the data-dir lock (D1).

interface PgliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
}

function rowsAdapter(db: PgliteLike): Omit<StorageAdapter, "tx" | "close"> {
  return {
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await db.query(sql, params as unknown[]);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
  };
}

export class PgliteAdapter implements StorageAdapter {
  readonly #db: PGlite;
  readonly #release: ReleaseLock | undefined;

  private constructor(db: PGlite, release: ReleaseLock | undefined) {
    this.#db = db;
    this.#release = release;
  }

  /**
   * Wrap an already-open PGLite instance (no new instance, no lock). Used by the daemon to
   * share one PGLite between the HTTP engine and the Postgres-wire socket. The caller owns the
   * instance's lifecycle and lock.
   */
  static fromInstance(db: PGlite): PgliteAdapter {
    return new PgliteAdapter(db, undefined);
  }

  /** Open an embedded store. Omit `dataDir` for an in-memory database (tests). */
  static async open(opts: { dataDir?: string } = {}): Promise<PgliteAdapter> {
    const release = opts.dataDir ? await acquireDataDirLock(opts.dataDir) : undefined;
    try {
      const db = opts.dataDir
        ? await PGlite.create({ dataDir: opts.dataDir, extensions: { vector } })
        : await PGlite.create({ extensions: { vector } });
      return new PgliteAdapter(db, release);
    } catch (err) {
      if (release) await release();
      throw err;
    }
  }

  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return rowsAdapter(this.#db).query<T>(sql, params);
  }

  exec(sql: string): Promise<void> {
    return rowsAdapter(this.#db).exec(sql);
  }

  async tx<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (t) => {
      const base = rowsAdapter(t as unknown as PgliteLike);
      const txAdapter: StorageAdapter = {
        query: base.query,
        exec: base.exec,
        // No real nesting: run the callback against the same transaction scope.
        tx: (inner) => inner(txAdapter),
        close: async () => {},
      };
      return fn(txAdapter);
    }) as T;
  }

  async close(): Promise<void> {
    await this.#db.close();
    if (this.#release) await this.#release();
  }
}
