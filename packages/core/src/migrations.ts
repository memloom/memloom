// Migrations are TS constants (not .sql files) so they bundle cleanly into the published
// library: no runtime fs/path resolution. Ordered by id; applied once, tracked in
// _memloom_migrations. The schema is DDL + `language sql` only, zero plpgsql (D2), so it
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
      -- fused top-K as (id, rrf_score). Pure 'language sql', no plpgsql (D2), so it runs
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
      // Documents are mirrors of files on disk: re-adding a changed file REPLACES its chunks
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
      // table: the Graphiti MENTIONS pattern. Chunks stay mirrors: no belief pipeline.
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
      // old versions never surface. Validity interval reuses existing columns: asserted_at is
      // "valid from", stale_since is "valid to", so no new temporal columns are needed.
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
    {
      // Typed entity-to-entity relationships ride the shared edge table. confidence is the
      // extractor's stated 0..1; source_id is the memory/chunk that stated the relationship
      // (provenance: a removed document takes its relationships with it). Nullable, no
      // backfill: existing mention/replaces/distinct edges are legitimately source-less.
      id: "0010_typed_edges",
      sql: /* sql */ `
      ALTER TABLE memory_edges ADD COLUMN IF NOT EXISTS confidence double precision;
      ALTER TABLE memory_edges ADD COLUMN IF NOT EXISTS source_id uuid;
      CREATE INDEX IF NOT EXISTS memory_edges_source_idx ON memory_edges (source_id) WHERE active;
    `,
    },
    {
      // The schema registry: entity types and predicates as rows, in three tiers:
      // 'system' (seeded from the schema.ts constants), 'user' (created in the viewer/API),
      // and 'proposed' (LLM suggestions awaiting review). The extraction prompt and
      // validators read the ACTIVE rows; 'dismissed' names are blocklisted from
      // re-proposal. Seeding happens lazily per owner in the engine (ON CONFLICT DO
      // NOTHING), so new owners and new engine versions converge without data migrations.
      id: "0011_schema_registry",
      sql: /* sql */ `
      CREATE TABLE memory_schema (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id     uuid NOT NULL,
        kind         text NOT NULL CHECK (kind IN ('entity_type', 'predicate')),
        name         text NOT NULL,
        description  text NOT NULL DEFAULT '',
        tier         text NOT NULL CHECK (tier IN ('system', 'user', 'proposed')),
        status       text NOT NULL CHECK (status IN ('active', 'disabled', 'dismissed')),
        occurrences  int  NOT NULL DEFAULT 0,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_id, kind, name)
      );
      CREATE INDEX memory_schema_owner_idx ON memory_schema (owner_id, kind, status);
    `,
    },
    {
      // Persistent, session-grouped indexing logs (a production-proven memory_index_runs pattern):
      // one runs row per index()/reindex() pass holding status + totals, and an append-only
      // per-item event stream under it. The Console lists runs newest-first; a run's events
      // load on expand. Deleting a run cascades to its events.
      id: "0012_index_runs",
      sql: /* sql */ `
      CREATE TABLE memory_index_runs (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id          uuid NOT NULL,
        trigger           text NOT NULL DEFAULT 'index'
                            CHECK (trigger IN ('index', 'rebuild')),
        -- 'interrupted' = the daemon died mid-run; reconciled when the next run starts.
        status            text NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'success', 'warning', 'error', 'interrupted')),
        batch_size        int NOT NULL DEFAULT 0,
        memories_indexed  int NOT NULL DEFAULT 0,
        chunks_indexed    int NOT NULL DEFAULT 0,
        items_failed      int NOT NULL DEFAULT 0,
        entities_linked   int NOT NULL DEFAULT 0,
        relations_created int NOT NULL DEFAULT 0,
        started_at        timestamptz NOT NULL DEFAULT now(),
        finished_at       timestamptz
      );
      CREATE INDEX memory_index_runs_owner_started_idx
        ON memory_index_runs (owner_id, started_at DESC);
      CREATE TABLE memory_index_events (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id   uuid NOT NULL,
        run_id     uuid NOT NULL REFERENCES memory_index_runs (id) ON DELETE CASCADE,
        level      text NOT NULL DEFAULT 'info'
                     CHECK (level IN ('info', 'success', 'warning', 'error')),
        message    text NOT NULL,
        item_id    uuid,
        metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX memory_index_events_run_idx ON memory_index_events (run_id, created_at);
    `,
    },
    {
      // Assistant chat sessions + messages. Only plain user/assistant turns persist; the
      // agentic tool scaffolding lives and dies inside one turn. Messages are embedded so
      // chat search gets a similarity arm alongside keyword ILIKE.
      id: "0013_assistant_chat",
      sql: /* sql */ `
      CREATE TABLE assistant_sessions (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id   uuid NOT NULL,
        title      text NOT NULL DEFAULT 'New chat',
        is_starred boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX assistant_sessions_owner_idx
        ON assistant_sessions (owner_id, is_starred DESC, updated_at DESC);
      CREATE TABLE assistant_messages (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id   uuid NOT NULL,
        session_id uuid NOT NULL REFERENCES assistant_sessions (id) ON DELETE CASCADE,
        role       text NOT NULL CHECK (role IN ('user', 'assistant')),
        content    text NOT NULL,
        sources    jsonb NOT NULL DEFAULT '[]'::jsonb,
        embedding  vector(${dims}),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX assistant_messages_session_idx ON assistant_messages (session_id, created_at);
    `,
    },
    {
      // Fuse tuning from a real-corpus failure: the top-cosine chunk (0.81) ranked 10th
      // because loosely-related entities anchored at 0.45 (qwen's cosine baseline is high,
      // so 0.45 admits near-noise) and the count-ranked, topic-blind entity arm then gave
      // unrelated chunks a second RRF vote that beat a perfect single-arm vector hit.
      // Entity arm becomes a half-weight hint and anchors must clear 0.60. Same body,
      // new defaults only.
      id: "0014_fuse_entity_tuning",
      sql: /* sql */ `
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
        p_anchor_sim  float   DEFAULT 0.60,
        p_w_vector    float   DEFAULT 1.0,
        p_w_keyword   float   DEFAULT 2.0,
        p_w_entity    float   DEFAULT 0.5
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
      // Chat-scoped attachments: a file attached to an assistant chat is chunked and
      // embedded like any document but tagged with the session, searchable only from that
      // chat's recall and deleted with it. session_id is denormalized onto chunks so the
      // fuse function filters without a join. The parameter list changes, so the old
      // signature must be dropped first (CREATE OR REPLACE would add an overload and make
      // recall's positional call ambiguous). Body is 0014's plus the two chunk filters.
      id: "0015_session_attachments",
      sql: /* sql */ `
      ALTER TABLE context_documents ADD COLUMN IF NOT EXISTS session_id uuid;
      ALTER TABLE context_chunks ADD COLUMN IF NOT EXISTS session_id uuid;

      DROP FUNCTION IF EXISTS memloom_fuse(
        text, vector, uuid, int, int, int, int, boolean, boolean, boolean,
        double precision, double precision, double precision, double precision
      );

      CREATE FUNCTION memloom_fuse(
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
        p_anchor_sim  float   DEFAULT 0.60,
        p_w_vector    float   DEFAULT 1.0,
        p_w_keyword   float   DEFAULT 2.0,
        p_w_entity    float   DEFAULT 0.5,
        p_session     uuid    DEFAULT NULL
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
              AND (cc.session_id IS NULL OR cc.session_id = p_session)
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
              AND (cc.session_id IS NULL OR cc.session_id = p_session)
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
      // Proposals remember what motivated them: the entities (or relationship endpoints)
      // the extractor held out because their type/predicate wasn't in the vocabulary yet.
      // Review shows them, and approval links them into the graph directly, so the user
      // never has to re-index and hope a nondeterministic second run re-finds the same
      // occurrences. Shape: ProposalExample[] (schema.ts).
      id: "0016_proposal_examples",
      sql: /* sql */ `
      ALTER TABLE memory_schema ADD COLUMN examples jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
    },
    {
      // Session import bookkeeping. The ledger makes imports idempotent: one row per source
      // session, keyed by the session's OWN id (not the file path, so forks and renames don't
      // re-import). line_offset is the watermark; prefix_hash is sha256 of the processed
      // lines, because Claude Code rewrites transcripts (compaction, resume) and a resumed
      // read past a rewrite would silently distill the wrong lines. Provenance keeps every
      // session-derived memory traceable to its source passage even after the user cleans up
      // old transcripts (the excerpt is stored redacted).
      id: "0017_import_ledger",
      sql: /* sql */ `
      CREATE TABLE import_ledger (
        owner_id       uuid NOT NULL,
        source         text NOT NULL,
        session_id     text NOT NULL,
        file_path      text NOT NULL,
        line_offset    int  NOT NULL,
        prefix_hash    text NOT NULL,
        memories_saved int  NOT NULL DEFAULT 0,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, source, session_id)
      );
      CREATE TABLE import_provenance (
        memory_id  uuid PRIMARY KEY REFERENCES memory_objects (id) ON DELETE CASCADE,
        owner_id   uuid NOT NULL,
        source     text NOT NULL,
        session_id text NOT NULL,
        file_path  text NOT NULL,
        start_line int  NOT NULL,
        end_line   int  NOT NULL,
        excerpt    text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `,
    },
    {
      // Deterministic chat ordering. created_at has millisecond precision, so a turn's user
      // and assistant messages can tie (instant test providers, and nothing forbids it live);
      // tying broke ordering because the uuid tiebreaker is random. The daemon is the single
      // writer, so insertion order IS conversation order: seq records it.
      id: "0018_assistant_message_seq",
      sql: /* sql */ `
      ALTER TABLE assistant_messages ADD COLUMN seq bigint GENERATED BY DEFAULT AS IDENTITY;
    `,
    },
    {
      // Entity resolution: fold name variants ("Opus 4.8", "Claude Opus 4.8") into one
      // canonical entity WITHOUT losing the variant. Two tables, both write-once-then-revert.
      //
      // memory_entity_aliases is the addressable surface form AND the lookup that keeps a
      // fold from undoing itself: #resolveEntity checks it by name_key before inserting, so
      // the next memory mentioning a folded spelling lands on the canonical instead of
      // minting a fresh row. It also carries everything needed to resurrect the absorbed
      // row: its ORIGINAL id and embedding, because revert must restore the same uuid that
      // deactivated edges still point at.
      //
      // memory_entity_merges is the fold record. A merge is a record, never a destructive
      // edit: the absorbed row leaves memory_entities but its identity lives here and in the
      // alias row, edges are deactivated rather than deleted, and reverted_at un-does it.
      id: "0019_entity_aliases",
      sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS memory_entity_merges (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id      uuid NOT NULL,
        canonical_id  uuid NOT NULL,
        -- The absorbed entity's original row, kept whole so revert restores it exactly.
        source_id     uuid NOT NULL,
        source_name   text NOT NULL,
        source_type   text NOT NULL,
        -- Kept because #resolveEntity breaks ties with ORDER BY created_at: a restored row
        -- must sort where it originally did, not where the revert happened to put it.
        source_created_at timestamptz,
        -- 'auto' (deterministic normalization), 'llm', or 'human' (resolved from the queue).
        decided_by    text NOT NULL,
        score         double precision,
        reason        text,
        -- Edge ids this merge touched, so revert repoints exactly what it moved and
        -- reactivates exactly what it deactivated. Shape: {"repointed":[...],"deactivated":[...]}.
        edge_changes  jsonb NOT NULL DEFAULT '{}'::jsonb,
        reverted_at   timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS memory_entity_merges_canonical_idx
        ON memory_entity_merges (owner_id, canonical_id) WHERE reverted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS memory_entity_merges_source_idx
        ON memory_entity_merges (owner_id, source_id) WHERE reverted_at IS NULL;

      CREATE TABLE IF NOT EXISTS memory_entity_aliases (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id     uuid NOT NULL,
        canonical_id uuid NOT NULL,
        -- The variant spelling as it was seen, and its entityNameKey form (the lookup key).
        name         text NOT NULL,
        name_key     text NOT NULL,
        -- The absorbed row's original id and vector: revert restores both verbatim.
        entity_id    uuid,
        embedding    vector(${dims}),
        merge_id     uuid,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      -- The lookup #resolveEntity does on every extracted mention: one alias per name key
      -- per owner, mirroring how memory_entities is keyed by name key alone.
      CREATE UNIQUE INDEX IF NOT EXISTS memory_entity_aliases_key_idx
        ON memory_entity_aliases (owner_id, name_key);
      CREATE INDEX IF NOT EXISTS memory_entity_aliases_canonical_idx
        ON memory_entity_aliases (owner_id, canonical_id);

      -- "agent" as a first-class entity type: attributing work to a specific agent is wanted
      -- downstream. The system tier self-seeds through #ensureSchemaSeed (insert-if-absent on
      -- every extraction run), so adding it to ENTITY_TYPES is normally enough. The one case
      -- seeding cannot reach is a store where "agent" was already PROPOSED and then dismissed:
      -- the row exists, so ON CONFLICT DO NOTHING skips it and the type stays invisible.
      -- Promote exactly that row, and only it; a user-tier "agent" they made themselves is
      -- left alone.
      UPDATE memory_schema
         SET tier = 'system', status = 'active'
       WHERE kind = 'entity_type' AND name = 'agent' AND tier = 'proposed';
    `,
    },
    {
      // Uncertain entity merges go to the EXISTING conflicts surface, not a second queue:
      // same memory_dedup_decisions table, same resolve/revert semantics, same Console tab.
      // action = 'entity_merge' distinguishes them. The 0003 index is scoped
      // WHERE action = 'conflict', so entity rows are invisible to the memory queue by
      // construction and need their own partial index. No CHECK constraint to widen: 0003
      // declared action as plain text.
      id: "0020_entity_merge_queue",
      sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS memory_entity_merge_unresolved_idx
        ON memory_dedup_decisions (owner_id, created_at DESC)
        WHERE action = 'entity_merge' AND resolution_action IS NULL;
    `,
    },
    {
      // Recall follows folds. Without this, folding is a net LOSS for retrieval: the entity
      // arm anchors by matching the query vector against memory_entities, and a fold DELETES
      // the absorbed row, so a query saying "Bob" stops anchoring on anything once Bob
      // is folded into Robert. The variant's vector is not gone, it moved to the alias
      // row, which this function did not read.
      //
      // The fix is one widened CTE: anchor on entity vectors UNION alias vectors, mapping
      // every alias hit to its canonical id. Everything downstream is unchanged, because
      // mergeEntities repointed the absorbed row's mention edges onto the canonical, so the
      // ids this now yields are exactly the ids the edge join already expects.
      //
      // Deduped by eid before the limit: canonical and alias both matching is the NORMAL
      // case (they are spellings of one name, so their vectors are close), and without the
      // group-by that pair would eat two of the ten anchor slots to name one entity.
      //
      // Body is 0015's, signature identical, so CREATE OR REPLACE is safe here: no new
      // overload, and recall's positional call stays unambiguous.
      id: "0021_fuse_entity_aliases",
      sql: /* sql */ `
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
        p_anchor_sim  float   DEFAULT 0.60,
        p_w_vector    float   DEFAULT 1.0,
        p_w_keyword   float   DEFAULT 2.0,
        p_w_entity    float   DEFAULT 0.5,
        p_session     uuid    DEFAULT NULL
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
              AND (cc.session_id IS NULL OR cc.session_id = p_session)
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
              AND (cc.session_id IS NULL OR cc.session_id = p_session)
          ) u
          WHERE p_use_keyword
          ORDER BY u.rank DESC
          LIMIT p_pool
        ),
        anchors AS (
          SELECT g.eid
          FROM (
            SELECT u.eid, min(u.dist) AS dist
            FROM (
              SELECT me.id AS eid, me.embedding <=> p_emb AS dist
              FROM memory_entities me
              WHERE me.owner_id = p_owner AND me.embedding IS NOT NULL
                AND (1 - (me.embedding <=> p_emb)) >= p_anchor_sim
              UNION ALL
              SELECT ea.canonical_id AS eid, ea.embedding <=> p_emb AS dist
              FROM memory_entity_aliases ea
              WHERE ea.owner_id = p_owner AND ea.embedding IS NOT NULL
                AND (1 - (ea.embedding <=> p_emb)) >= p_anchor_sim
            ) u
            WHERE p_use_entity
            GROUP BY u.eid
          ) g
          ORDER BY g.dist
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
      // The diarized voice roster for a recording: labels, talk time, a playable sample
      // range, and one voice embedding per speaker. jsonb on the document rather than a
      // column per chunk, because the roster is per-recording metadata: renaming a speaker
      // edits this and the affected chunks' text, never the document's content hash, so a
      // rename can never look like the file changed. Text documents leave it NULL.
      id: "0022_speaker_roster",
      sql: /* sql */ `
      ALTER TABLE context_documents ADD COLUMN IF NOT EXISTS speakers jsonb;
    `,
    },
    {
      // Reconciliation: the consolidation pass. One runs row per `memloom reconcile`, an append-only
      // action row per thing the run retired, asked about, or raised. The ledger is what makes
      // a run reversible: status stays two-valued ('active'/'stale') and records only THAT a
      // memory is not current, never why, so the run that staled a row has to say so somewhere
      // else. revertReconcile reads these rows back, exactly as revertConflict reads
      // memory_dedup_decisions. staled_at holds the stale_since the run actually wrote: revert
      // restores a row only while that value is untouched, so a later human decision is never
      // clobbered. `class` + `decision` are also the counters that let a retirement class earn
      // autonomy later.
      //
      // Every reconcile migration below is written to be safe to run twice. `migrate` keys on
      // the id, so one whose objects a store already has for any reason is applied again and
      // must be a no-op rather than an error. Rows in _memloom_migrations for ids no longer in
      // this array are ignored.
      id: "0023_reconcile",
      sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS memory_reconcile_runs (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id          uuid NOT NULL,
        mode              text NOT NULL CHECK (mode IN ('dry_run', 'apply')),
        trigger           text NOT NULL DEFAULT 'manual'
                            CHECK (trigger IN ('manual', 'idle', 'startup')),
        status            text NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'success', 'error', 'aborted')),
        scanned           int NOT NULL DEFAULT 0,
        retired           int NOT NULL DEFAULT 0,
        -- Entities folded. Counted apart from retired because they are undone by a different
        -- mechanism: revertEntityMerge rather than reactivating a staled row.
        folded            int NOT NULL DEFAULT 0,
        questions         int NOT NULL DEFAULT 0,
        conflicts_raised  int NOT NULL DEFAULT 0,
        llm_calls         int NOT NULL DEFAULT 0,
        -- What the contradiction pass WOULD cost. Tokens, not currency: nothing in the repo
        -- tracks model prices, so a stored dollar figure would rot. The printed estimate
        -- applies a hand-maintained constant in reconcile.ts to these numbers.
        est_input_tokens  int NOT NULL DEFAULT 0,
        est_output_tokens int NOT NULL DEFAULT 0,
        model             text,
        error             text,
        started_at        timestamptz NOT NULL DEFAULT now(),
        finished_at       timestamptz,
        reverted_at       timestamptz
      );
      CREATE INDEX IF NOT EXISTS memory_reconcile_runs_owner_started_idx
        ON memory_reconcile_runs (owner_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS memory_reconcile_actions (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id    uuid NOT NULL,
        run_id      uuid NOT NULL REFERENCES memory_reconcile_runs (id) ON DELETE CASCADE,
        kind        text NOT NULL CHECK (kind IN ('retire', 'question', 'conflict', 'fold')),
        class       text NOT NULL,
        memory_id   uuid,
        reason      text NOT NULL DEFAULT '',
        -- applied: the run actually changed state for this row (never true in a dry run).
        applied     boolean NOT NULL DEFAULT false,
        staled_at   timestamptz,
        -- surfaced: shown to the human. Findings past the per-run cap are recorded and NOT
        -- shown, so nothing is lost and nothing floods.
        surfaced    boolean NOT NULL DEFAULT false,
        decision    text CHECK (decision IN ('approved', 'rejected', 'snoozed')),
        decided_at  timestamptz,
        conflict_id uuid,
        -- Set when kind='fold': the memory_entity_merges row revertReconcile hands to
        -- revertEntityMerge. Without it a run's entity folds are not undoable, and being
        -- undoable is the whole reason the fold pass is allowed to act unasked.
        merge_id    uuid,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS memory_reconcile_actions_run_idx ON memory_reconcile_actions (run_id, created_at);
      CREATE INDEX IF NOT EXISTS memory_reconcile_actions_class_idx
        ON memory_reconcile_actions (owner_id, class, decision);
    `,
    },
    {
      // Which model decided a fold. memory_entity_merges already records decided_by
      // ('auto' | 'llm' | 'human'), the score and the reason, but not who the model was, and
      // 'llm' had no writer until reconciliation got one. Without this a fold made six months ago is
      // unattributable and a bad model cannot be traced through its decisions.
      id: "0024_entity_merge_model",
      sql: /* sql */ `
      ALTER TABLE memory_entity_merges ADD COLUMN IF NOT EXISTS model text;
    `,
    },
    {
      // Where a conflict's incoming belief sat BEFORE keep_new moved it onto the winning
      // lineage, so revert can put it back exactly.
      //
      // revertConflict hardcoded root = self, version = 1. That is right for a save-time
      // incoming, which is always a fresh insert at (self, 1), and wrong for anything else: a
      // conflict raised between two beliefs that already exist would, on revert, drop a
      // version-4 belief to version 1 of its own root while versions 1 to 3 still claim that
      // root. Reconciliation raises exactly that kind of conflict now.
      //
      // NULL means "no record", which every row written before this migration is, and every
      // one of those IS a save-time incoming. So NULL keeps the old behaviour and is correct
      // rather than merely compatible. Do not "fix" that fallback.
      id: "0025_conflict_prior_lineage",
      sql: /* sql */ `
      ALTER TABLE memory_dedup_decisions ADD COLUMN IF NOT EXISTS prior_root_id uuid;
      ALTER TABLE memory_dedup_decisions ADD COLUMN IF NOT EXISTS prior_version int;
    `,
    },
    {
      // Who settled a conflict, and why.
      //
      // A fold records this already (memory_entity_merges carries decided_by, score, reason and
      // model), but only a fold does. A pair the model kept APART writes keep_both and nothing
      // else, and an auto-resolved memory conflict writes its action and nothing else, so the
      // model's reasoning existed only in the progress stream and was gone the moment the run
      // finished. One button press that decided fifty pairs left thirty-seven of them with no
      // record of what was decided or that a model decided it.
      //
      // NULL means a human clicked it, which is what every row written before this migration is.
      id: "0026_resolution_provenance",
      sql: /* sql */ `
      ALTER TABLE memory_dedup_decisions ADD COLUMN IF NOT EXISTS resolution_by text;
      ALTER TABLE memory_dedup_decisions ADD COLUMN IF NOT EXISTS resolution_model text;
      ALTER TABLE memory_dedup_decisions ADD COLUMN IF NOT EXISTS resolution_score double precision;
      ALTER TABLE memory_dedup_decisions ADD COLUMN IF NOT EXISTS resolution_reason text;
    `,
    },
    {
      // The contradiction re-check's findings. A 'possible' row is deliberately NOT a conflict:
      // measured precision on this pass is about 40 percent, so putting them in
      // memory_dedup_decisions would make the queue, the queue-pressure gate, the tab badge and
      // MCP list_conflicts all 60 percent noise. They live here until a human says otherwise, and
      // approving one writes the real conflict row.
      //
      // The two quotes are the point. The model must copy the clashing assertion from each side
      // verbatim, and the pass verifies both spans occur in the two memories before recording
      // anything. Measured: the model never invents a quote, it omits them when it cannot find
      // one, so this rejects the findings it will not stand behind. It does not raise precision
      // (a true span can still carry a wrong conclusion) and it is kept because two quotes make a
      // finding readable in three seconds instead of two full memories.
      id: "0027_reconcile_recheck",
      sql: /* sql */ `
      ALTER TABLE memory_reconcile_actions DROP CONSTRAINT IF EXISTS memory_reconcile_actions_kind_check;
      ALTER TABLE memory_reconcile_actions ADD CONSTRAINT memory_reconcile_actions_kind_check
        CHECK (kind IN ('retire', 'question', 'conflict', 'fold', 'possible'));

      -- The other side of the pair. memory_id holds the newer belief, candidate_id the older.
      ALTER TABLE memory_reconcile_actions ADD COLUMN IF NOT EXISTS candidate_id uuid;
      ALTER TABLE memory_reconcile_actions ADD COLUMN IF NOT EXISTS new_quote text;
      ALTER TABLE memory_reconcile_actions ADD COLUMN IF NOT EXISTS old_quote text;

      -- "Never ask again" reads this: an answered pair is never re-judged, in either direction.
      CREATE INDEX IF NOT EXISTS memory_reconcile_actions_pair_idx
        ON memory_reconcile_actions (owner_id, memory_id, candidate_id);

      -- Counted apart from conflicts_raised: nothing was raised, something was noticed.
      ALTER TABLE memory_reconcile_runs ADD COLUMN IF NOT EXISTS possible int NOT NULL DEFAULT 0;
    `,
    },
    {
      // When each belief was last put through the contradiction re-check. NULL means never.
      //
      // Per belief rather than per run, and that choice is what makes the pass safe to cap. A
      // single watermark advanced to a run's clock time would strand every belief the capped run
      // did not reach, since later runs only look forward. Stamping each belief instead means the
      // pass drains oldest-unchecked first and nothing is skipped, an interrupted run keeps the
      // beliefs it already paid for, and a belief examined long ago comes back around on its own
      // once the backlog is clear, because that is the same query.
      //
      // The index is the pass's selection order: never-checked first, oldest first within that.
      id: "0028_recheck_watermark",
      sql: /* sql */ `
      ALTER TABLE memory_objects ADD COLUMN IF NOT EXISTS last_rechecked_at timestamptz;
      CREATE INDEX IF NOT EXISTS memory_objects_recheck_due_idx
        ON memory_objects (owner_id, last_rechecked_at NULLS FIRST, created_at)
        WHERE status = 'active';
    `,
    },
    {
      // What a run actually spent, as opposed to est_input_tokens and est_output_tokens, which
      // price work nobody has done yet. Written per call rather than once at the end: a sweep runs
      // for minutes and a budget that can only be checked afterwards is not a budget.
      //
      // spent_usd is the provider's own billed figure, so it matches the invoice rather than a
      // local price table.
      id: "0029_reconcile_spend",
      sql: /* sql */ `
      ALTER TABLE memory_reconcile_runs ADD COLUMN IF NOT EXISTS spent_input_tokens int NOT NULL DEFAULT 0;
      ALTER TABLE memory_reconcile_runs ADD COLUMN IF NOT EXISTS spent_output_tokens int NOT NULL DEFAULT 0;
      ALTER TABLE memory_reconcile_runs ADD COLUMN IF NOT EXISTS spent_usd double precision NOT NULL DEFAULT 0;
    `,
    },
  ];
}
