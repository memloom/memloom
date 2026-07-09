// Migrations are TS constants (not .sql files) so they bundle cleanly into the published
// library — no runtime fs/path resolution. Ordered by id; applied once, tracked in
// _memloom_migrations. The schema is DDL + `language sql` only — zero plpgsql (D2), so it
// runs identically on PGLite and real Postgres.

export interface Migration {
  id: string;
  sql: string;
}

// Migrations are parameterized by embedding dimension so the vector(N) columns always match
// the provider's output (qwen3-embedding-8b = 4096, OpenAI small = 1536, the test provider =
// 1024). The dimension is fixed per store at init; changing models means re-embedding.
export function buildMigrations(dims: number): Migration[] {
  return [
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
        embedding     vector(${dims}),
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
        p_emb         vector(${dims}),
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
    {
      id: "0003_beliefs",
      sql: /* sql */ `
      -- Typed relationships between memories. 'replaces' (supersession), 'distinct' (kept
      -- both on purpose), plus 'mention' etc. later. active=false soft-deletes an edge so a
      -- conflict decision can be reverted.
      CREATE TABLE IF NOT EXISTS memory_edges (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id   uuid NOT NULL,
        from_id    uuid NOT NULL,
        to_id      uuid NOT NULL,
        relation   text NOT NULL,
        active     boolean NOT NULL DEFAULT true,
        metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS memory_edges_from_idx ON memory_edges (from_id) WHERE active;
      CREATE INDEX IF NOT EXISTS memory_edges_to_idx ON memory_edges (to_id) WHERE active;

      -- The conflict log + human-in-the-loop resolution record. A contradiction keeps both
      -- memories active and writes one row here (resolution_action NULL = pending). The owner
      -- resolves it; every resolution is reversible (revert nulls the resolution fields and
      -- restores state).
      CREATE TABLE IF NOT EXISTS memory_dedup_decisions (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id             uuid NOT NULL,
        action               text NOT NULL,              -- 'conflict'
        incoming_id          uuid,
        incoming_canonical   text,
        incoming_content     text,
        candidates           jsonb NOT NULL DEFAULT '[]'::jsonb,
        resolution_action    text,                       -- 'supersede' | 'keep_both' | 'merge'
        resolution_winner_id uuid,
        resolution_loser_ids jsonb,                      -- array of memory ids
        resolved_at          timestamptz,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS memory_dedup_unresolved_idx
        ON memory_dedup_decisions (owner_id, created_at DESC)
        WHERE action = 'conflict' AND resolution_action IS NULL;
    `,
    },
    {
      id: "0004_entities",
      sql: /* sql */ `
      -- Entities the indexer extracts from memories. Resolved by (owner, name, type) so the
      -- same entity is one row; memories link to it via a 'mention' edge in memory_edges.
      CREATE TABLE IF NOT EXISTS memory_entities (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id    uuid NOT NULL,
        name        text NOT NULL,
        entity_type text NOT NULL DEFAULT 'thing',
        embedding   vector(${dims}),
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS memory_entities_owner_idx ON memory_entities (owner_id);
      CREATE UNIQUE INDEX IF NOT EXISTS memory_entities_owner_name_type_idx
        ON memory_entities (owner_id, lower(name), entity_type);

      -- Tracks which memories the indexer has processed (extracted entities from).
      ALTER TABLE memory_objects ADD COLUMN IF NOT EXISTS indexed_at timestamptz;

      -- Rebuild memloom_fuse with a third arm: entity-anchored. Entities close to the query
      -- (cosine >= p_anchor_sim) anchor it; memories mentioning those anchors are pulled in,
      -- ranked by mention count. The abstention gate (p_anchor_sim) is the key: the arm only
      -- fires when the query clearly names an entity, so it never drags unrelated results.
      DROP FUNCTION IF EXISTS memloom_fuse(
        text, vector, uuid, integer, integer, integer, boolean, boolean,
        double precision, double precision
      );

      CREATE OR REPLACE FUNCTION memloom_fuse(
        p_q           text,
        p_emb         vector(${dims}),
        p_owner       uuid,
        p_limit       int     DEFAULT 10,
        p_pool        int     DEFAULT 50,
        p_anchor      int     DEFAULT 10,
        p_k           int     DEFAULT 60,
        p_use_vector  boolean DEFAULT true,
        p_use_keyword boolean DEFAULT true,
        p_use_entity  boolean DEFAULT true,
        p_anchor_sim  float   DEFAULT 0.45,
        p_w_vector    float   DEFAULT 1.0,
        p_w_keyword   float   DEFAULT 2.0,
        p_w_entity    float   DEFAULT 1.0
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
        anchors AS (
          SELECT me.id AS eid
          FROM memory_entities me
          WHERE p_use_entity AND me.owner_id = p_owner AND me.embedding IS NOT NULL
            AND (1 - (me.embedding <=> p_emb)) >= p_anchor_sim
          ORDER BY me.embedding <=> p_emb
          LIMIT p_anchor
        ),
        ent AS (
          SELECT e.from_id AS id,
                 row_number() OVER (ORDER BY count(DISTINCT e.to_id) DESC) AS rnk
          FROM memory_edges e
          JOIN anchors a ON a.eid = e.to_id
          JOIN memory_objects mo ON mo.id = e.from_id AND mo.status = 'active'
          WHERE e.owner_id = p_owner AND e.relation = 'mention' AND e.active
          GROUP BY e.from_id
          ORDER BY count(DISTINCT e.to_id) DESC
          LIMIT p_pool
        ),
        fused AS (
          SELECT u.id AS fid, sum(u.w / (p_k + u.rnk)) AS score
          FROM (
            SELECT vec.id, vec.rnk, p_w_vector  AS w FROM vec
            UNION ALL SELECT kw.id,  kw.rnk,  p_w_keyword FROM kw
            UNION ALL SELECT ent.id, ent.rnk, p_w_entity FROM ent
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
    {
      // Store-level facts that must survive restarts. First use: the embedding fingerprint,
      // so a store embedded with one provider/model refuses to open under another (mixed
      // vector spaces make similarity silently meaningless).
      id: "0005_meta",
      sql: `
      CREATE TABLE _memloom_meta (
        key text PRIMARY KEY,
        value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
    },
    {
      // The context connector (P7): files mirrored into chunked, embedded, searchable rows.
      // Documents are mirrors of files on disk — re-adding a changed file REPLACES its chunks
      // (no belief pipeline, no HITL); content_hash makes re-adds idempotent.
      id: "0006_context",
      sql: /* sql */ `
      CREATE TABLE context_documents (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id     uuid NOT NULL,
        path         text NOT NULL,
        title        text NOT NULL,
        kind         text NOT NULL,
        content_hash text NOT NULL,
        chunk_count  int  NOT NULL DEFAULT 0,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX context_documents_owner_path_idx ON context_documents (owner_id, path);

      CREATE TABLE context_chunks (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id  uuid NOT NULL REFERENCES context_documents(id) ON DELETE CASCADE,
        owner_id     uuid NOT NULL,
        chunk_index  int  NOT NULL,
        content      text NOT NULL,
        heading_path text,
        page         int,
        embedding    vector(${dims}),
        search_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (document_id, chunk_index)
      );
      CREATE INDEX context_chunks_owner_idx ON context_chunks (owner_id);
      CREATE INDEX context_chunks_tsv_idx ON context_chunks USING gin (search_tsv);

      -- Rebuild memloom_fuse: the vector and keyword arms now rank memories and context
      -- chunks TOGETHER (one ranking over the union per arm), and the function reports which
      -- table each id came from. The entity arm stays memories-only (no entity extraction
      -- over chunks in v1).
      DROP FUNCTION IF EXISTS memloom_fuse(
        text, vector, uuid, int, int, int, int, boolean, boolean, boolean,
        double precision, double precision, double precision, double precision
      );

      CREATE OR REPLACE FUNCTION memloom_fuse(
        p_q           text,
        p_emb         vector(${dims}),
        p_owner       uuid,
        p_limit       int     DEFAULT 10,
        p_pool        int     DEFAULT 50,
        p_anchor      int     DEFAULT 10,
        p_k           int     DEFAULT 60,
        p_use_vector  boolean DEFAULT true,
        p_use_keyword boolean DEFAULT true,
        p_use_entity  boolean DEFAULT true,
        p_anchor_sim  float   DEFAULT 0.45,
        p_w_vector    float   DEFAULT 1.0,
        p_w_keyword   float   DEFAULT 2.0,
        p_w_entity    float   DEFAULT 1.0
      )
      RETURNS TABLE (id uuid, rrf_score double precision, src text)
      LANGUAGE sql STABLE AS $fn$
        WITH vec AS (
          SELECT u.id, u.src, row_number() OVER (ORDER BY u.dist) AS rnk
          FROM (
            SELECT mo.id, 'memory'::text AS src, mo.embedding <=> p_emb AS dist
            FROM memory_objects mo
            WHERE mo.owner_id = p_owner AND mo.status = 'active' AND mo.embedding IS NOT NULL
            UNION ALL
            SELECT cc.id, 'chunk'::text, cc.embedding <=> p_emb
            FROM context_chunks cc
            WHERE cc.owner_id = p_owner AND cc.embedding IS NOT NULL
          ) u
          WHERE p_use_vector
          ORDER BY u.dist
          LIMIT p_pool
        ),
        kw AS (
          SELECT u.id, u.src, row_number() OVER (ORDER BY u.rank DESC) AS rnk
          FROM (
            SELECT mo.id, 'memory'::text AS src,
                   ts_rank(mo.search_tsv, websearch_to_tsquery('simple', p_q)) AS rank
            FROM memory_objects mo
            WHERE mo.owner_id = p_owner AND mo.status = 'active'
              AND mo.search_tsv @@ websearch_to_tsquery('simple', p_q)
            UNION ALL
            SELECT cc.id, 'chunk'::text,
                   ts_rank(cc.search_tsv, websearch_to_tsquery('simple', p_q))
            FROM context_chunks cc
            WHERE cc.owner_id = p_owner
              AND cc.search_tsv @@ websearch_to_tsquery('simple', p_q)
          ) u
          WHERE p_use_keyword
          ORDER BY u.rank DESC
          LIMIT p_pool
        ),
        anchors AS (
          SELECT me.id AS eid
          FROM memory_entities me
          WHERE p_use_entity AND me.owner_id = p_owner AND me.embedding IS NOT NULL
            AND (1 - (me.embedding <=> p_emb)) >= p_anchor_sim
          ORDER BY me.embedding <=> p_emb
          LIMIT p_anchor
        ),
        ent AS (
          SELECT e.from_id AS id, 'memory'::text AS src,
                 row_number() OVER (ORDER BY count(DISTINCT e.to_id) DESC) AS rnk
          FROM memory_edges e
          JOIN anchors a ON a.eid = e.to_id
          JOIN memory_objects mo ON mo.id = e.from_id AND mo.status = 'active'
          WHERE e.owner_id = p_owner AND e.relation = 'mention' AND e.active
          GROUP BY e.from_id
          ORDER BY count(DISTINCT e.to_id) DESC
          LIMIT p_pool
        ),
        fused AS (
          SELECT u.id AS fid, u.src AS fsrc, sum(u.w / (p_k + u.rnk)) AS score
          FROM (
            SELECT vec.id, vec.src, vec.rnk, p_w_vector  AS w FROM vec
            UNION ALL SELECT kw.id,  kw.src,  kw.rnk,  p_w_keyword FROM kw
            UNION ALL SELECT ent.id, ent.src, ent.rnk, p_w_entity FROM ent
          ) u
          GROUP BY u.id, u.src
        )
        SELECT fused.fid, fused.score, fused.fsrc
        FROM fused
        ORDER BY fused.score DESC
        LIMIT p_limit
      $fn$;
    `,
    },
    {
      // Close the memory_type column to the saveable taxonomy (mirrors the hosted platform's type_hint:
      // fact | preference | episode | procedure). Kept in sync with MEMORY_TYPES in types.ts and
      // the zod enum on the HTTP surface. Context chunks live in context_chunks (no memory_type
      // column), so the "context" recall sentinel never reaches this constraint.
      id: "0007_memory_type_enum",
      sql: /* sql */ `
      ALTER TABLE memory_objects
        ADD CONSTRAINT memory_objects_memory_type_check
        CHECK (memory_type IN ('fact', 'preference', 'episode', 'procedure'));
    `,
    },
    {
      // One graph, two granularities: context chunks join the entity layer. The indexer now
      // extracts entities from chunks too (indexed_at tracks progress, same as memory_objects)
      // and links them with chunk -> entity 'mention' edges in the shared, FK-free memory_edges
      // table — the Graphiti MENTIONS pattern. Chunks stay mirrors: no belief pipeline.
      id: "0008_context_graph",
      sql: /* sql */ `
      ALTER TABLE context_chunks ADD COLUMN indexed_at timestamptz;

      -- Rebuild the entity arm of memloom_fuse: memories AND chunks are retrievable by entity
      -- anchor now that both carry 'mention' edges. Same signature and return type, so a plain
      -- CREATE OR REPLACE suffices. A from_id is either an active memory or a chunk; edges left
      -- behind by anything else (stale memories) drop out via the HAVING clause.
      CREATE OR REPLACE FUNCTION memloom_fuse(
        p_q           text,
        p_emb         vector(${dims}),
        p_owner       uuid,
        p_limit       int     DEFAULT 10,
        p_pool        int     DEFAULT 50,
        p_anchor      int     DEFAULT 10,
        p_k           int     DEFAULT 60,
        p_use_vector  boolean DEFAULT true,
        p_use_keyword boolean DEFAULT true,
        p_use_entity  boolean DEFAULT true,
        p_anchor_sim  float   DEFAULT 0.45,
        p_w_vector    float   DEFAULT 1.0,
        p_w_keyword   float   DEFAULT 2.0,
        p_w_entity    float   DEFAULT 1.0
      )
      RETURNS TABLE (id uuid, rrf_score double precision, src text)
      LANGUAGE sql STABLE AS $fn$
        WITH vec AS (
          SELECT u.id, u.src, row_number() OVER (ORDER BY u.dist) AS rnk
          FROM (
            SELECT mo.id, 'memory'::text AS src, mo.embedding <=> p_emb AS dist
            FROM memory_objects mo
            WHERE mo.owner_id = p_owner AND mo.status = 'active' AND mo.embedding IS NOT NULL
            UNION ALL
            SELECT cc.id, 'chunk'::text, cc.embedding <=> p_emb
            FROM context_chunks cc
            WHERE cc.owner_id = p_owner AND cc.embedding IS NOT NULL
          ) u
          WHERE p_use_vector
          ORDER BY u.dist
          LIMIT p_pool
        ),
        kw AS (
          SELECT u.id, u.src, row_number() OVER (ORDER BY u.rank DESC) AS rnk
          FROM (
            SELECT mo.id, 'memory'::text AS src,
                   ts_rank(mo.search_tsv, websearch_to_tsquery('simple', p_q)) AS rank
            FROM memory_objects mo
            WHERE mo.owner_id = p_owner AND mo.status = 'active'
              AND mo.search_tsv @@ websearch_to_tsquery('simple', p_q)
            UNION ALL
            SELECT cc.id, 'chunk'::text,
                   ts_rank(cc.search_tsv, websearch_to_tsquery('simple', p_q))
            FROM context_chunks cc
            WHERE cc.owner_id = p_owner
              AND cc.search_tsv @@ websearch_to_tsquery('simple', p_q)
          ) u
          WHERE p_use_keyword
          ORDER BY u.rank DESC
          LIMIT p_pool
        ),
        anchors AS (
          SELECT me.id AS eid
          FROM memory_entities me
          WHERE p_use_entity AND me.owner_id = p_owner AND me.embedding IS NOT NULL
            AND (1 - (me.embedding <=> p_emb)) >= p_anchor_sim
          ORDER BY me.embedding <=> p_emb
          LIMIT p_anchor
        ),
        ent AS (
          SELECT g.id, g.src, row_number() OVER (ORDER BY g.cnt DESC) AS rnk
          FROM (
            SELECT e.from_id AS id,
                   CASE WHEN bool_or(mo.id IS NOT NULL) THEN 'memory'::text
                        ELSE 'chunk'::text END AS src,
                   count(DISTINCT e.to_id) AS cnt
            FROM memory_edges e
            JOIN anchors a ON a.eid = e.to_id
            LEFT JOIN memory_objects mo ON mo.id = e.from_id AND mo.status = 'active'
            LEFT JOIN context_chunks cc ON cc.id = e.from_id
            WHERE e.owner_id = p_owner AND e.relation = 'mention' AND e.active
            GROUP BY e.from_id
            HAVING bool_or(mo.id IS NOT NULL) OR bool_or(cc.id IS NOT NULL)
            ORDER BY count(DISTINCT e.to_id) DESC
            LIMIT p_pool
          ) g
        ),
        fused AS (
          SELECT u.id AS fid, u.src AS fsrc, sum(u.w / (p_k + u.rnk)) AS score
          FROM (
            SELECT vec.id, vec.src, vec.rnk, p_w_vector  AS w FROM vec
            UNION ALL SELECT kw.id,  kw.src,  kw.rnk,  p_w_keyword FROM kw
            UNION ALL SELECT ent.id, ent.src, ent.rnk, p_w_entity FROM ent
          ) u
          GROUP BY u.id, u.src
        )
        SELECT fused.fid, fused.score, fused.fsrc
        FROM fused
        ORDER BY fused.score DESC
        LIMIT p_limit
      $fn$;
    `,
    },
    {
      // Node versioning: every belief is a chain of versions sharing a root_id. The newest
      // active row per root_id is the current belief; older ones are stale (never deleted),
      // linked child -> parent by the existing 'replaces' edge. History = WHERE root_id = ...
      // ORDER BY version. Recall is unaffected: it already filters status = 'active', so stale
      // old versions never surface. Validity interval reuses existing columns — asserted_at is
      // "valid from", stale_since is "valid to" — so no new temporal columns are needed.
      id: "0009_node_versions",
      sql: /* sql */ `
      ALTER TABLE memory_objects ADD COLUMN root_id uuid;
      ALTER TABLE memory_objects ADD COLUMN version int NOT NULL DEFAULT 1;
      -- Backfill: every existing memory is the root of its own single-version lineage.
      UPDATE memory_objects SET root_id = id WHERE root_id IS NULL;
      ALTER TABLE memory_objects ALTER COLUMN root_id SET NOT NULL;
      CREATE INDEX IF NOT EXISTS memory_objects_root_idx
        ON memory_objects (owner_id, root_id, version);
    `,
    },
  ];
}
