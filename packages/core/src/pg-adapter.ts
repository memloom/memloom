import type * as Pg from "pg";
import type { StorageAdapter } from "./storage.js";

// Server / cloud tier: a real Postgres server over the wire (local Docker, Supabase, or any
// managed Postgres). `pg` is an optional dependency — imported lazily so embedded-only
// installs stay lean. The server must have the pgvector extension available.

export class PgAdapter implements StorageAdapter {
  readonly #client: Pg.Client;

  private constructor(client: Pg.Client) {
    this.#client = client;
  }

  static async connect(connectionString: string): Promise<PgAdapter> {
    let pg: typeof Pg;
    try {
      pg = (await import("pg")).default as unknown as typeof Pg;
    } catch {
      throw new Error(
        "memloom: PgAdapter needs the 'pg' package. Install it with `pnpm add pg` " +
          "(only required for the local-server / cloud tiers; the embedded tier uses PGLite).",
      );
    }
    const client = new pg.Client({ connectionString });
    await client.connect();
    return new PgAdapter(client);
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

  async tx<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    await this.#client.query("BEGIN");
    try {
      const result = await fn(this);
      await this.#client.query("COMMIT");
      return result;
    } catch (err) {
      await this.#client.query("ROLLBACK");
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.#client.end();
  }
}
