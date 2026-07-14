// memloom Phase 0 spike, throwaway.
// Question: can PGLite (embedded WASM Postgres, no Docker) run the memloom engine's
// load-bearing DB primitives? If yes, the local-first differentiator is real.
//
// Checks:
//   1. pgvector extension + vector(1024) + <=> cosine operator
//   2. GENERATED ALWAYS AS (to_tsvector(...)) STORED column + GIN index
//   3. the `language sql` hybrid_query (vec + keyword arms, RRF fuse, {memories,edges} jsonb)
//   4. latency on a few thousand rows with NO HNSW (sequential cosine scan)
//   5. data-dir lock behaviour (does a second opener of the same dir fail fast?)
//
// Exit non-zero if any of checks 1-4 fail (they gate the architecture). Check 5 is
// informational: it tells us whether we must ship our own lockfile (D1) or PGLite
// already guards the dir.

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIM = 1024;
const N_ROWS = 4000;
const OWNER = "00000000-0000-0000-0000-000000000001";
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
};

// A random unit-ish vector as a pgvector literal string: "[0.01,-0.4,...]"
function randVec(dim = DIM) {
  const a = new Array(dim);
  for (let i = 0; i < dim; i++) a[i] = (Math.random() * 2 - 1).toFixed(4);
  return "[" + a.join(",") + "]";
}

async function main() {
  const db = await PGlite.create({ extensions: { vector } });

  // ── 1. pgvector ────────────────────────────────────────────────────────────
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await db.exec(`
      CREATE TABLE memory_objects (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id    uuid NOT NULL,
        status      text NOT NULL DEFAULT 'active',
        canonical   text,
        content     text NOT NULL,
        embedding   vector(${DIM}),
        created_at  timestamptz NOT NULL DEFAULT now()
      );
    `);
    const probe = randVec();
    await db.query(
      `INSERT INTO memory_objects (owner_id, content, embedding) VALUES ($1,$2,$3::vector)`,
      [OWNER, "probe row", probe]
    );
    const r = await db.query(
      `SELECT 1 - (embedding <=> $1::vector) AS sim FROM memory_objects LIMIT 1`,
      [probe]
    );
    const sim = r.rows[0]?.sim;
    record("1. pgvector vector(1024) + <=> cosine", Math.abs(sim - 1) < 1e-3, `self-sim=${sim}`);
  } catch (e) {
    record("1. pgvector vector(1024) + <=> cosine", false, e.message);
  }

  // ── 2. generated tsvector STORED column + GIN ────────────────────────────────
  try {
    await db.exec(`
      ALTER TABLE memory_objects
        ADD COLUMN search_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('simple', coalesce(canonical,'') || ' ' || content)) STORED;
    `);
    await db.exec(`CREATE INDEX mo_tsv_idx ON memory_objects USING gin (search_tsv);`);
    await db.query(
      `INSERT INTO memory_objects (owner_id, canonical, content, embedding)
       VALUES ($1,$2,$3,$4::vector)`,
      [OWNER, "staging-db", "the staging database is postgres on fly.io", randVec()]
    );
    const m = await db.query(
      `SELECT count(*)::int AS n FROM memory_objects
       WHERE search_tsv @@ websearch_to_tsquery('simple', $1)`,
      ["staging database"]
    );
    record("2. generated tsvector STORED + GIN", m.rows[0].n >= 1, `matched ${m.rows[0].n} row(s)`);
  } catch (e) {
    record("2. generated tsvector STORED + GIN", false, e.message);
  }

  // ── seed ~N_ROWS for the function + latency checks ───────────────────────────
  let seedOk = true;
  try {
    await db.exec(`
      CREATE TABLE memory_edges (
        from_id  uuid NOT NULL,
        to_id    uuid NOT NULL,
        relation text NOT NULL DEFAULT 'mention'
      );
    `);
    const BATCH = 200;
    for (let start = 0; start < N_ROWS; start += BATCH) {
      const vals = [];
      const params = [];
      let p = 1;
      for (let i = start; i < Math.min(start + BATCH, N_ROWS); i++) {
        // sprinkle the keyword "vector" into ~1/50 rows so the kw arm has hits
        const content =
          i % 50 === 0 ? `row ${i} about vector search and retrieval` : `row ${i} generic memory content`;
        vals.push(`($${p++},$${p++},$${p++}::vector)`);
        params.push(OWNER, content, randVec());
      }
      await db.query(
        `INSERT INTO memory_objects (owner_id, content, embedding) VALUES ${vals.join(",")}`,
        params
      );
    }
    // a few edges among the first rows
    const ids = (await db.query(`SELECT id FROM memory_objects ORDER BY created_at LIMIT 5`)).rows;
    for (let i = 0; i < ids.length - 1; i++) {
      await db.query(`INSERT INTO memory_edges (from_id, to_id, relation) VALUES ($1,$2,'mention')`, [
        ids[i].id,
        ids[i + 1].id,
      ]);
    }
    const total = (await db.query(`SELECT count(*)::int AS n FROM memory_objects`)).rows[0].n;
    record("   seed", total >= N_ROWS, `${total} rows, no HNSW index`);
  } catch (e) {
    seedOk = false;
    record("   seed", false, e.message);
  }

  // ── 3. the language sql hybrid_query ─────────────────────────────────────────
  try {
    await db.exec(`
      CREATE OR REPLACE FUNCTION hybrid_query(
        p_q text, p_emb vector(${DIM}), p_owner uuid,
        p_limit int DEFAULT 10, p_pool int DEFAULT 50, p_k int DEFAULT 60
      ) RETURNS jsonb LANGUAGE sql AS $fn$
        WITH vec AS (
          SELECT id, row_number() OVER (ORDER BY embedding <=> p_emb) AS rnk
          FROM memory_objects
          WHERE owner_id = p_owner AND status = 'active' AND embedding IS NOT NULL
          ORDER BY embedding <=> p_emb
          LIMIT p_pool
        ),
        kw AS (
          SELECT id, row_number() OVER (
            ORDER BY ts_rank(search_tsv, websearch_to_tsquery('simple', p_q)) DESC
          ) AS rnk
          FROM memory_objects
          WHERE owner_id = p_owner AND status = 'active'
            AND search_tsv @@ websearch_to_tsquery('simple', p_q)
          LIMIT p_pool
        ),
        fused AS (
          SELECT id, sum(1.0 / (p_k + rnk)) AS score
          FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM kw) u
          GROUP BY id
          ORDER BY score DESC
          LIMIT p_limit
        ),
        memories AS (
          SELECT jsonb_agg(to_jsonb(x) ORDER BY x.rrf_score DESC) AS j FROM (
            SELECT mo.id, mo.content, mo.canonical,
                   1 - (mo.embedding <=> p_emb) AS similarity, f.score AS rrf_score
            FROM fused f JOIN memory_objects mo ON mo.id = f.id
          ) x
        ),
        edges AS (
          SELECT jsonb_agg(jsonb_build_object('from_id', e.from_id, 'to_id', e.to_id, 'relation', e.relation)) AS j
          FROM memory_edges e
          WHERE e.from_id IN (SELECT id FROM fused) OR e.to_id IN (SELECT id FROM fused)
        )
        SELECT jsonb_build_object(
          'memories', coalesce((SELECT j FROM memories), '[]'::jsonb),
          'edges',    coalesce((SELECT j FROM edges),    '[]'::jsonb)
        );
      $fn$;
    `);
    const qEmb = randVec();
    const out = await db.query(`SELECT hybrid_query($1, $2::vector, $3::uuid) AS r`, [
      "vector search",
      qEmb,
      OWNER,
    ]);
    const env = out.rows[0].r;
    const okShape =
      env && Array.isArray(env.memories) && Array.isArray(env.edges) && env.memories.length > 0;
    record(
      "3. language sql hybrid_query {memories,edges}",
      okShape,
      `${env?.memories?.length ?? 0} memories, ${env?.edges?.length ?? 0} edges`
    );
  } catch (e) {
    record("3. language sql hybrid_query {memories,edges}", false, e.message);
  }

  // ── 4. latency, no HNSW ──────────────────────────────────────────────────────
  try {
    const qEmb = randVec();
    const runs = 20;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) {
      await db.query(`SELECT hybrid_query($1, $2::vector, $3::uuid)`, ["vector search", qEmb, OWNER]);
    }
    const avg = (performance.now() - t0) / runs;
    // personal scale target: comfortably interactive. Flag if > 150ms.
    record("4. hybrid_query latency (seq scan)", avg < 150, `avg ${avg.toFixed(1)} ms over ${runs} runs @ ${N_ROWS} rows`);
  } catch (e) {
    record("4. hybrid_query latency (seq scan)", false, e.message);
  }

  await db.close();

  // ── 5. data-dir lock (informational) ─────────────────────────────────────────
  const dir = join(tmpdir(), `memloom-spike-${Date.now()}`);
  try {
    const a = await PGlite.create({ dataDir: dir, extensions: { vector } });
    await a.exec(`CREATE TABLE t (id int);`);
    let secondOpened = false;
    try {
      const b = await PGlite.create({ dataDir: dir, extensions: { vector } });
      await b.query(`SELECT 1`);
      secondOpened = true;
      await b.close();
    } catch {
      secondOpened = false;
    }
    await a.close();
    // "PASS" here means PGLite REJECTED the second opener (safe by default).
    // If it allowed it, we ship our own lockfile in Phase 1 (D1); not a blocker.
    record(
      "5. data-dir lock (informational)",
      true,
      secondOpened
        ? "PGLite ALLOWED a 2nd opener → memloom must ship its own lockfile (D1 Phase 1)"
        : "PGLite REJECTED the 2nd opener → built-in guard exists"
    );
  } catch (e) {
    record("5. data-dir lock (informational)", true, `probe errored: ${e.message}`);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  // ── verdict ──────────────────────────────────────────────────────────────────
  const gating = results.filter((r) => /^[1-4]\./.test(r.name));
  const failed = gating.filter((r) => !r.ok);
  console.log("\n" + "─".repeat(60));
  if (failed.length === 0) {
    console.log("VERDICT: PGLite runs the memloom primitives. Embedded tier is REAL.");
    process.exit(0);
  } else {
    console.log(`VERDICT: ${failed.length} gating check(s) FAILED: embedded tier at risk.`);
    console.log("Fallback per plan: Docker Postgres becomes tier 1; PGLite a later milestone.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("spike crashed:", e);
  process.exit(1);
});
