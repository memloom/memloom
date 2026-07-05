// The one boundary every data-access path goes through (build-plan architectural rule 1).
// Nothing above this interface knows which driver it talks to. Concrete adapters
// (PgliteAdapter, PgAdapter) arrive in Phase 1.

export interface StorageAdapter {
  /** Run a parameterized query and return the rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run `fn` inside a transaction, passing a transaction-scoped adapter. */
  tx<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
  /** Release the underlying connection / release the data-dir lock. */
  close(): Promise<void>;
}
