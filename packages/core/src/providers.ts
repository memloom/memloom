// Provider interfaces so the LLM and embedding backends are pluggable (build-plan:
// cloud/OpenRouter first, local/Ollama later). Core depends only on these shapes.

export interface EmbeddingProvider {
  /** Embedding dimensionality; validated against the schema's vector(N) columns. */
  readonly dims: number;
  /**
   * Identifies the vector space this provider produces (e.g. "openrouter:qwen/qwen3-embedding-8b@1024").
   * Stored in the store's meta table on first init; a later init with a different fingerprint
   * is refused — mixing embedding spaces makes similarity silently meaningless.
   */
  readonly fingerprint: string;
  /** Embed a batch of documents/queries. Implementations batch upstream (e.g. 64/call). */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface LLMProvider {
  /** Return the model's text completion for a prompt. Structured-JSON helpers layer on top. */
  complete(prompt: string): Promise<string>;
}
