// Ports (interfaces)

// Domain types
export type { AssistantEvent } from "./assistant.js";
export {
  buildAssistantSystemPrompt,
  PASSAGE_CHARS,
  runAssistantTurn,
  stripInvalidMarkers,
} from "./assistant.js";
export type { BenchCorpus, BenchDoc, BenchQuery } from "./benchmark.js";
// Retrieval benchmark + metrics
export { runBenchmark } from "./benchmark.js";
// Context connector building blocks
export type { Chunk, ChunkOptions } from "./chunker.js";
export { chunkMarkdown, chunkOutline, chunkText } from "./chunker.js";
export type { MemoryEngine } from "./engine.js";
export type { ContextKind, ExtractedFile, ExtractedUnit, Extractor } from "./extract.js";
export {
  detectKind,
  extractBytes,
  extractFile,
  registerExtractor,
  supportedExtensions,
} from "./extract.js";
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
export type { InitOptions, MemloomConfig } from "./memloom.js";
// The engine facade + contract
export { EmbeddingFingerprintError, Memloom, SENTINEL_OWNER } from "./memloom.js";
export type { EvalReport, QueryResult } from "./metrics.js";
export { evaluate, mean, recallAtK, reciprocalRank } from "./metrics.js";
// Migrations
export { migrate, storedEmbeddingDims } from "./migrate.js";
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
export type {
  ChatMessage,
  ChatProvider,
  ChatResult,
  ChatTool,
  ChatToolCall,
  EmbeddingProvider,
  LLMProvider,
} from "./providers.js";
export { isChatProvider } from "./providers.js";
// The graph schema: the system-tier vocabulary constants (seeded into the memory_schema
// registry) plus the registry model types.
export type {
  ActiveSchema,
  EdgeRelationDef,
  EntityType,
  EntityTypeDef,
  PredicateDef,
  PredicateName,
  ProposalExample,
  SchemaEntry,
  SchemaInfo,
  SchemaKind,
  SchemaStatus,
  SchemaTier,
} from "./schema.js";
export {
  DEFAULT_ACTIVE_SCHEMA,
  EDGE_RELATIONS,
  ENTITY_TYPE_NAMES,
  ENTITY_TYPES,
  MIN_RELATIONSHIP_CONFIDENCE,
  normalizeSchemaName,
  PREDICATE_NAMES,
  PREDICATES,
  PROPOSAL_MIN_OCCURRENCES,
} from "./schema.js";
export type { StorageAdapter } from "./storage.js";
export type {
  AssistantChatResult,
  AssistantMessage,
  AssistantSession,
  AssistantSessionHit,
  AssistantSource,
  Conflict,
  ConflictCandidate,
  ContextAddInput,
  ContextAddOutcome,
  ContextAddResult,
  ContextAttachInput,
  ContextAttachResult,
  ContextChunk,
  ContextDocument,
  DocumentChunks,
  Entity,
  EntityDetail,
  Graph,
  GraphDocument,
  GraphEdge,
  GraphMemory,
  IndexEventLevel,
  IndexProgressEvent,
  IndexResult,
  IndexRun,
  IndexRunEvent,
  IndexRunStatus,
  IndexRunTrigger,
  Memory,
  MemoryStatus,
  MemoryType,
  RecallOptions,
  RecallSource,
  ReembedOptions,
  ReembedProgressEvent,
  ReembedResult,
  ResolveDecision,
  SaveInput,
  SaveOutcome,
  SaveResult,
  UpdateInput,
  UpdateResult,
} from "./types.js";
// The saveable memory taxonomy (fact | preference | episode | procedure).
export { MEMORY_TYPES } from "./types.js";

// Utilities
export { toVectorLiteral } from "./vector.js";

export const VERSION = "0.0.0";
