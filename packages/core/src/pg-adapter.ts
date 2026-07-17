import type * as Pg from "pg";
import type { StorageAdapter } from "./storage.js";

// Server / cloud tier: a real Postgres server over the wire (local Docker, Supabase, or any
// managed Postgres). `pg` is an optional dependency: imported lazily so embedded-only
// installs stay lean. The server must have the pgvector extension available.
//
// Built on a pool, not a single client: the daemon serves concurrent HTTP requests, and two
// overlapping tx() calls on one shared connection would interleave BEGIN/COMMIT and silently
// mix transactions. Plain query/exec run on any free pooled connection (auto-commit); tx()
// checks out one dedicated connection for the life of the transaction.

class PgTxAdapter implements StorageAdapter {
  readonly #client: Pg.PoolClient;

  constructor(client: Pg.PoolClient) {
    this.#client = client;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const res = await this.#client.query(sql, params as unknown[]);
    return res.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.#client.query(sql);
  }

  // Already inside a transaction: run the callback on the same connection. Core never nests
  // transactions, so no savepoints.
  async tx<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    // The outer tx() owns the connection lifecycle; nothing to close here.
  }
}

export class PgAdapter implements StorageAdapter {
  readonly #pool: Pg.Pool;

  private constructor(pool: Pg.Pool) {
    this.#pool = pool;
  }

  static async connect(connectionString: string): Promise<PgAdapter> {
    let pg: typeof Pg;
    try {
      pg = (await import("pg")).default as unknown as typeof Pg;
    } catch (cause) {
      // Keep the real failure visible: this catch fires for any import error, not only a
      // missing package, and a masked cause sends people installing what they already have.
      throw new Error(
        "memloom: could not load the 'pg' package (needed for the local-server / cloud " +
          "tiers; the embedded tier uses PGLite). If it is not installed: `pnpm add pg`. " +
          `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const pool = new pg.Pool({ connectionString });
    // Fail fast on a bad URL or credentials instead of erroring on the first real query.
    const probe = await pool.connect();
    try {
      await probe.query("SELECT 1");
    } finally {
      probe.release();
    }
    return new PgAdapter(pool);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const res = await this.#pool.query(sql, params as unknown[]);
    return res.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.#pool.query(sql);
  }

  async tx<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await fn(new PgTxAdapter(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
