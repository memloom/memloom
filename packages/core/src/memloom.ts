import { createHash, randomUUID } from "node:crypto";
import { chunkMarkdown, chunkOutline } from "./chunker.js";
import { type Candidate, classify } from "./dedup.js";
import type { MemoryEngine } from "./engine.js";
import { extractEntities } from "./entities.js";
import { extractFile } from "./extract.js";
import { migrate } from "./migrate.js";
import type { EmbeddingProvider, LLMProvider } from "./providers.js";
import { addEdge, deactivateEdgesTouching, markStale, reactivate } from "./resolve.js";
import type { StorageAdapter } from "./storage.js";
import type {
  Conflict,
  ConflictCandidate,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  DocumentChunks,
  Entity,
  Graph,
  GraphDocument,
  GraphEdge,
  GraphMemory,
  IndexResult,
  Memory,
  MemoryType,
  RecallOptions,
  ResolveDecision,
  SaveInput,
  SaveResult,
  UpdateInput,
  UpdateResult,
} from "./types.js";
import { toVectorLiteral } from "./vector.js";

// The fixed owner for the single-user embedded tier. Multi-tenant hosts pass a real
// ownerId per call; the column exists everywhere so the schema is sync/cloud-ready.
export const SENTINEL_OWNER = "00000000-0000-0000-0000-000000000000";

// Dedup only considers existing memories at least this similar to the incoming one.
const CANDIDATE_THRESHOLD = 0.5;
const CANDIDATE_LIMIT = 5;

// All config is injected — core never reads process.env or global state (build-plan
// architectural rule 2).
export interface MemloomConfig {
  storage: StorageAdapter;
  embedding: EmbeddingProvider;
  llm: LLMProvider;
  /** Run the belief pipeline (dedup + conflict detection) on save. Default true. */
  dedup?: boolean;
}

interface MemoryRow {
  id: string;
  owner_id: string;
  status: Memory["status"];
  memory_type: Memory["memoryType"];
  canonical: string | null;
  content: string;
  summary: string | null;
  root_id: string;
  version: number;
  asserted_at: string;
  created_at: string;
  similarity?: number;
  rrf_score?: number;
}

// A dedup candidate enriched with its lineage, so an "identical" restatement can append a new
// version to the right belief. Structurally a Candidate, so it still feeds classify().
interface CandidateRow extends Candidate {
  rootId: string;
  version: number;
}

interface RecallRow extends Partial<MemoryRow> {
  id: string;
  src: "memory" | "chunk";
  rrf_score: number;
  similarity: number;
  c_owner_id: string | null;
  c_content: string | null;
  c_heading_path: string | null;
  c_page: number | null;
  c_created_at: string | null;
  d_id: string | null;
  d_title: string | null;
  d_path: string | null;
}

function mapRecallRow(row: RecallRow): Memory {
  if (row.src === "chunk") {
    return {
      id: row.id,
      ownerId: row.c_owner_id ?? "",
      status: "active",
      memoryType: "context",
      canonical: null,
      content: row.c_content ?? "",
      summary: null,
      rootId: row.id,
      version: 1,
      assertedAt: row.c_created_at ?? "",
      createdAt: row.c_created_at ?? "",
      similarity: Number(row.similarity),
      rrfScore: Number(row.rrf_score),
      kind: "context",
      source: {
        documentId: row.d_id ?? "",
        title: row.d_title ?? "",
        path: row.d_path ?? "",
        headingPath: row.c_heading_path,
        page: row.c_page,
      },
    };
  }
  return { ...mapRow(row as MemoryRow), rrfScore: Number(row.rrf_score), kind: "memory" };
}

function mapRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    ownerId: row.owner_id,
    status: row.status,
    memoryType: row.memory_type,
    canonical: row.canonical,
    content: row.content,
    summary: row.summary,
    rootId: row.root_id,
    version: Number(row.version),
    assertedAt: row.asserted_at,
    createdAt: row.created_at,
    ...(row.similarity !== undefined ? { similarity: Number(row.similarity) } : {}),
    ...(row.rrf_score !== undefined ? { rrfScore: Number(row.rrf_score) } : {}),
  };
}

export class Memloom implements MemoryEngine {
  readonly #storage: StorageAdapter;
  readonly #embedding: EmbeddingProvider;
  readonly #llm: LLMProvider;
  readonly #dedup: boolean;

  constructor(config: MemloomConfig) {
    this.#storage = config.storage;
    this.#embedding = config.embedding;
    this.#llm = config.llm;
    this.#dedup = config.dedup ?? true;
  }

  /** The injected dependencies, exposed read-only for host wiring and tests. */
  get deps(): Readonly<Omit<MemloomConfig, "dedup">> {
    return { storage: this.#storage, embedding: this.#embedding, llm: this.#llm };
  }

  /** Run pending migrations. Idempotent; call once after constructing. */
  async init(): Promise<void> {
    await migrate(this.#storage, this.#embedding.dims);
    await this.#checkEmbeddingFingerprint();
  }

  // A store's vectors are only comparable to vectors from the same provider+model+dims. The
  // first init stamps the store; any later init with a different fingerprint is refused —
  // otherwise recall degrades silently (offline-embedded and cloud-embedded memories look
  // fine individually but never match each other).
  async #checkEmbeddingFingerprint(): Promise<void> {
    const current = this.#embedding.fingerprint;
    const rows = await this.#storage.query<{ value: string }>(
      "SELECT value FROM _memloom_meta WHERE key = 'embedding_fingerprint'",
    );
    const stored = rows[0]?.value;
    if (stored === undefined) {
      await this.#storage.query(
        `INSERT INTO _memloom_meta (key, value) VALUES ('embedding_fingerprint', $1)
         ON CONFLICT (key) DO NOTHING`,
        [current],
      );
      return;
    }
    if (stored !== current) {
      throw new Error(
        `this store's memories were embedded with "${stored}", but the engine is now configured ` +
          `with "${current}". Different embedding providers/models produce incompatible vector ` +
          "spaces, so recall would silently return garbage. Either restore the previous embedding " +
          "config, or start fresh by deleting the data directory.",
      );
    }
  }

  /**
   * Cheap liveness probe of the store. When a Postgres wire client (Drizzle Studio, psql) is
   * attached to the daemon it holds PGLite's exclusive lock and this queues — the server races
   * it against a timeout to fail fast instead of hanging every request.
   */
  async ping(): Promise<void> {
    await this.#storage.query("select 1");
  }

  /**
   * Ingest a file as context (any registered extractor's format): extract, chunk, embed,
   * store. Documents are
   * MIRRORS of files — no belief pipeline, no conflicts; re-adding a changed file replaces
   * its chunks in one transaction, and an unchanged file (same content hash) is a no-op.
   */
  async contextAdd(input: ContextAddInput): Promise<ContextAddResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const file = await extractFile(input.path, (bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );

    const existing = await this.#storage.query<{
      id: string;
      content_hash: string;
      chunk_count: number;
    }>(
      "SELECT id, content_hash, chunk_count FROM context_documents WHERE owner_id = $1 AND path = $2",
      [owner, input.path],
    );
    const prior = existing[0];
    if (prior && prior.content_hash === file.contentHash) {
      return {
        documentId: prior.id,
        outcome: "unchanged",
        title: file.title,
        chunks: prior.chunk_count,
      };
    }

    // The extractor declares its section strategy: markdown splits at headings, outline at
    // ALL-CAPS titles and numbered points — either way a chunk never starts mid-section and
    // carries a citable breadcrumb.
    const sectionize = file.chunker === "markdown" ? chunkMarkdown : chunkOutline;
    const chunks = file.units.flatMap((unit) =>
      sectionize(unit.text).map((c) => ({ ...c, page: unit.page })),
    );
    // Embed before the transaction — provider calls are slow and can fail; the store swap
    // below stays a short, all-or-nothing write.
    const embeddings =
      chunks.length > 0 ? await this.#embedding.embed(chunks.map((c) => c.content)) : [];

    return await this.#storage.tx(async (tx) => {
      let documentId: string;
      if (prior) {
        // Replace the prior chunks (and their mention edges) before re-inserting — see
        // #deleteDocumentChunks for why the edges can't ride a cascade.
        await this.#deleteDocumentChunks(tx, prior.id, owner);
        await tx.query(
          `UPDATE context_documents
           SET title = $2, kind = $3, content_hash = $4, chunk_count = $5, updated_at = now()
           WHERE id = $1`,
          [prior.id, file.title, file.kind, file.contentHash, chunks.length],
        );
        documentId = prior.id;
      } else {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO context_documents (owner_id, path, title, kind, content_hash, chunk_count)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [owner, input.path, file.title, file.kind, file.contentHash, chunks.length],
        );
        const row = inserted[0];
        if (!row) throw new Error("memloom: context document insert returned no id");
        documentId = row.id;
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const emb = embeddings[i];
        if (!chunk || !emb) throw new Error("memloom: embedding count mismatch during ingest");
        await tx.query(
          `INSERT INTO context_chunks (document_id, owner_id, chunk_index, content, heading_path, page, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
          [
            documentId,
            owner,
            i,
            chunk.content,
            chunk.headingPath,
            chunk.page,
            toVectorLiteral(emb),
          ],
        );
      }

      return {
        documentId,
        outcome: prior ? ("updated" as const) : ("added" as const),
        title: file.title,
        chunks: chunks.length,
      };
    });
  }

  async contextList(ownerId: string = SENTINEL_OWNER): Promise<ContextDocument[]> {
    const rows = await this.#storage.query<{
      id: string;
      path: string;
      title: string;
      kind: string;
      chunk_count: number;
      updated_at: string;
    }>(
      `SELECT id, path, title, kind, chunk_count, updated_at
       FROM context_documents WHERE owner_id = $1 ORDER BY updated_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      kind: r.kind,
      chunkCount: Number(r.chunk_count),
      updatedAt: r.updated_at,
    }));
  }

  /**
   * One document at chunk granularity: its chunks in order, plus their chunk -> entity
   * mention edges. The graph() rollup keeps documents to one node; this is the drill-down
   * the viewer fetches when a document node is expanded.
   */
  async contextChunks(
    documentId: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<DocumentChunks> {
    const doc = await this.#storage.query<{ id: string }>(
      "SELECT id FROM context_documents WHERE id = $1 AND owner_id = $2",
      [documentId, ownerId],
    );
    if (!doc[0]) throw new Error(`no context document ${documentId}`);

    const chunkRows = await this.#storage.query<{
      id: string;
      chunk_index: number;
      content: string;
      heading_path: string | null;
      page: number | null;
    }>(
      `SELECT id, chunk_index, content, heading_path, page
       FROM context_chunks WHERE document_id = $1 ORDER BY chunk_index`,
      [documentId],
    );
    const edgeRows = await this.#storage.query<{
      from_id: string;
      to_id: string;
      relation: string;
    }>(
      `SELECT e.from_id, e.to_id, e.relation
       FROM memory_edges e
       JOIN context_chunks cc ON cc.id = e.from_id
       WHERE cc.document_id = $1 AND e.relation = 'mention' AND e.active`,
      [documentId],
    );

    return {
      chunks: chunkRows.map((c) => ({
        id: c.id,
        chunkIndex: Number(c.chunk_index),
        content: c.content,
        headingPath: c.heading_path,
        page: c.page,
      })),
      edges: edgeRows.map((e) => ({ from: e.from_id, to: e.to_id, relation: e.relation })),
    };
  }

  // The single guarantee for the no-FK invariant: memory_edges has no foreign key to
  // context_chunks, so neither the document cascade nor a chunk delete ever cleans mention
  // edges — every chunk removal must clear the edges by hand. Delete a document's chunks ONLY
  // through here (mention edges first, then the chunks), so no call site has to remember it.
  // Entities are intentionally left: they may be mentioned by other documents.
  async #deleteDocumentChunks(
    tx: StorageAdapter,
    documentId: string,
    owner: string,
  ): Promise<void> {
    await tx.query(
      `DELETE FROM memory_edges
       WHERE owner_id = $2 AND from_id IN (
         SELECT id FROM context_chunks WHERE document_id = $1 AND owner_id = $2)`,
      [documentId, owner],
    );
    await tx.query("DELETE FROM context_chunks WHERE document_id = $1 AND owner_id = $2", [
      documentId,
      owner,
    ]);
  }

  async contextRemove(documentId: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      // Chunks + their mention edges go together (owner-scoped: this runs before the ownership
      // check on the document row itself). The document delete then removes only the doc row.
      await this.#deleteDocumentChunks(tx, documentId, ownerId);
      const deleted = await tx.query<{ id: string }>(
        "DELETE FROM context_documents WHERE id = $1 AND owner_id = $2 RETURNING id",
        [documentId, ownerId],
      );
      if (deleted.length === 0) throw new Error(`no context document ${documentId}`);
    });
  }

  /**
   * Save a memory. With dedup on (default), the belief pipeline runs: an exact or classified
   * duplicate is merged (nothing new stored), a contradiction keeps both memories active and
   * records a conflict for the owner to resolve, and anything else is added.
   */
  async save(input: SaveInput): Promise<SaveResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const [embedding] = await this.#embedding.embed([input.content]);
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const hash = createHash("sha256").update(input.content).digest("hex");

    if (!this.#dedup) {
      const id = await this.#insert(owner, input, embedding, hash);
      return { id, outcome: "added" };
    }

    // Exact duplicate — cheap short-circuit, no LLM needed.
    const exact = await this.#storage.query<{ id: string }>(
      "SELECT id FROM memory_objects WHERE owner_id = $1 AND status = 'active' AND content_hash = $2 LIMIT 1",
      [owner, hash],
    );
    if (exact[0]) return { id: exact[0].id, outcome: "merged" };

    const candidates = await this.#findCandidates(owner, embedding, hash);
    if (candidates.length === 0) {
      const id = await this.#insert(owner, input, embedding, hash);
      return { id, outcome: "added" };
    }

    const classifications = await classify(
      this.#llm,
      { canonical: input.canonical, content: input.content },
      candidates,
    );

    // A restatement of the same fact appends a new version to that belief's lineage (the prior
    // version goes stale). A verbatim re-save was already short-circuited above as "merged".
    const identical = classifications.find((c) => c.relation === "identical");
    if (identical) {
      const parent = candidates.find((c) => c.id === identical.candidateId);
      if (parent) {
        const childId = await this.#versionOf(owner, parent, input, embedding, hash);
        return { id: childId, outcome: "versioned", version: parent.version + 1 };
      }
    }

    const id = await this.#insert(owner, input, embedding, hash);

    const contradictions = classifications.filter((c) => c.relation === "contradictory");
    if (contradictions.length > 0) {
      const conflictCandidates: ConflictCandidate[] = contradictions.map((cl) => {
        const cand = candidates.find((c) => c.id === cl.candidateId);
        return {
          id: cl.candidateId,
          canonical: cand?.canonical ?? null,
          content: cand?.content ?? "",
          relation: cl.relation,
          reason: cl.reason,
        };
      });
      const conflictId = await this.#recordConflict(owner, id, input, conflictCandidates);
      return { id, outcome: "conflict", conflictId };
    }

    return { id, outcome: "added" };
  }

  /** All active memories, newest first. The browsing counterpart to query-driven recall. */
  async memories(ownerId: string = SENTINEL_OWNER): Promise<Memory[]> {
    const rows = await this.#storage.query<MemoryRow>(
      `SELECT id, owner_id, status, memory_type, canonical, content, summary,
              root_id, version, asserted_at, created_at
       FROM memory_objects
       WHERE owner_id = $1 AND status = 'active'
       ORDER BY created_at DESC`,
      [ownerId],
    );
    return rows.map(mapRow);
  }

  /**
   * The full version history of a belief: every version sharing this memory's root_id, newest
   * first (active current version plus all stale predecessors). Pass any version's id.
   */
  async history(memoryId: string, ownerId: string = SENTINEL_OWNER): Promise<Memory[]> {
    const [row] = await this.#storage.query<{ root_id: string }>(
      "SELECT root_id FROM memory_objects WHERE id = $1 AND owner_id = $2",
      [memoryId, ownerId],
    );
    if (!row) throw new Error(`memloom: no memory ${memoryId}`);
    const rows = await this.#storage.query<MemoryRow>(
      `SELECT id, owner_id, status, memory_type, canonical, content, summary,
              root_id, version, asserted_at, created_at
       FROM memory_objects
       WHERE owner_id = $1 AND root_id = $2
       ORDER BY version DESC`,
      [ownerId, row.root_id],
    );
    return rows.map(mapRow);
  }

  /**
   * Edit a belief: append a new current version with the given content and stale the prior one.
   * An explicit edit — unlike a save, it never runs the dedup/conflict funnel. Reversible in the
   * sense that the prior version stays queryable via history().
   */
  async update(input: UpdateInput): Promise<UpdateResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const [parent] = await this.#storage.query<{
      id: string;
      root_id: string;
      version: number;
      memory_type: MemoryType;
    }>(
      "SELECT id, root_id, version, memory_type FROM memory_objects WHERE id = $1 AND owner_id = $2 AND status = 'active'",
      [input.id, owner],
    );
    if (!parent) throw new Error(`memloom: no active memory ${input.id}`);
    const [embedding] = await this.#embedding.embed([input.content]);
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const hash = createHash("sha256").update(input.content).digest("hex");
    const childId = await this.#versionOf(
      owner,
      { id: parent.id, rootId: parent.root_id, version: Number(parent.version) },
      {
        content: input.content,
        ...(input.canonical ? { canonical: input.canonical } : {}),
        memoryType: parent.memory_type,
      },
      embedding,
      hash,
    );
    return { id: childId, rootId: parent.root_id, version: Number(parent.version) + 1 };
  }

  /**
   * Recall active memories, ranked by hybrid retrieval: vector (meaning) and keyword (exact)
   * arms fused with reciprocal-rank fusion. `similarity` is the cosine signal alone;
   * `rrfScore` is the fused rank a result should be ordered by. Results arrive fused-order.
   */
  async recall(query: string, opts: RecallOptions = {}): Promise<Memory[]> {
    const owner = opts.ownerId ?? SENTINEL_OWNER;
    const limit = opts.limit ?? 10;
    const [embedding] = await this.#embedding.embed([query]);
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const qvec = toVectorLiteral(embedding);

    // The fuse ranks memories and context chunks together; join whichever table each id
    // came from and map to one result shape (chunks carry a source for provenance).
    const rows = await this.#storage.query<RecallRow>(
      `SELECT f.id, f.src, f.rrf_score,
              1 - (COALESCE(mo.embedding, cc.embedding) <=> $1::vector) AS similarity,
              mo.owner_id, mo.status, mo.memory_type, mo.canonical, mo.content,
              mo.summary, mo.root_id, mo.version, mo.asserted_at, mo.created_at,
              cc.owner_id AS c_owner_id, cc.content AS c_content,
              cc.heading_path AS c_heading_path, cc.page AS c_page,
              cc.created_at AS c_created_at,
              cd.id AS d_id, cd.title AS d_title, cd.path AS d_path
       FROM memloom_fuse($2, $1::vector, $3, $4) f
       LEFT JOIN memory_objects mo ON f.src = 'memory' AND mo.id = f.id
       LEFT JOIN context_chunks cc ON f.src = 'chunk' AND cc.id = f.id
       LEFT JOIN context_documents cd ON cd.id = cc.document_id
       ORDER BY f.rrf_score DESC`,
      [qvec, query, owner, limit],
    );
    return rows.map(mapRecallRow);
  }

  /**
   * Index unprocessed memories AND context chunks: extract entities, resolve them, and link
   * each source to its entities with a 'mention' edge in the shared edge table. Idempotent —
   * only touches rows not yet indexed. Chunks stay outside the belief pipeline; their edges
   * are how context connects to memory (rolled up per document in graph()). One LLM call per
   * row, so a large PDF makes indexing proportionally slower.
   */
  async index(ownerId: string = SENTINEL_OWNER): Promise<IndexResult> {
    const pending = await this.#storage.query<{ id: string; content: string }>(
      `SELECT id, content FROM memory_objects
       WHERE owner_id = $1 AND status = 'active' AND indexed_at IS NULL
       ORDER BY created_at`,
      [ownerId],
    );
    for (const memory of pending) {
      await this.#linkEntities(ownerId, memory.id, memory.content);
      await this.#storage.query("UPDATE memory_objects SET indexed_at = now() WHERE id = $1", [
        memory.id,
      ]);
    }

    const pendingChunks = await this.#storage.query<{ id: string; content: string }>(
      `SELECT id, content FROM context_chunks
       WHERE owner_id = $1 AND indexed_at IS NULL
       ORDER BY created_at, chunk_index`,
      [ownerId],
    );
    for (const chunk of pendingChunks) {
      await this.#linkEntities(ownerId, chunk.id, chunk.content);
      await this.#storage.query("UPDATE context_chunks SET indexed_at = now() WHERE id = $1", [
        chunk.id,
      ]);
    }

    return { indexed: pending.length, chunksIndexed: pendingChunks.length };
  }

  /**
   * The memory graph for the owner: one graph, two granularities. Active memories, entities,
   * and context documents as nodes. Chunk-level mention edges never leave the store — they
   * roll up to one weighted document -> entity edge, so a 300-chunk PDF is one node, not a
   * hairball (Zep/Cognee link raw content at fine grain but nobody renders chunks).
   */
  async graph(ownerId: string = SENTINEL_OWNER): Promise<Graph> {
    const memoryRows = await this.#storage.query<{
      id: string;
      canonical: string | null;
      content: string;
      memory_type: GraphMemory["memoryType"];
    }>(
      `SELECT id, canonical, content, memory_type FROM memory_objects
       WHERE owner_id = $1 AND status = 'active'`,
      [ownerId],
    );
    const entityRows = await this.#storage.query<{ id: string; name: string; entity_type: string }>(
      "SELECT id, name, entity_type FROM memory_entities WHERE owner_id = $1",
      [ownerId],
    );
    const documents = await this.#storage.query<GraphDocument>(
      "SELECT id, title, path FROM context_documents WHERE owner_id = $1",
      [ownerId],
    );
    // Memory-anchored edges only — chunk edges are represented by the rollup below.
    const edgeRows = await this.#storage.query<{
      from_id: string;
      to_id: string;
      relation: string;
    }>(
      `SELECT e.from_id, e.to_id, e.relation
       FROM memory_edges e
       JOIN memory_objects mo ON mo.id = e.from_id
       WHERE e.owner_id = $1 AND e.active`,
      [ownerId],
    );
    const docEdgeRows = await this.#storage.query<{
      from_id: string;
      to_id: string;
      weight: number;
    }>(
      `SELECT cc.document_id AS from_id, e.to_id, count(*)::int AS weight
       FROM memory_edges e
       JOIN context_chunks cc ON cc.id = e.from_id
       WHERE e.owner_id = $1 AND e.relation = 'mention' AND e.active
       GROUP BY cc.document_id, e.to_id`,
      [ownerId],
    );

    const memories: GraphMemory[] = memoryRows.map((m) => ({
      id: m.id,
      canonical: m.canonical,
      content: m.content,
      memoryType: m.memory_type,
    }));
    const entities: Entity[] = entityRows.map((e) => ({
      id: e.id,
      name: e.name,
      entityType: e.entity_type,
    }));
    const edges: GraphEdge[] = [
      ...edgeRows.map((e) => ({ from: e.from_id, to: e.to_id, relation: e.relation })),
      ...docEdgeRows.map((e) => ({
        from: e.from_id,
        to: e.to_id,
        relation: "mention",
        weight: Number(e.weight),
      })),
    ];
    return { memories, entities, documents, edges };
  }

  /** Pending conflicts for the owner, newest first. */
  async conflicts(ownerId: string = SENTINEL_OWNER): Promise<Conflict[]> {
    const rows = await this.#storage.query<{
      id: string;
      incoming_id: string;
      incoming_canonical: string | null;
      incoming_content: string;
      candidates: ConflictCandidate[];
      created_at: string;
    }>(
      `SELECT id, incoming_id, incoming_canonical, incoming_content, candidates, created_at
       FROM memory_dedup_decisions
       WHERE owner_id = $1 AND action = 'conflict' AND resolution_action IS NULL
       ORDER BY created_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      incoming: { id: r.incoming_id, canonical: r.incoming_canonical, content: r.incoming_content },
      candidates: r.candidates,
    }));
  }

  /** Resolve a pending conflict. Every action is reversible via revertConflict. */
  async resolveConflict(conflictId: string, decision: ResolveDecision): Promise<void> {
    const [row] = await this.#storage.query<{
      owner_id: string;
      incoming_id: string;
      candidates: ConflictCandidate[];
    }>("SELECT owner_id, incoming_id, candidates FROM memory_dedup_decisions WHERE id = $1", [
      conflictId,
    ]);
    if (!row) throw new Error(`memloom: no conflict ${conflictId}`);
    const owner = row.owner_id;
    const incoming = row.incoming_id;
    const candidateIds = row.candidates.map((c) => c.id);

    switch (decision.action) {
      case "keep_new": {
        // The incoming belief continues the (primary) existing fact's lineage — a resolved
        // contradiction is a version step, so it shows up in that belief's history().
        const primary = candidateIds[0];
        if (primary) {
          const lin = await this.#lineageOf(primary);
          if (lin) await this.#reparent(incoming, lin.rootId, lin.version + 1);
        }
        await markStale(this.#storage, candidateIds);
        for (const loser of candidateIds)
          await addEdge(this.#storage, owner, incoming, loser, "replaces");
        await this.#attachResolution(conflictId, "supersede", incoming, candidateIds);
        break;
      }
      case "keep_existing": {
        const winner = decision.candidateId;
        await markStale(this.#storage, [incoming]);
        await addEdge(this.#storage, owner, winner, incoming, "replaces");
        await this.#attachResolution(conflictId, "supersede", winner, [incoming]);
        break;
      }
      case "keep_both": {
        for (const cand of candidateIds)
          await addEdge(this.#storage, owner, incoming, cand, "distinct");
        await this.#attachResolution(conflictId, "keep_both", null, []);
        break;
      }
      case "merge": {
        const [embedding] = await this.#embedding.embed([decision.content]);
        if (!embedding) throw new Error("memloom: embedding provider returned no vector");
        const hash = createHash("sha256").update(decision.content).digest("hex");
        const winner = await this.#insert(
          owner,
          {
            content: decision.content,
            ...(decision.canonical ? { canonical: decision.canonical } : {}),
          },
          embedding,
          hash,
        );
        // The merged belief continues the primary existing fact's lineage.
        const mergePrimary = candidateIds[0] ?? incoming;
        const mergeLin = await this.#lineageOf(mergePrimary);
        if (mergeLin) await this.#reparent(winner, mergeLin.rootId, mergeLin.version + 1);
        const losers = [incoming, ...candidateIds];
        await markStale(this.#storage, losers);
        for (const loser of losers) await addEdge(this.#storage, owner, winner, loser, "replaces");
        await this.#attachResolution(conflictId, "merge", winner, losers);
        break;
      }
    }
  }

  /** Undo a resolution: restore staled memories, deactivate the edges it created, re-queue it. */
  async revertConflict(conflictId: string): Promise<void> {
    const [row] = await this.#storage.query<{
      owner_id: string;
      incoming_id: string;
      candidates: ConflictCandidate[];
      resolution_action: string | null;
      resolution_winner_id: string | null;
      resolution_loser_ids: string[] | null;
    }>(
      `SELECT owner_id, incoming_id, candidates, resolution_action, resolution_winner_id, resolution_loser_ids
       FROM memory_dedup_decisions WHERE id = $1`,
      [conflictId],
    );
    if (!row) throw new Error(`memloom: no conflict ${conflictId}`);
    if (!row.resolution_action) return; // already pending

    const owner = row.owner_id;
    const candidateIds = row.candidates.map((c) => c.id);
    const losers = row.resolution_loser_ids ?? [];

    switch (row.resolution_action) {
      case "supersede": {
        await reactivate(this.#storage, losers);
        await deactivateEdgesTouching(this.#storage, owner, "replaces", losers);
        // keep_new re-parented the incoming onto the losers' lineage; restore it to its own root.
        if (row.resolution_winner_id === row.incoming_id) {
          await this.#reparent(row.incoming_id, row.incoming_id, 1);
        }
        break;
      }
      case "keep_both": {
        await deactivateEdgesTouching(this.#storage, owner, "distinct", [
          row.incoming_id,
          ...candidateIds,
        ]);
        break;
      }
      case "merge": {
        await reactivate(this.#storage, [row.incoming_id, ...candidateIds]);
        if (row.resolution_winner_id) {
          await markStale(this.#storage, [row.resolution_winner_id]);
          await deactivateEdgesTouching(this.#storage, owner, "replaces", [
            row.resolution_winner_id,
          ]);
        }
        break;
      }
    }

    await this.#storage.query(
      `UPDATE memory_dedup_decisions
       SET resolution_action = NULL, resolution_winner_id = NULL,
           resolution_loser_ids = NULL, resolved_at = NULL
       WHERE id = $1`,
      [conflictId],
    );
  }

  // --- internals ---

  // Insert a memory. Without `lineage` it starts a new belief (root_id = its own id, version 1);
  // with `lineage` it's the next version of an existing belief. The id is generated app-side so
  // a new root can set root_id = id atomically.
  async #insert(
    owner: string,
    input: { content: string; canonical?: string; memoryType?: MemoryType },
    embedding: number[],
    hash: string,
    lineage?: { rootId: string; version: number },
  ): Promise<string> {
    const id = randomUUID();
    const rootId = lineage?.rootId ?? id;
    const version = lineage?.version ?? 1;
    const rows = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_objects
         (id, owner_id, root_id, version, memory_type, canonical, content, content_hash, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
       RETURNING id`,
      [
        id,
        owner,
        rootId,
        version,
        input.memoryType ?? "fact",
        input.canonical ?? null,
        input.content,
        hash,
        toVectorLiteral(embedding),
      ],
    );
    const rid = rows[0]?.id;
    if (!rid) throw new Error("memloom: insert returned no id");
    return rid;
  }

  // Append a new version to a belief: stale the parent, insert the child sharing the parent's
  // root with version + 1, and link them child -> parent with a 'replaces' edge. Returns the
  // new current version's id.
  async #versionOf(
    owner: string,
    parent: { id: string; rootId: string; version: number },
    input: { content: string; canonical?: string; memoryType?: MemoryType },
    embedding: number[],
    hash: string,
  ): Promise<string> {
    const childId = await this.#insert(owner, input, embedding, hash, {
      rootId: parent.rootId,
      version: parent.version + 1,
    });
    await markStale(this.#storage, [parent.id]);
    await addEdge(this.#storage, owner, childId, parent.id, "replaces");
    return childId;
  }

  // Move a memory onto a lineage (used when a resolved conflict continues an existing belief).
  async #reparent(id: string, rootId: string, version: number): Promise<void> {
    await this.#storage.query(
      "UPDATE memory_objects SET root_id = $2, version = $3, updated_at = now() WHERE id = $1",
      [id, rootId, version],
    );
  }

  // The current root_id + version of a memory, or null if it's gone.
  async #lineageOf(id: string): Promise<{ rootId: string; version: number } | null> {
    const [row] = await this.#storage.query<{ root_id: string; version: number }>(
      "SELECT root_id, version FROM memory_objects WHERE id = $1",
      [id],
    );
    return row ? { rootId: row.root_id, version: Number(row.version) } : null;
  }

  // Extract entities from one source (memory or context chunk) and link it to each with a
  // 'mention' edge. The edge table has no FKs, so both node kinds share it.
  async #linkEntities(owner: string, sourceId: string, content: string): Promise<void> {
    const entities = await extractEntities(this.#llm, content);
    for (const entity of entities) {
      const entityId = await this.#resolveEntity(owner, entity.name, entity.type);
      await addEdge(this.#storage, owner, sourceId, entityId, "mention");
    }
  }

  async #resolveEntity(owner: string, name: string, type: string): Promise<string> {
    const existing = await this.#storage.query<{ id: string }>(
      "SELECT id FROM memory_entities WHERE owner_id = $1 AND lower(name) = lower($2) AND entity_type = $3 LIMIT 1",
      [owner, name, type],
    );
    if (existing[0]) return existing[0].id;
    const [embedding] = await this.#embedding.embed([name]);
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const [row] = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_entities (owner_id, name, entity_type, embedding)
       VALUES ($1, $2, $3, $4::vector) RETURNING id`,
      [owner, name, type, toVectorLiteral(embedding)],
    );
    if (!row) throw new Error("memloom: failed to insert entity");
    return row.id;
  }

  async #findCandidates(owner: string, embedding: number[], hash: string): Promise<CandidateRow[]> {
    const rows = await this.#storage.query<{
      id: string;
      canonical: string | null;
      content: string;
      root_id: string;
      version: number;
      similarity: number;
    }>(
      `SELECT id, canonical, content, root_id, version, 1 - (embedding <=> $1::vector) AS similarity
       FROM memory_objects
       WHERE owner_id = $2 AND status = 'active' AND embedding IS NOT NULL AND content_hash <> $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [toVectorLiteral(embedding), owner, hash, CANDIDATE_LIMIT],
    );
    return rows
      .map((r) => ({
        id: r.id,
        canonical: r.canonical,
        content: r.content,
        rootId: r.root_id,
        version: Number(r.version),
        similarity: Number(r.similarity),
      }))
      .filter((r) => r.similarity >= CANDIDATE_THRESHOLD);
  }

  async #recordConflict(
    owner: string,
    incomingId: string,
    input: SaveInput,
    candidates: ConflictCandidate[],
  ): Promise<string> {
    const [row] = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_dedup_decisions
         (owner_id, action, incoming_id, incoming_canonical, incoming_content, candidates)
       VALUES ($1, 'conflict', $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [owner, incomingId, input.canonical ?? null, input.content, JSON.stringify(candidates)],
    );
    if (!row) throw new Error("memloom: failed to record conflict");
    return row.id;
  }

  async #attachResolution(
    conflictId: string,
    action: "supersede" | "keep_both" | "merge",
    winnerId: string | null,
    loserIds: string[],
  ): Promise<void> {
    await this.#storage.query(
      `UPDATE memory_dedup_decisions
       SET resolution_action = $2, resolution_winner_id = $3,
           resolution_loser_ids = $4::jsonb, resolved_at = now()
       WHERE id = $1`,
      [conflictId, action, winnerId, JSON.stringify(loserIds)],
    );
  }
}
