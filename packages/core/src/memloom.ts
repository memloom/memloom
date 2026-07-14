import { createHash, randomUUID } from "node:crypto";
import { type AssistantEvent, runAssistantTurn } from "./assistant.js";
import { chunkMarkdown, chunkOutline } from "./chunker.js";
import { type Candidate, classify } from "./dedup.js";
import type { MemoryEngine } from "./engine.js";
import { type ExtractionContext, entityNameKey, extractGraph, isMathDense } from "./entities.js";
import { type ExtractedFile, extractBytes, extractFile } from "./extract.js";
import { migrate } from "./migrate.js";
import { type EmbeddingProvider, isChatProvider, type LLMProvider } from "./providers.js";
import {
  addEdge,
  addEdgeIfAbsent,
  deactivateEdgesTouching,
  markStale,
  reactivate,
} from "./resolve.js";
import {
  type ActiveSchema,
  EDGE_RELATIONS,
  ENTITY_TYPES,
  normalizeSchemaName,
  PREDICATES,
  PROPOSAL_MIN_OCCURRENCES,
  type SchemaEntry,
  type SchemaInfo,
  type SchemaKind,
} from "./schema.js";
import type { StorageAdapter } from "./storage.js";
import type {
  AssistantChatResult,
  AssistantMessage,
  AssistantSession,
  AssistantSessionHit,
  AssistantSource,
  Conflict,
  ConflictCandidate,
  ContextAddInput,
  ContextAddResult,
  ContextAttachInput,
  ContextAttachResult,
  ContextDocument,
  DocumentChunks,
  Entity,
  EntityDetail,
  Graph,
  GraphDocument,
  GraphEdge,
  GraphMemory,
  IndexProgressEvent,
  IndexResult,
  IndexRun,
  IndexRunEvent,
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
    return this.#ingestDocument(owner, input.path, file, null);
  }

  /**
   * Attach an uploaded file to one assistant chat: the same extract/chunk/embed pipeline
   * as contextAdd, but the document and its chunks carry the session id, so only that
   * chat's recall sees them and deleting the chat deletes them. No file touches disk —
   * the synthetic attachment:// path exists only to key the UNIQUE(owner, path) dedup
   * (re-attaching the same bytes to the same chat is a no-op).
   */
  async contextAttach(input: ContextAttachInput): Promise<ContextAttachResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const file = await extractBytes(input.bytes, input.filename, (bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );

    let sessionId = input.sessionId;
    if (sessionId) {
      const found = await this.#storage.query(
        "SELECT id FROM assistant_sessions WHERE owner_id = $1 AND id = $2",
        [owner, sessionId],
      );
      if (found.length === 0) throw new Error(`no assistant session ${sessionId}`);
    } else {
      // Attach-before-first-message: the session exists from the attach on. It keeps the
      // 'New chat' default title; assistantChat retitles it from the first message.
      const [row] = await this.#storage.query<{ id: string }>(
        "INSERT INTO assistant_sessions (owner_id) VALUES ($1) RETURNING id",
        [owner],
      );
      if (!row) throw new Error("memloom: could not create assistant session");
      sessionId = row.id;
    }

    const path = `attachment://${sessionId}/${input.filename}`;
    const result = await this.#ingestDocument(owner, path, file, sessionId);
    return { ...result, sessionId };
  }

  /**
   * Ingest an uploaded file's bytes as a GLOBAL document — the browser file dialog gives
   * bytes, never disk paths. Provenance is upload://<filename>, so re-uploading the same
   * name replaces it (hash short-circuit applies); there is no disk file to "open".
   * Unlike contextAttach, the result is a first-class document: listed, graphed, indexed.
   */
  async contextUpload(input: {
    filename: string;
    bytes: Uint8Array;
    ownerId?: string;
  }): Promise<ContextAddResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const file = await extractBytes(input.bytes, input.filename, (bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );
    return this.#ingestDocument(owner, `upload://${input.filename}`, file, null);
  }

  /** The files attached to one assistant chat, newest first. */
  async sessionAttachments(
    sessionId: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<ContextDocument[]> {
    const rows = await this.#storage.query<{
      id: string;
      path: string;
      title: string;
      kind: string;
      chunk_count: number;
      updated_at: string;
    }>(
      `SELECT id, path, title, kind, chunk_count, updated_at
       FROM context_documents WHERE owner_id = $1 AND session_id = $2 ORDER BY updated_at DESC`,
      [ownerId, sessionId],
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

  /** Shared ingest: hash short-circuit, replace-or-insert document, insert chunks. */
  async #ingestDocument(
    owner: string,
    path: string,
    file: ExtractedFile,
    sessionId: string | null,
  ): Promise<ContextAddResult> {
    const existing = await this.#storage.query<{
      id: string;
      content_hash: string;
      chunk_count: number;
    }>(
      "SELECT id, content_hash, chunk_count FROM context_documents WHERE owner_id = $1 AND path = $2",
      [owner, path],
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
          `INSERT INTO context_documents (owner_id, path, title, kind, content_hash, chunk_count, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [owner, path, file.title, file.kind, file.contentHash, chunks.length, sessionId],
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
          `INSERT INTO context_chunks (document_id, owner_id, chunk_index, content, heading_path, page, embedding, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
          [
            documentId,
            owner,
            i,
            chunk.content,
            chunk.headingPath,
            chunk.page,
            toVectorLiteral(emb),
            sessionId,
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
       FROM context_documents WHERE owner_id = $1 AND session_id IS NULL
       ORDER BY updated_at DESC`,
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
    // Relationships STATED BY these chunks go too (a document is a mirror; its claims
    // leave with it) — entity nodes themselves intentionally survive.
    await tx.query(
      `DELETE FROM memory_edges
       WHERE owner_id = $2 AND source_id IN (
         SELECT id FROM context_chunks WHERE document_id = $1 AND owner_id = $2)`,
      [documentId, owner],
    );
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

    // The temporal arm: a calendar-day filter over memories, ranked by similarity.
    // Deliberately outside the fuse (which has no notion of time) — the day IS the filter,
    // similarity only orders within it. Context chunks are excluded by construction.
    if (opts.assertedOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.assertedOn)) {
        throw new Error(`memloom: assertedOn must be YYYY-MM-DD, got "${opts.assertedOn}"`);
      }
      const rows = await this.#storage.query<MemoryRow>(
        `SELECT id, owner_id, status, memory_type, canonical, content, summary, root_id,
                version, asserted_at, created_at,
                1 - (embedding <=> $1::vector) AS similarity
         FROM memory_objects
         WHERE owner_id = $2 AND status = 'active' AND asserted_at::date = $3::date
         ORDER BY similarity DESC LIMIT $4`,
        [qvec, owner, opts.assertedOn, limit],
      );
      return rows.map((row) => ({ ...mapRow(row), kind: "memory" as const }));
    }

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
       FROM memloom_fuse($2, $1::vector, $3, $4, p_session => $5) f
       LEFT JOIN memory_objects mo ON f.src = 'memory' AND mo.id = f.id
       LEFT JOIN context_chunks cc ON f.src = 'chunk' AND cc.id = f.id
       LEFT JOIN context_documents cd ON cd.id = cc.document_id
       ORDER BY f.rrf_score DESC`,
      [qvec, query, owner, limit, opts.sessionId ?? null],
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
  async index(
    ownerId: string = SENTINEL_OWNER,
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    return this.#runIndex(ownerId, "index", onProgress);
  }

  // Run ids this process is executing right now. Any DB row still 'running' that is NOT in
  // here belongs to a process that died mid-run — reconciled to 'interrupted' on read/start.
  #activeRuns = new Set<string>();

  async #reconcileInterruptedRuns(ownerId: string): Promise<void> {
    const live = [...this.#activeRuns];
    await this.#storage.query(
      `UPDATE memory_index_runs SET status = 'interrupted', finished_at = now()
       WHERE owner_id = $1 AND status = 'running'${
         live.length > 0 ? ` AND id NOT IN (${live.map((_, i) => `$${i + 2}`).join(", ")})` : ""
}`,
      [ownerId, ...live],
    );
  }

  /**
   * The shared index pass behind index() and reindex(): processes every unindexed memory
   * and chunk, and records the pass as a session — one memory_index_runs row plus one
   * memory_index_events row per item — so progress survives the viewer navigating away
   * and CLI runs show up in the Console. A failing item is logged and left unindexed
   * (the next run retries it); the run finishes 'warning' instead of dying mid-batch.
   */
  async #runIndex(
    ownerId: string,
    trigger: "index" | "rebuild",
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    const snippet = (text: string) => (text.length > 64 ? `${text.slice(0, 61)}...` : text);
    // The vocabulary is loaded ONCE per run (registry rows: system + user tiers, active),
    // then injected into every extraction — one query, not one per item.
    const schema = await this.#activeSchema(ownerId);

    const pending = await this.#storage.query<{ id: string; content: string }>(
      `SELECT id, content FROM memory_objects
       WHERE owner_id = $1 AND status = 'active' AND indexed_at IS NULL
       ORDER BY created_at`,
      [ownerId],
    );
    const pendingChunks = await this.#storage.query<{
      id: string;
      content: string;
      heading_path: string | null;
      chunk_index: number;
      doc_title: string;
    }>(
      `SELECT cc.id, cc.content, cc.heading_path, cc.chunk_index, cd.title AS doc_title
       FROM context_chunks cc
       JOIN context_documents cd ON cd.id = cc.document_id
       WHERE cc.owner_id = $1 AND cc.indexed_at IS NULL AND cc.session_id IS NULL
       ORDER BY cc.created_at, cc.chunk_index`,
      [ownerId],
    );
    // Nothing pending: no session row — an empty run every time someone clicks "index"
    // would drown the real history.
    if (pending.length + pendingChunks.length === 0) return { indexed: 0, chunksIndexed: 0 };

    await this.#reconcileInterruptedRuns(ownerId);
    const [run] = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_index_runs (owner_id, trigger, batch_size)
       VALUES ($1, $2, $3) RETURNING id`,
      [ownerId, trigger, pending.length + pendingChunks.length],
    );
    if (!run) throw new Error("memloom: could not create index run");
    const runId = run.id;
    this.#activeRuns.add(runId);

    const totals = { memories: 0, chunks: 0, failed: 0, entities: 0, relations: 0 };
    const logEvent = async (
      level: "info" | "success" | "warning" | "error",
      message: string,
      itemId: string,
      metadata: Record<string, unknown>,
    ) => {
      await this.#storage.query(
        `INSERT INTO memory_index_events (owner_id, run_id, level, message, item_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ownerId, runId, level, message, itemId, JSON.stringify(metadata)],
      );
    };
    // Counters sync per item, not per run, so an interrupted run's row still tells the truth.
    const syncTotals = async () => {
      await this.#storage.query(
        `UPDATE memory_index_runs
         SET memories_indexed = $2, chunks_indexed = $3, items_failed = $4,
             entities_linked = $5, relations_created = $6
         WHERE id = $1`,
        [runId, totals.memories, totals.chunks, totals.failed, totals.entities, totals.relations],
      );
    };
    const outcomeOf = (linked: { entities: string[]; relationships: number }) =>
      linked.entities.length === 0
        ? "no entities"
        : linked.entities.join(", ") +
          (linked.relationships > 0
            ? ` (+${linked.relationships} ${linked.relationships === 1 ? "relationship" : "relationships"})`
            : "");

    try {
      let memoryPosition = 0;
      for (const memory of pending) {
        memoryPosition += 1;
        const base = {
          kind: "memory" as const,
          id: memory.id,
          label: snippet(memory.content),
          index: memoryPosition,
          total: pending.length,
        };
        const prefix = `[${base.index}/${base.total}] memory ${base.label}`;
        try {
          const linked = await this.#linkGraph(ownerId, memory.id, memory.content, schema);
          await this.#storage.query("UPDATE memory_objects SET indexed_at = now() WHERE id = $1", [
            memory.id,
          ]);
          totals.memories += 1;
          totals.entities += linked.entities.length;
          totals.relations += linked.relationships;
          await logEvent(
            linked.entities.length > 0 ? "success" : "info",
            `${prefix} → ${outcomeOf(linked)}`,
            memory.id,
            { entities: linked.entities, relationships: linked.relationships },
          );
          await syncTotals();
          onProgress?.({ ...base, entities: linked.entities, relationships: linked.relationships });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          totals.failed += 1;
          await logEvent("error", `${prefix} → failed: ${message}`, memory.id, { error: message });
          await syncTotals();
          onProgress?.({ ...base, entities: [], error: message });
        }
      }

      let chunkPosition = 0;
      for (const chunk of pendingChunks) {
        chunkPosition += 1;
        const base = {
          kind: "chunk" as const,
          id: chunk.id,
          label: snippet(
            `${chunk.doc_title} › ${chunk.heading_path ?? `#${Number(chunk.chunk_index) + 1}`}`,
          ),
          index: chunkPosition,
          total: pendingChunks.length,
        };
        const prefix = `[${base.index}/${base.total}] chunk ${base.label}`;
        try {
          // Formula-dominated chunks have nothing extractable — skip the LLM call entirely
          // (a math exercise sheet would otherwise become a graph of equations).
          const skipped = isMathDense(chunk.content);
          const linked = skipped
            ? { entities: [], relationships: 0 }
            : await this.#linkGraph(ownerId, chunk.id, chunk.content, schema, {
                docTitle: chunk.doc_title,
              });
          await this.#storage.query("UPDATE context_chunks SET indexed_at = now() WHERE id = $1", [
            chunk.id,
          ]);
          totals.chunks += 1;
          totals.entities += linked.entities.length;
          totals.relations += linked.relationships;
          await logEvent(
            skipped ? "info" : linked.entities.length > 0 ? "success" : "info",
            `${prefix} → ${skipped ? "skipped (math-dense)" : outcomeOf(linked)}`,
            chunk.id,
            skipped
              ? { skipped: "math-dense" }
              : { entities: linked.entities, relationships: linked.relationships },
          );
          await syncTotals();
          onProgress?.({
            ...base,
            entities: linked.entities,
            relationships: linked.relationships,
            ...(skipped ? { skipped: "math-dense" as const } : {}),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          totals.failed += 1;
          await logEvent("error", `${prefix} → failed: ${message}`, chunk.id, { error: message });
          await syncTotals();
          onProgress?.({ ...base, entities: [], error: message });
        }
      }

      const status =
        totals.failed === 0 ? "success" : totals.memories + totals.chunks > 0 ? "warning" : "error";
      await this.#storage.query(
        "UPDATE memory_index_runs SET status = $2, finished_at = now() WHERE id = $1",
        [runId, status],
      );
    } catch (err) {
      // Something outside the per-item guards (storage failure, schema query) — finalize
      // the session honestly before propagating.
      await this.#storage
        .query("UPDATE memory_index_runs SET status = 'error', finished_at = now() WHERE id = $1", [
          runId,
        ])
        .catch(() => {});
      throw err;
    } finally {
      this.#activeRuns.delete(runId);
    }

    return { indexed: totals.memories, chunksIndexed: totals.chunks };
  }

  /** Index sessions, newest first — the Console's persistent log. Reconciles dead runs. */
  async listIndexRuns(ownerId: string = SENTINEL_OWNER, limit = 100): Promise<IndexRun[]> {
    await this.#reconcileInterruptedRuns(ownerId);
    const rows = await this.#storage.query<{
      id: string;
      trigger: IndexRun["trigger"];
      status: IndexRun["status"];
      batch_size: number;
      memories_indexed: number;
      chunks_indexed: number;
      items_failed: number;
      entities_linked: number;
      relations_created: number;
      started_at: string;
      finished_at: string | null;
    }>(
      `SELECT id, trigger, status, batch_size, memories_indexed, chunks_indexed, items_failed,
              entities_linked, relations_created, started_at, finished_at
       FROM memory_index_runs WHERE owner_id = $1
       ORDER BY started_at DESC LIMIT $2`,
      [ownerId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      batchSize: Number(r.batch_size),
      memoriesIndexed: Number(r.memories_indexed),
      chunksIndexed: Number(r.chunks_indexed),
      itemsFailed: Number(r.items_failed),
      entitiesLinked: Number(r.entities_linked),
      relationsCreated: Number(r.relations_created),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  /** The per-item log lines of one session, oldest first (reads like a terminal). */
  async indexRunEvents(runId: string, ownerId: string = SENTINEL_OWNER): Promise<IndexRunEvent[]> {
    const rows = await this.#storage.query<{
      id: string;
      level: IndexRunEvent["level"];
      message: string;
      item_id: string | null;
      metadata: unknown;
      created_at: string;
    }>(
      `SELECT id, level, message, item_id, metadata, created_at
       FROM memory_index_events WHERE owner_id = $1 AND run_id = $2
       ORDER BY created_at, id`,
      [ownerId, runId],
    );
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      message: r.message,
      itemId: r.item_id,
      // jsonb comes back parsed from pg/PGLite, but tolerate string-returning adapters.
      metadata: (typeof r.metadata === "string"
        ? JSON.parse(r.metadata)
        : (r.metadata ?? {})) as IndexRunEvent["metadata"],
      createdAt: r.created_at,
    }));
  }

  /** Delete one session and its events (the Console's per-row delete). */
  async deleteIndexRun(runId: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.query(
      "DELETE FROM memory_index_runs WHERE owner_id = $1 AND id = $2", // events cascade
      [ownerId, runId],
    );
  }

  /** Wipe the whole indexing history. */
  async clearIndexRuns(ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.query("DELETE FROM memory_index_runs WHERE owner_id = $1", [ownerId]);
  }

  // assistant chat (docs/design/assistant-tab.md)

  static readonly #ASSISTANT_HISTORY_LIMIT = 12;

  async #embedOrNull(text: string): Promise<string | null> {
    try {
      const [vec] = await this.#embedding.embed([text]);
      return vec ? toVectorLiteral(vec) : null;
    } catch {
      return null; // search degrades to keyword-only for this message; the chat still works
    }
  }

  async #saveAssistantMessage(
    ownerId: string,
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    sources: AssistantSource[],
  ): Promise<string> {
    const embedding = await this.#embedOrNull(content);
    const [row] = await this.#storage.query<{ id: string }>(
      `INSERT INTO assistant_messages (owner_id, session_id, role, content, sources, embedding)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ownerId, sessionId, role, content, JSON.stringify(sources), embedding],
    );
    return row?.id ?? "";
  }

  /**
   * One assistant turn: resolve/create the session, replay recent history, run the
   * agentic loop (the model decides whether to recall), persist both turns, return the
   * grounded answer with its sources. `onEvent` streams tool activity + answer deltas.
   */
  async assistantChat(
    input: { sessionId?: string; message: string; ownerId?: string; model?: string },
    onEvent?: (e: AssistantEvent) => void,
  ): Promise<AssistantChatResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const llm = this.#llm;
    if (!isChatProvider(llm)) {
      throw new Error(
        "the assistant needs a chat-capable LLM: add OPENROUTER_API_KEY to " +
          "~/.memloom/config.env and restart the daemon",
      );
    }

    const titleOf = (message: string) =>
      message.length > 60 ? `${message.slice(0, 57)}...` : message;
    let sessionId = input.sessionId;
    if (sessionId) {
      const found = await this.#storage.query<{ title: string }>(
        "SELECT title FROM assistant_sessions WHERE owner_id = $1 AND id = $2",
        [owner, sessionId],
      );
      if (found.length === 0) throw new Error(`no assistant session ${sessionId}`);
      // A session created by an attach-before-first-message still has the column default
      // title; the first real message names it. The guard makes this race-safe.
      if (found[0]?.title === "New chat") {
        await this.#storage.query(
          `UPDATE assistant_sessions SET title = $3
           WHERE owner_id = $1 AND id = $2 AND title = 'New chat'`,
          [owner, sessionId, titleOf(input.message)],
        );
      }
    } else {
      const [row] = await this.#storage.query<{ id: string }>(
        "INSERT INTO assistant_sessions (owner_id, title) VALUES ($1, $2) RETURNING id",
        [owner, titleOf(input.message)],
      );
      if (!row) throw new Error("memloom: could not create assistant session");
      sessionId = row.id;
    }

    // Last N plain turns, oldest first. Tool scaffolding is never persisted, so this is
    // exactly what the model should see again.
    const historyRows = await this.#storage.query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM assistant_messages
       WHERE owner_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [owner, sessionId, Memloom.#ASSISTANT_HISTORY_LIMIT],
    );
    const history = historyRows.reverse();
    const attachments = (await this.sessionAttachments(sessionId, owner)).map((d) => d.title);

    await this.#saveAssistantMessage(owner, sessionId, "user", input.message, []);

    const now = new Date();
    const scopedSessionId = sessionId;
    const { answer, sources } = await runAssistantTurn({
      provider: llm,
      recall: (query, onDate) =>
        this.recall(query, {
          ownerId: owner,
          limit: 8,
          sessionId: scopedSessionId,
          ...(onDate ? { assertedOn: onDate } : {}),
        }),
      history,
      message: input.message,
      // Both forms: the readable one for prose, the ISO one to copy into on_date.
      today: `${now.toDateString()} (${now.toLocaleDateString("en-CA")})`,
      ...(input.model ? { model: input.model } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(onEvent ? { onEvent } : {}),
    });

    const messageId = await this.#saveAssistantMessage(
      owner,
      sessionId,
      "assistant",
      answer,
      sources,
    );
    await this.#storage.query("UPDATE assistant_sessions SET updated_at = now() WHERE id = $1", [
      sessionId,
    ]);
    return { sessionId, messageId, answer, sources };
  }

  async assistantSessions(ownerId: string = SENTINEL_OWNER): Promise<AssistantSession[]> {
    const rows = await this.#storage.query<{
      id: string;
      title: string;
      is_starred: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, title, is_starred, created_at, updated_at FROM assistant_sessions
       WHERE owner_id = $1 ORDER BY is_starred DESC, updated_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      isStarred: Boolean(r.is_starred),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async assistantMessages(
    sessionId: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<AssistantMessage[]> {
    const rows = await this.#storage.query<{
      id: string;
      role: "user" | "assistant";
      content: string;
      sources: unknown;
      created_at: string;
    }>(
      `SELECT id, role, content, sources, created_at FROM assistant_messages
       WHERE owner_id = $1 AND session_id = $2 ORDER BY created_at, id`,
      [ownerId, sessionId],
    );
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      sources: (typeof r.sources === "string"
        ? JSON.parse(r.sources)
        : (r.sources ?? [])) as AssistantSource[],
      createdAt: r.created_at,
    }));
  }

  async renameAssistantSession(
    sessionId: string,
    title: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    await this.#storage.query(
      "UPDATE assistant_sessions SET title = $3 WHERE owner_id = $1 AND id = $2",
      [ownerId, sessionId, title.trim() || "New chat"],
    );
  }

  async starAssistantSession(
    sessionId: string,
    starred: boolean,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    await this.#storage.query(
      "UPDATE assistant_sessions SET is_starred = $3 WHERE owner_id = $1 AND id = $2",
      [ownerId, sessionId, starred],
    );
  }

  async deleteAssistantSession(sessionId: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      // Attachments are scoped to the chat, so they die with it. Chunks cascade from the
      // document FK, but edge cleanup must be explicit (see #deleteDocumentChunks); session
      // chunks are never indexed so no edges exist in practice — this keeps the invariant
      // anyway. Messages cascade from the session FK.
      await this.#deleteSessionAttachments(tx, ownerId, sessionId);
      await tx.query("DELETE FROM assistant_sessions WHERE owner_id = $1 AND id = $2", [
        ownerId,
        sessionId,
      ]);
    });
  }

  async clearAssistantSessions(ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      await this.#deleteSessionAttachments(tx, ownerId, null);
      await tx.query("DELETE FROM assistant_sessions WHERE owner_id = $1", [ownerId]);
    });
  }

  /** Delete one session's attached documents (sessionId null = every session's). */
  async #deleteSessionAttachments(
    tx: StorageAdapter,
    owner: string,
    sessionId: string | null,
  ): Promise<void> {
    const docs = await tx.query<{ id: string }>(
      `SELECT id FROM context_documents
       WHERE owner_id = $1 AND session_id IS NOT NULL
         AND ($2::uuid IS NULL OR session_id = $2)`,
      [owner, sessionId],
    );
    for (const doc of docs) {
      await this.#deleteDocumentChunks(tx, doc.id, owner);
      await tx.query("DELETE FROM context_documents WHERE id = $1 AND owner_id = $2", [
        doc.id,
        owner,
      ]);
    }
  }

  /**
   * Hybrid chat search: a keyword arm (ILIKE over titles + message content) and a
   * similarity arm (cosine over message embeddings). Merged per session; keyword hits
   * rank above pure-similarity hits; each hit carries its best-matching snippet.
   */
  async searchAssistantSessions(
    query: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<AssistantSessionHit[]> {
    const q = query.trim();
    if (!q) return (await this.assistantSessions(ownerId)).map((s) => ({ ...s, snippet: "" }));

    type HitRow = {
      id: string;
      title: string;
      is_starred: boolean;
      created_at: string;
      updated_at: string;
      snippet: string | null;
      sim?: number;
    };
    const keyword = await this.#storage.query<HitRow>(
      `SELECT DISTINCT ON (s.id) s.id, s.title, s.is_starred, s.created_at, s.updated_at,
              m.content AS snippet
       FROM assistant_sessions s
       LEFT JOIN assistant_messages m ON m.session_id = s.id AND m.content ILIKE $2
       WHERE s.owner_id = $1 AND (s.title ILIKE $2 OR m.id IS NOT NULL)
       ORDER BY s.id, m.created_at DESC`,
      [ownerId, `%${q}%`],
    );

    const hits = new Map<string, AssistantSessionHit & { score: number }>();
    const add = (row: HitRow, score: number) => {
      const existing = hits.get(row.id);
      if (existing && existing.score >= score) return;
      hits.set(row.id, {
        id: row.id,
        title: row.title,
        isStarred: Boolean(row.is_starred),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        snippet: (row.snippet ?? "").slice(0, 160),
        score,
      });
    };
    for (const row of keyword) add(row, 2); // keyword outranks similarity

    const [vec] = await this.#embedding.embed([q]).catch(() => [undefined]);
    if (vec) {
      const similar = await this.#storage.query<HitRow>(
        `SELECT DISTINCT ON (s.id) s.id, s.title, s.is_starred, s.created_at, s.updated_at,
                m.content AS snippet, 1 - (m.embedding <=> $2::vector) AS sim
         FROM assistant_messages m
         JOIN assistant_sessions s ON s.id = m.session_id
         WHERE m.owner_id = $1 AND m.embedding IS NOT NULL
         ORDER BY s.id, sim DESC`,
        [ownerId, toVectorLiteral(vec)],
      );
      for (const row of similar) {
        const sim = Number(row.sim ?? 0);
        if (sim >= 0.35) add(row, sim);
      }
    }

    return [...hits.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ score: _score, ...hit }) => hit);
  }

  /**
   * Wipe every extracted artifact and re-run indexing from scratch — the recovery path for
   * a store polluted by a weaker extraction pipeline. Deletes all entities, their mention
   * edges (from memories AND chunks), and every typed entity-to-entity edge; belief edges
   * (replaces/distinct) connect only memory_objects and are untouched by construction.
   * The wipe commits in one tx BEFORE any LLM call: a mid-run failure leaves everything
   * merely unindexed, and a plain index() resumes.
   */
  async reindex(
    ownerId: string = SENTINEL_OWNER,
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    await this.#storage.tx(async (tx) => {
      await tx.query(
        `DELETE FROM memory_edges
         WHERE owner_id = $1
           AND (relation = 'mention'
             OR from_id IN (SELECT id FROM memory_entities WHERE owner_id = $1)
             OR to_id IN (SELECT id FROM memory_entities WHERE owner_id = $1))`,
        [ownerId],
      );
      await tx.query("DELETE FROM memory_entities WHERE owner_id = $1", [ownerId]);
      await tx.query(
        "UPDATE memory_objects SET indexed_at = NULL WHERE owner_id = $1 AND status = 'active'",
        [ownerId],
      );
      await tx.query(
        "UPDATE context_chunks SET indexed_at = NULL WHERE owner_id = $1 AND session_id IS NULL",
        [ownerId],
      );
    });
    return this.#runIndex(ownerId, "rebuild", onProgress);
  }

  /**
   * The graph schema with live usage counts: the closed entity-type vocabulary and the
   * relation/predicate vocabulary, zero-filled so every schema row appears even before
   * first use. Predicate counts consider entity-sourced edges only, so document/memory
   * mention edges don't pollute the quarantine count.
   */
  async describeSchema(ownerId: string = SENTINEL_OWNER): Promise<SchemaInfo> {
    await this.#ensureSchemaSeed(ownerId);
    const rows = await this.#storage.query<SchemaEntry & { created_at: string }>(
      `SELECT id, kind, name, description, tier, status, occurrences, created_at
       FROM memory_schema WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    const typeCounts = await this.#storage.query<{ entity_type: string; n: number }>(
      "SELECT entity_type, count(*)::int AS n FROM memory_entities WHERE owner_id = $1 GROUP BY entity_type",
      [ownerId],
    );
    const relationCounts = await this.#storage.query<{ relation: string; n: number }>(
      "SELECT relation, count(*)::int AS n FROM memory_edges WHERE owner_id = $1 AND active GROUP BY relation",
      [ownerId],
    );
    const predicateCounts = await this.#storage.query<{ relation: string; n: number }>(
      `SELECT e.relation, count(*)::int AS n
       FROM memory_edges e
       JOIN memory_entities me ON me.id = e.from_id
       WHERE e.owner_id = $1 AND e.active
       GROUP BY e.relation`,
      [ownerId],
    );
    const byType = new Map(typeCounts.map((r) => [r.entity_type, Number(r.n)]));
    const byRelation = new Map(relationCounts.map((r) => [r.relation, Number(r.n)]));
    const byPredicate = new Map(predicateCounts.map((r) => [r.relation, Number(r.n)]));

    const entry = (r: SchemaEntry): SchemaEntry => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      description: r.description,
      tier: r.tier,
      status: r.status,
      occurrences: Number(r.occurrences),
    });
    const vocab = rows.filter((r) => r.tier !== "proposed" && r.status !== "dismissed");
    return {
      entityTypes: vocab
        .filter((r) => r.kind === "entity_type")
        .map((r) => ({ ...entry(r), count: byType.get(r.name) ?? 0 })),
      // Edge relations are engine mechanics, not registry rows — reported from code.
      relations: EDGE_RELATIONS.map((r) => ({
        name: r.name,
        description: r.description,
        count: r.virtual ? 0 : (byRelation.get(r.name) ?? 0),
      })),
      predicates: vocab
        .filter((r) => r.kind === "predicate")
        .map((r) => ({ ...entry(r), count: byPredicate.get(r.name) ?? 0 })),
      // The review queue: suggested often enough, not yet approved or dismissed.
      proposals: rows
        .filter(
          (r) =>
            r.tier === "proposed" &&
            r.status === "active" &&
            Number(r.occurrences) >= PROPOSAL_MIN_OCCURRENCES,
        )
        .map(entry),
    };
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
      "SELECT id, title, path FROM context_documents WHERE owner_id = $1 AND session_id IS NULL",
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
    // Typed entity-to-entity relationships (uses, part_of, ...) plus quarantined mentions.
    const entityEdgeRows = await this.#storage.query<{
      from_id: string;
      to_id: string;
      relation: string;
    }>(
      `SELECT e.from_id, e.to_id, e.relation
       FROM memory_edges e
       JOIN memory_entities me ON me.id = e.from_id
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
      ...entityEdgeRows.map((e) => ({ from: e.from_id, to: e.to_id, relation: e.relation })),
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

  // Extract the graph from one source (memory or context chunk): mention edges to each
  // surviving entity, plus typed entity-to-entity edges for the relationships the text
  // states (out-of-vocab and under-confident ones arrive already quarantined as 'mention'
  // by parseExtraction). The edge table has no FKs, so all node kinds share it. Returns
  // what the index progress stream reports.
  async #linkGraph(
    owner: string,
    sourceId: string,
    content: string,
    schema: ActiveSchema,
    context?: ExtractionContext,
  ): Promise<{ entities: string[]; relationships: number }> {
    // Fetched per item (one cheap query next to one expensive LLM call) so within a single
    // run, document 2's extraction already sees the canonical spellings document 1 created.
    const known = await this.#storage.query<{ name: string }>(
      `SELECT me.name
       FROM memory_entities me
       LEFT JOIN memory_edges e ON e.to_id = me.id AND e.relation = 'mention' AND e.active
       WHERE me.owner_id = $1
       GROUP BY me.id, me.name
       ORDER BY count(e.id) DESC, me.created_at
       LIMIT 75`,
      [owner],
    );
    const extraction = await extractGraph(
      this.#llm,
      content,
      { ...context, knownEntities: known.map((r) => r.name) },
      schema,
    );
    const idByName = new Map<string, string>();
    for (const entity of extraction.entities) {
      const entityId = await this.#resolveEntity(owner, entity.name, entity.type);
      idByName.set(entity.name.toLowerCase(), entityId);
      await addEdge(this.#storage, owner, sourceId, entityId, "mention");
    }
    let stored = 0;
    for (const rel of extraction.relationships) {
      const fromId = idByName.get(rel.subject.toLowerCase());
      const toId = idByName.get(rel.object.toLowerCase());
      if (!fromId || !toId) continue; // parser guarantees this; stay defensive
      await addEdgeIfAbsent(this.#storage, owner, fromId, toId, rel.predicate, {
        confidence: rel.confidence,
        sourceId,
      });
      stored += 1;
    }
    // Vocabulary the model wanted but the schema lacks: accumulate occurrences; the
    // review queue surfaces a name once enough independent extractions ask for it.
    for (const proposal of extraction.proposals) {
      await this.#recordProposal(owner, proposal.kind, proposal.name);
    }
    return { entities: extraction.entities.map((e) => e.name), relationships: stored };
  }

  // --- schema registry ---

  // Seed the system tier for this owner (idempotent). Lazy, so new owners and upgraded
  // engines converge without data migrations; user rows and proposals are never touched.
  async #ensureSchemaSeed(owner: string): Promise<void> {
    for (const t of ENTITY_TYPES) {
      await this.#storage.query(
        `INSERT INTO memory_schema (owner_id, kind, name, description, tier, status)
         VALUES ($1, 'entity_type', $2, $3, 'system', 'active')
         ON CONFLICT (owner_id, kind, name) DO NOTHING`,
        [owner, t.name, t.description],
      );
    }
    for (const p of PREDICATES) {
      await this.#storage.query(
        `INSERT INTO memory_schema (owner_id, kind, name, description, tier, status)
         VALUES ($1, 'predicate', $2, $3, 'system', 'active')
         ON CONFLICT (owner_id, kind, name) DO NOTHING`,
        [owner, p.name, p.description],
      );
    }
  }

  // The vocabulary an extraction run works against: active system + user rows, plus the
  // dismissed names the prompt must never re-propose.
  async #activeSchema(owner: string): Promise<ActiveSchema> {
    await this.#ensureSchemaSeed(owner);
    const rows = await this.#storage.query<{
      kind: SchemaKind;
      name: string;
      description: string;
      status: string;
      tier: string;
    }>(
      `SELECT kind, name, description, status, tier FROM memory_schema
       WHERE owner_id = $1 ORDER BY created_at`,
      [owner],
    );
    const active = rows.filter((r) => r.status === "active" && r.tier !== "proposed");
    return {
      entityTypes: active
        .filter((r) => r.kind === "entity_type")
        .map((r) => ({ name: r.name, description: r.description })),
      predicates: active
        .filter((r) => r.kind === "predicate")
        .map((r) => ({ name: r.name, description: r.description })),
      dismissed: rows.filter((r) => r.status === "dismissed").map((r) => r.name),
    };
  }

  async #recordProposal(owner: string, kind: SchemaKind, name: string): Promise<void> {
    // Dismissed and existing names never re-enter the queue (the unique index holds the
    // line; occurrences only grow while the row stays a proposal).
    await this.#storage.query(
      `INSERT INTO memory_schema (owner_id, kind, name, tier, status, occurrences)
       VALUES ($1, $2, $3, 'proposed', 'active', 1)
       ON CONFLICT (owner_id, kind, name)
       DO UPDATE SET occurrences = memory_schema.occurrences + 1
         WHERE memory_schema.tier = 'proposed' AND memory_schema.status = 'active'`,
      [owner, kind, name],
    );
  }

  /** Add a user-tier vocabulary entry. Name is normalized to snake_case. */
  async addSchemaEntry(
    kind: SchemaKind,
    name: string,
    description: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<SchemaEntry> {
    await this.#ensureSchemaSeed(ownerId);
    const normalized = normalizeSchemaName(name);
    if (!normalized) throw new Error("memloom: schema entry needs a usable name");
    const [row] = await this.#storage.query<SchemaEntry>(
      `INSERT INTO memory_schema (owner_id, kind, name, description, tier, status)
       VALUES ($1, $2, $3, $4, 'user', 'active')
       ON CONFLICT (owner_id, kind, name)
       DO UPDATE SET description = EXCLUDED.description, tier = 'user', status = 'active'
       RETURNING id, kind, name, description, tier, status, occurrences`,
      [ownerId, kind, normalized, description],
    );
    if (!row) throw new Error("memloom: failed to add schema entry");
    return row;
  }

  /** Promote a proposal to the user tier — the extractor starts using it next run. */
  async approveProposal(id: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    const updated = await this.#storage.query<{ id: string }>(
      `UPDATE memory_schema SET tier = 'user', status = 'active'
       WHERE id = $1 AND owner_id = $2 AND tier = 'proposed' RETURNING id`,
      [id, ownerId],
    );
    if (updated.length === 0) throw new Error(`memloom: no pending proposal ${id}`);
  }

  /** Reject a proposal — the name is blocklisted from re-proposal in the prompt. */
  async dismissProposal(id: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    const updated = await this.#storage.query<{ id: string }>(
      `UPDATE memory_schema SET status = 'dismissed'
       WHERE id = $1 AND owner_id = $2 AND tier = 'proposed' RETURNING id`,
      [id, ownerId],
    );
    if (updated.length === 0) throw new Error(`memloom: no pending proposal ${id}`);
  }

  /** Enable or disable a vocabulary entry (system or user tier). */
  async setSchemaStatus(
    id: string,
    status: "active" | "disabled",
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    const updated = await this.#storage.query<{ id: string }>(
      `UPDATE memory_schema SET status = $3
       WHERE id = $1 AND owner_id = $2 AND tier <> 'proposed' RETURNING id`,
      [id, ownerId, status],
    );
    if (updated.length === 0) throw new Error(`memloom: no schema entry ${id}`);
  }

  /**
   * Permanently remove a DISABLED user-tier vocabulary entry. Deliberately narrow:
   * system rows are re-seeded by name as ACTIVE on the next run, so deleting one would
   * silently re-enable it — disable is their only off-switch. Proposals have their own
   * lifecycle (approve/dismiss). Entities already extracted under the deleted type stay
   * in the graph, exactly as they do for a disabled type.
   */
  async deleteSchemaEntry(id: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    const deleted = await this.#storage.query<{ id: string }>(
      `DELETE FROM memory_schema
       WHERE id = $1 AND owner_id = $2 AND tier = 'user' AND status = 'disabled'
       RETURNING id`,
      [id, ownerId],
    );
    if (deleted.length > 0) return;
    const [row] = await this.#storage.query<{ tier: string; status: string }>(
      "SELECT tier, status FROM memory_schema WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    if (!row) throw new Error(`memloom: no schema entry ${id}`);
    if (row.tier === "system") {
      throw new Error("memloom: system entries cannot be deleted; disable instead");
    }
    if (row.tier === "proposed") {
      throw new Error("memloom: proposals are approved or dismissed, not deleted");
    }
    throw new Error("memloom: only disabled entries can be deleted; disable it first");
  }

  async #resolveEntity(owner: string, name: string, type: string): Promise<string> {
    // Identity is the NAME KEY alone (see entityNameKey) — the type is an attribute, not
    // part of the key. The extractor classifies inconsistently across chunks ("@memloom/core"
    // as technology here, project there); forking a node per type is never what a personal
    // graph wants, and the rare true homonym merges into one node — a smaller failure than
    // duplicates everywhere. First classification wins; oldest row wins over pre-fix dupes.
    // The SQL expression mirrors entityNameKey: trim, casefold, strip leading @, collapse ws.
    const existing = await this.#storage.query<{ id: string }>(
      `SELECT id FROM memory_entities
       WHERE owner_id = $1
         AND regexp_replace(regexp_replace(btrim(lower(name)), '^@', ''), '\\s+', ' ', 'g') = $2
       ORDER BY created_at LIMIT 1`,
      [owner, entityNameKey(name)],
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

  // --- entity management (the schema tab's instances list) ---

  /** Every entity with usage counts, most-mentioned first. */
  async listEntities(ownerId: string = SENTINEL_OWNER): Promise<EntityDetail[]> {
    const rows = await this.#storage.query<{
      id: string;
      name: string;
      entity_type: string;
      mentions: number;
      memories: number;
      documents: number;
    }>(
      `SELECT me.id, me.name, me.entity_type,
              count(e.id)::int AS mentions,
              count(DISTINCT mo.id)::int AS memories,
              count(DISTINCT cc.document_id)::int AS documents
       FROM memory_entities me
       LEFT JOIN memory_edges e
         ON e.to_id = me.id AND e.relation = 'mention' AND e.active AND e.owner_id = me.owner_id
       LEFT JOIN memory_objects mo ON mo.id = e.from_id AND mo.status = 'active'
       LEFT JOIN context_chunks cc ON cc.id = e.from_id
       WHERE me.owner_id = $1
       GROUP BY me.id, me.name, me.entity_type
       ORDER BY count(e.id) DESC, lower(me.name)`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      entityType: r.entity_type,
      mentions: Number(r.mentions),
      memories: Number(r.memories),
      documents: Number(r.documents),
    }));
  }

  /**
   * Rename and/or retype one entity. A rename re-embeds (the vector must follow the
   * name) and refuses a name-key collision with another entity — that situation is a
   * merge, not a rename. A retype must name an active vocabulary type.
   */
  async updateEntity(
    id: string,
    patch: { name?: string; entityType?: string },
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    const [row] = await this.#storage.query<{ id: string }>(
      "SELECT id FROM memory_entities WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    if (!row) throw new Error(`memloom: no entity ${id}`);

    if (patch.entityType !== undefined) {
      const schema = await this.#activeSchema(ownerId);
      if (!schema.entityTypes.some((t) => t.name === patch.entityType)) {
        throw new Error(`memloom: "${patch.entityType}" is not an active entity type`);
      }
      await this.#storage.query(
        "UPDATE memory_entities SET entity_type = $3 WHERE id = $1 AND owner_id = $2",
        [id, ownerId, patch.entityType],
      );
    }

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("memloom: entity name must be non-empty");
      const clash = await this.#storage.query<{ id: string }>(
        `SELECT id FROM memory_entities
         WHERE owner_id = $1 AND id <> $2
           AND regexp_replace(regexp_replace(btrim(lower(name)), '^@', ''), '\\s+', ' ', 'g') = $3
         LIMIT 1`,
        [ownerId, id, entityNameKey(name)],
      );
      if (clash[0]) {
        throw new Error(`memloom: an entity named "${name}" already exists — merge instead`);
      }
      const [embedding] = await this.#embedding.embed([name]);
      if (!embedding) throw new Error("memloom: embedding provider returned no vector");
      await this.#storage.query(
        "UPDATE memory_entities SET name = $3, embedding = $4::vector WHERE id = $1 AND owner_id = $2",
        [id, ownerId, name, toVectorLiteral(embedding)],
      );
    }
  }

  /**
   * Merge one entity into another: every edge touching the source is repointed to the
   * target (would-be duplicates and would-be self-loops are dropped first), then the
   * source row is deleted. The target's name and type win — merging IS choosing.
   */
  async mergeEntities(
    sourceId: string,
    targetId: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    if (sourceId === targetId) throw new Error("memloom: cannot merge an entity into itself");
    await this.#storage.tx(async (tx) => {
      for (const eid of [sourceId, targetId]) {
        const [row] = await tx.query<{ id: string }>(
          "SELECT id FROM memory_entities WHERE id = $1 AND owner_id = $2",
          [eid, ownerId],
        );
        if (!row) throw new Error(`memloom: no entity ${eid}`);
      }
      // Edges between the two would become self-loops after repointing.
      await tx.query(
        `DELETE FROM memory_edges
         WHERE owner_id = $1
           AND ((from_id = $2 AND to_id = $3) OR (from_id = $3 AND to_id = $2))`,
        [ownerId, sourceId, targetId],
      );
      // Source edges that already exist against the target would become duplicates.
      await tx.query(
        `DELETE FROM memory_edges e
         WHERE e.owner_id = $1 AND e.to_id = $2
           AND EXISTS (
             SELECT 1 FROM memory_edges t
             WHERE t.owner_id = $1 AND t.to_id = $3
               AND t.from_id = e.from_id AND t.relation = e.relation)`,
        [ownerId, sourceId, targetId],
      );
      await tx.query(
        `DELETE FROM memory_edges e
         WHERE e.owner_id = $1 AND e.from_id = $2
           AND EXISTS (
             SELECT 1 FROM memory_edges t
             WHERE t.owner_id = $1 AND t.from_id = $3
               AND t.to_id = e.to_id AND t.relation = e.relation)`,
        [ownerId, sourceId, targetId],
      );
      await tx.query("UPDATE memory_edges SET to_id = $3 WHERE owner_id = $1 AND to_id = $2", [
        ownerId,
        sourceId,
        targetId,
      ]);
      await tx.query("UPDATE memory_edges SET from_id = $3 WHERE owner_id = $1 AND from_id = $2", [
        ownerId,
        sourceId,
        targetId,
      ]);
      await tx.query("DELETE FROM memory_entities WHERE id = $1 AND owner_id = $2", [
        sourceId,
        ownerId,
      ]);
    });
  }

  /** Delete one entity and every edge touching it (no FK cascade on the shared edge table). */
  async deleteEntity(id: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      await this.#deleteEntityEdges(tx, ownerId, id);
      const deleted = await tx.query<{ id: string }>(
        "DELETE FROM memory_entities WHERE id = $1 AND owner_id = $2 RETURNING id",
        [id, ownerId],
      );
      if (deleted.length === 0) throw new Error(`memloom: no entity ${id}`);
    });
  }

  // Entities appear on both edge ends (mentions point at them, typed predicates run
  // between them), so cleanup must sweep both — the same manual story as document chunks.
  async #deleteEntityEdges(tx: StorageAdapter, owner: string, entityId: string): Promise<void> {
    await tx.query(
      "DELETE FROM memory_edges WHERE owner_id = $1 AND (from_id = $2 OR to_id = $2)",
      [owner, entityId],
    );
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
