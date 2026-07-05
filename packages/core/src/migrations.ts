// Migrations are TS constants (not .sql files) so they bundle cleanly into the published
// library — no runtime fs/path resolution. Ordered by id; applied once, tracked in
// _memloom_migrations. The schema is DDL + `language sql` only — zero plpgsql (D2), so it
// runs identically on PGLite and real Postgres.

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    sql: /* sql */ `
      CREATE EXTENSION IF NOT EXISTS vector;

      -- The belief store. Every row is one atomic memory.
      -- Sync-ready from day one: stable UUID, created_at/updated_at, owner_id (a fixed
      -- sentinel in the embedded tier) so a future sync layer has what it needs.
      CREATE TABLE IF NOT EXISTS memory_objects (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id      uuid NOT NULL,
        status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale')),
        memory_type   text NOT NULL DEFAULT 'fact',
        canonical     text,
        content       text NOT NULL,
        summary       text,
        content_hash  text,
        embedding     vector(1024),
        metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
        asserted_at   timestamptz NOT NULL DEFAULT now(),
        stale_since   timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        -- Full-text vector maintained by Postgres. 'simple' config: no stemming, so exact
        -- identifiers (file paths, config keys, error codes) match precisely.
        search_tsv    tsvector GENERATED ALWAYS AS (
          to_tsvector('simple',
            coalesce(canonical, '') || ' ' || content || ' ' || coalesce(summary, ''))
        ) STORED
      );

      CREATE INDEX IF NOT EXISTS memory_objects_owner_status_idx
        ON memory_objects (owner_id, status);
      CREATE INDEX IF NOT EXISTS memory_objects_search_tsv_idx
        ON memory_objects USING gin (search_tsv);
      -- No vector index at personal scale: the spike measured ~52ms over 4000 rows on a
      -- sequential cosine scan. A per-tier HNSW/IVFFlat index is added for the server tier.
    `,
  },
];
