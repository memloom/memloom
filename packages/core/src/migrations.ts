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
  {
    id: "0002_hybrid_fuse",
    sql: /* sql */ `
      -- Reciprocal-rank fusion over two arms: vector (cosine) and keyword (FTS). Returns the
      -- fused top-K as (id, rrf_score). Pure 'language sql' — no plpgsql (D2), so it runs
      -- identically on PGLite. The entity arm is added in Phase 4. Weights default to the
      -- eval-tuned winner (keyword up-weighted; FTS abstains on lexical misses, so this is
      -- free). Callers that want vector-only pass p_use_keyword => false.
      CREATE OR REPLACE FUNCTION memloom_fuse(
        p_q           text,
        p_emb         vector(1024),
        p_owner       uuid,
        p_limit       int     DEFAULT 10,
        p_pool        int     DEFAULT 50,
        p_k           int     DEFAULT 60,
        p_use_vector  boolean DEFAULT true,
        p_use_keyword boolean DEFAULT true,
        p_w_vector    float   DEFAULT 1.0,
        p_w_keyword   float   DEFAULT 2.0
      )
      RETURNS TABLE (id uuid, rrf_score double precision)
      LANGUAGE sql STABLE AS $fn$
        WITH vec AS (
          SELECT mo.id, row_number() OVER (ORDER BY mo.embedding <=> p_emb) AS rnk
          FROM memory_objects mo
          WHERE p_use_vector
            AND mo.owner_id = p_owner AND mo.status = 'active' AND mo.embedding IS NOT NULL
          ORDER BY mo.embedding <=> p_emb
          LIMIT p_pool
        ),
        kw AS (
          SELECT mo.id, row_number() OVER (
            ORDER BY ts_rank(mo.search_tsv, websearch_to_tsquery('simple', p_q)) DESC
          ) AS rnk
          FROM memory_objects mo
          WHERE p_use_keyword
            AND mo.owner_id = p_owner AND mo.status = 'active'
            AND mo.search_tsv @@ websearch_to_tsquery('simple', p_q)
          LIMIT p_pool
        ),
        fused AS (
          SELECT u.id AS fid, sum(u.w / (p_k + u.rnk)) AS score
          FROM (
            SELECT vec.id, vec.rnk, p_w_vector AS w FROM vec
            UNION ALL
            SELECT kw.id, kw.rnk, p_w_keyword AS w FROM kw
          ) u
          GROUP BY u.id
        )
        SELECT fused.fid, fused.score
        FROM fused
        ORDER BY fused.score DESC
        LIMIT p_limit
      $fn$;
    `,
  },
];
