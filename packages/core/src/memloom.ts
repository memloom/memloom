import type { EmbeddingProvider, LLMProvider } from "./providers.js";
import type { StorageAdapter } from "./storage.js";

// All config is injected — core never reads process.env or global state (build-plan
// architectural rule 2). This is what lets a host (a multi-tenant platform) hand core a
// pooled connection + its own keys and consume @memloom/core directly.
export interface MemloomConfig {
  storage: StorageAdapter;
  embedding: EmbeddingProvider;
  llm: LLMProvider;
}

export interface SaveInput {
  content: string;
  canonical?: string;
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

  // Phase 1 — the spine (save -> embed -> vector recall).
  async save(_input: SaveInput): Promise<never> {
    throw new Error("Memloom.save is not implemented yet (build-plan Phase 1).");
  }

  async recall(_query: string): Promise<never> {
    throw new Error("Memloom.recall is not implemented yet (build-plan Phase 1).");
  }
}
