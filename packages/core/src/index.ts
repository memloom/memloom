// Ports (interfaces)

export type { BenchCorpus, BenchDoc, BenchQuery } from "./benchmark.js";
// Retrieval benchmark + metrics
export { runBenchmark } from "./benchmark.js";
// Context connector building blocks
export type { Chunk, ChunkOptions } from "./chunker.js";
export { chunkMarkdown, chunkOutline, chunkText } from "./chunker.js";
export type { MemoryEngine } from "./engine.js";
export type { ContextKind, ExtractedFile, ExtractedUnit } from "./extract.js";
export { detectKind, extractFile } from "./extract.js";
// Providers
export {
  HashingEmbeddingProvider,
  NullLLMProvider,
  ScriptedLLMProvider,
} from "./hashing-provider.js";
export type { FetchLike, HttpResponse } from "./http-client.js";
export { HttpMemloomClient } from "./http-client.js";
export type { ReleaseLock } from "./lock.js";
export { acquireDataDirLock } from "./lock.js";
export type { MemloomConfig } from "./memloom.js";
// The engine facade + contract
export { Memloom, SENTINEL_OWNER } from "./memloom.js";
export type { EvalReport, QueryResult } from "./metrics.js";
export { evaluate, mean, recallAtK, reciprocalRank } from "./metrics.js";
// Migrations
export { migrate } from "./migrate.js";
export type { Migration } from "./migrations.js";
export { buildMigrations } from "./migrations.js";
export type {
  OpenRouterEmbeddingsOptions,
  OpenRouterLLMOptions,
} from "./openrouter-provider.js";
export { OpenRouterEmbeddings, OpenRouterLLM } from "./openrouter-provider.js";
export type { PdfTextItem } from "./pdf-layout.js";
export { assemblePageText } from "./pdf-layout.js";
export { PgAdapter } from "./pg-adapter.js";
// Storage adapters
export { PgliteAdapter } from "./pglite-adapter.js";
export type { EmbeddingProvider, LLMProvider } from "./providers.js";
export type { StorageAdapter } from "./storage.js";
// Domain types
export type {
  Conflict,
  ConflictCandidate,
  ContextAddInput,
  ContextAddOutcome,
  ContextAddResult,
  ContextChunk,
  ContextDocument,
  DocumentChunks,
  Entity,
  Graph,
  GraphDocument,
  GraphEdge,
  GraphMemory,
  IndexResult,
  Memory,
  MemoryStatus,
  MemoryType,
  RecallOptions,
  RecallSource,
  ResolveDecision,
  SaveInput,
  SaveOutcome,
  SaveResult,
} from "./types.js";
// The saveable memory taxonomy (fact | preference | episode | procedure).
export { MEMORY_TYPES } from "./types.js";

// Utilities
export { toVectorLiteral } from "./vector.js";

export const VERSION = "0.0.0";
