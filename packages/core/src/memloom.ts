import { createHash } from "node:crypto";
import { migrate } from "./migrate.js";
import type { EmbeddingProvider, LLMProvider } from "./providers.js";
import type { StorageAdapter } from "./storage.js";
import type { Memory, RecallOptions, SaveInput, SaveResult } from "./types.js";
import { toVectorLiteral } from "./vector.js";

// The fixed owner for the single-user embedded tier. Multi-tenant hosts pass a real
// ownerId per call; the column exists everywhere so the schema is sync/cloud-ready.
export const SENTINEL_OWNER = "00000000-0000-0000-0000-000000000000";

// All config is injected — core never reads process.env or global state (build-plan
// architectural rule 2).
export interface MemloomConfig {
  storage: StorageAdapter;
  embedding: EmbeddingProvider;
  llm: LLMProvider;
}

interface MemoryRow {
  id: string;
  owner_id: string;
  status: Memory["status"];
  memory_type: string;
  canonical: string | null;
  content: string;
  summary: string | null;
  asserted_at: string;
  created_at: string;
  similarity?: number;
  rrf_score?: number;
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
    assertedAt: row.asserted_at,
    createdAt: row.created_at,
    ...(row.similarity !== undefined ? { similarity: Number(row.similarity) } : {}),
    ...(row.rrf_score !== undefined ? { rrfScore: Number(row.rrf_score) } : {}),
  };
}

export class Memloom {
  readonly #storage: StorageAdapter;
  readonly #embedding: EmbeddingProvider;
  readonly #llm: LLMProvider;

  constructor(config: MemloomConfig) {
    this.#storage = config.storage;
    this.#embedding = config.embedding;
    this.#llm = config.llm;
  }

  /** The injected dependencies, exposed read-only for host wiring and tests. */
  get deps(): Readonly<MemloomConfig> {
    return { storage: this.#storage, embedding: this.#embedding, llm: this.#llm };
  }

  /** Run pending migrations. Idempotent; call once after constructing. */
  async init(): Promise<void> {
    await migrate(this.#storage);
  }

  // Phase 1 — the spine. No dedup/entities yet (those are Phases 3-4); a save is a plain
  // insert of the embedded content.
  async save(input: SaveInput): Promise<SaveResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const [embedding] = await this.#embedding.embed([input.content]);
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const hash = createHash("sha256").update(input.content).digest("hex");

    const rows = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_objects (owner_id, memory_type, canonical, content, content_hash, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)
       RETURNING id`,
      [
        owner,
        input.memoryType ?? "fact",
        input.canonical ?? null,
        input.content,
        hash,
        toVectorLiteral(embedding),
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("memloom: insert returned no id");
    return { id };
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

    const rows = await this.#storage.query<MemoryRow>(
      `SELECT mo.id, mo.owner_id, mo.status, mo.memory_type, mo.canonical, mo.content,
              mo.summary, mo.asserted_at, mo.created_at,
              1 - (mo.embedding <=> $1::vector) AS similarity,
              f.rrf_score
       FROM memloom_fuse($2, $1::vector, $3, $4) f
       JOIN memory_objects mo ON mo.id = f.id
       ORDER BY f.rrf_score DESC`,
      [qvec, query, owner, limit],
    );
    return rows.map(mapRow);
  }
}
