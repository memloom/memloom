// The one boundary every data-access path goes through (build-plan architectural rule 1).
// Nothing above this interface knows which driver it talks to. Concrete adapters
// (PgliteAdapter, PgAdapter) implement it; both are real Postgres, so the SQL is identical.

export interface StorageAdapter {
  /** Run a parameterized query and return the rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run raw, possibly multi-statement SQL with no parameters (migrations / DDL). */
  exec(sql: string): Promise<void>;
  /** Run `fn` inside a transaction, passing a transaction-scoped adapter. */
  tx<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
  /** Release the underlying connection and the data-dir lock (embedded tier). */
  close(): Promise<void>;
}
