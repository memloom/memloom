// Ports (interfaces)

// Domain types
// Agent memory folder import building blocks
export type {
  AgentMemoryDiscoveryOptions,
  AgentMemoryFolder,
  AgentMemorySource,
  AgentMemoryUnit,
} from "./agent-memories.js";
export {
  AGENT_MEMORY_SOURCES,
  claudeMemoryRoot,
  copilotMemoryCandidates,
  locateAgentMemoryFolders,
  parseAgentMemoryFolder,
  parseClaudeMemoryFolder,
  parseCopilotMemoryFolder,
} from "./agent-memories.js";
export type { AssistantEvent } from "./assistant.js";
export {
  buildAssistantSystemPrompt,
  PASSAGE_CHARS,
  runAssistantTurn,
  stripInvalidMarkers,
} from "./assistant.js";
// Audio and video transcription (ffmpeg + silero VAD + parakeet under sherpa-onnx, local)
export type {
  DecodeChunk,
  RecordingTime,
  TimedWord,
  TranscribeFileResult,
  TranscribeOptions,
  TranscribeProgress,
  TranscribeResult,
  TranscriptSection,
  VadSegment,
} from "./audio.js";
export {
  AudioError,
  DECODE_CHUNK_SECONDS,
  findSuspectChunks,
  formatTime,
  hasFfmpeg,
  hashFile,
  mediaDurationSeconds,
  modelDir,
  packChunks,
  peakLevel,
  recordingHeader,
  recordingTime,
  SECTION_MIN_SPEECH_CHARS,
  SECTION_SECONDS,
  sectionize,
  sectionizeTurns,
  toMarkdown,
  transcribeMedia,
  transcribeWav,
  VAD_RESCUE_THRESHOLD,
  VAD_THRESHOLD,
  vadThreshold,
} from "./audio.js";
export type {
  CatalogModel,
  DownloadProgress,
  ModelArchitecture,
  ModelStatus,
  ResolvedModel,
  SetupOptions,
  SpeakerModelPaths,
} from "./audio-models.js";
export {
  CATALOG,
  DEFAULT_MODEL_ID,
  findModel,
  modelStatus,
  requireModels,
  resolveModel,
  resolveSpeakerModels,
  SPEAKER_EMBEDDING_MODEL_ID,
  selectedModelId,
  selectModel,
  setupModels,
} from "./audio-models.js";
export type { BenchCorpus, BenchDoc, BenchQuery } from "./benchmark.js";
// Retrieval benchmark + metrics
export { runBenchmark } from "./benchmark.js";
// Context connector building blocks
export type { Chunk, ChunkOptions } from "./chunker.js";
export { chunkMarkdown, chunkOutline, chunkText } from "./chunker.js";
// Claude Code session import building blocks
export type {
  ChunkResult,
  DiscoveredSession,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoverySkips,
  ParsedSession,
  SessionChunk,
  SessionUnit,
} from "./claude-sessions.js";
export {
  CHUNK_BUDGET_CHARS,
  chunkUnits,
  claudeProjectsDir,
  discoverSessions,
  hashPrefix,
  parseSession,
  QUIET_MS,
} from "./claude-sessions.js";
// Speaker diarization (pyannote segmentation + WeSpeaker embeddings under sherpa-onnx, local)
export type { DiarizeResult, SpeakerTurn } from "./diarize.js";
export {
  clusterConfig,
  DIARIZE_THRESHOLD_DEFAULT,
  DIARIZE_VERSION,
  diarizeSignature,
  diarizeWav,
  dropJunkClusters,
  longestSegment,
  MIN_SPEAKER_SECONDS,
  mergeTurns,
  relabelByAppearance,
  TURN_MERGE_GAP_SECONDS,
} from "./diarize.js";
export type { DistilledMemory, DistillOutput } from "./distill.js";
export { buildDistillPrompt, distillChunk, parseDistillation } from "./distill.js";
export type { MemoryEngine } from "./engine.js";
// Arbitrating an uncertain fold with a model: the prompt and the parser, both pure.
export type {
  EntityArbitrationCase,
  EntityVerdict,
  EntityVerdictKind,
} from "./entity-arbiter.js";
export {
  arbitrationCase,
  buildEntityArbiterPrompt,
  parseEntityVerdict,
} from "./entity-arbiter.js";
// Entity resolution: the pure decision rules behind folding name variants.
export type { PairJudgement, PairVerdict, ResolvableEntity } from "./entity-resolution.js";
export {
  boundedEditDistance,
  CONFIRMING_COSINE,
  groupPairs,
  judgePair,
  MAX_VARIANT_EDIT_DISTANCE,
  MIN_AUTO_KEY_LENGTH,
  mergeKey,
  nameTokens,
  pickCanonical,
  versionTokens,
} from "./entity-resolution.js";
export type {
  ContextKind,
  ExtractedFile,
  ExtractedUnit,
  Extractor,
  ExtractProgress,
} from "./extract.js";
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
// Web link ingestion (fetch + defuddle on linkedom, all in-process)
export type { ExtractedLink, ExtractedPage, ExtractUrlOptions, FetchedPage } from "./link.js";
export {
  extractHtml,
  extractUrl,
  fetchPage,
  isHttpUrl,
  LinkExtractionError,
  normalizeUrl,
} from "./link.js";
export type { ReleaseLock } from "./lock.js";
export { acquireDataDirLock } from "./lock.js";
export type { InitOptions, MemloomConfig } from "./memloom.js";
// The engine facade + contract
export {
  DEFAULT_RECONCILE_SETTINGS,
  EmbeddingFingerprintError,
  Memloom,
  SENTINEL_OWNER,
} from "./memloom.js";
export type { EvalReport, QueryResult } from "./metrics.js";
export { evaluate, mean, recallAtK, reciprocalRank } from "./metrics.js";
// Migrations
export { migrate, storedEmbeddingDims } from "./migrate.js";
export type { Migration } from "./migrations.js";
export { buildMigrations } from "./migrations.js";
export type {
  NotionBlock,
  NotionBlockNode,
  NotionListedItem,
  NotionRichText,
} from "./notion.js";
export { NOTION_VERSION, NotionClient, pageTitle } from "./notion.js";
export {
  blocksToMarkdown,
  propertyToPlain,
  richTextToMarkdown,
  rowsToMarkdown,
} from "./notion-markdown.js";
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
export type { QueueItem, QueueRunner, QueueSnapshot, QueueStatus } from "./queue.js";
export { IngestQueue, uploadStoreDir } from "./queue.js";
// The contradiction re-check: the retrieval widening, the prompt, and the quote verification.
// All pure except findRecheckSubjects, which is one indexed query per belief in the window.
export type { RecheckFinding, RecheckPair, RecheckSubject, RecheckVerdict } from "./recheck.js";
export {
  buildRecheckPrompt,
  countDueForRecheck,
  findRecheckSubjects,
  MIN_QUOTE_CHARS,
  parseRecheckVerdicts,
  quoteOccursIn,
  RECHECK_FLOOR,
  RECHECK_K,
  RECHECK_QUIET_DAYS,
  verifiedFindings,
} from "./recheck.js";
// Reconciliation: the consolidation detectors, the per-run caps, and the cost arithmetic.
export type { RecheckWindow, ReconcileCaps, ReconcileFinding } from "./reconcile.js";
export {
  BACKOFF_SILENT_AFTER,
  CONFLICT_QUEUE_CEILING,
  capBuckets,
  effectiveCaps,
  estimateRecheck,
  estimateTokens,
  findDuplicateContent,
  findEntityInvariants,
  findMultiHeadLineages,
  findOrphanStale,
  findReplacesLeaks,
  INTEGRITY_CLASSES,
  idleRunDue,
  isIntegrityFinding,
  PROMPT_OVERHEAD_TOKENS,
  RECONCILE_CAPS,
  RECONCILE_CATCHUP_HOURS,
  RECONCILE_CEILING_HOURS,
  RECONCILE_IDLE_HOURS,
  RECONCILE_IDLE_QUIET_MS,
  RECONCILE_K,
  RECONCILE_STARTUP_SETTLE_MS,
  RECONCILE_TICK_MS,
  startupCatchUpDue,
} from "./reconcile.js";
export type { RedactResult } from "./redact.js";
export { redact } from "./redact.js";
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
export type { FileStability, StabilityOptions } from "./stability.js";
export { waitUntilStable } from "./stability.js";
export type { StorageAdapter } from "./storage.js";
export type { SyncOptions, SyncStats, SyncStore } from "./sync.js";
export { FileSync } from "./sync.js";
// Test-only helper, exported for the same reason PgliteAdapter is: the server and MCP test
// suites build stores too, and reaching into core/src across packages breaks their rootDir.
export { truncateAll } from "./test-store.js";
export type {
  AgentMemoryFolderEvent,
  AgentMemoryImportOptions,
  AgentMemoryImportResult,
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
  ContextAddUrlInput,
  ContextAttachInput,
  ContextAttachResult,
  ContextChunk,
  ContextDocument,
  ContextProgressEvent,
  ContextRoot,
  DocumentChunks,
  DocumentSpeaker,
  Entity,
  EntityConflict,
  EntityConflictCandidate,
  EntityDetail,
  EntityLink,
  EntityMerge,
  EntityResolutionResult,
  Graph,
  GraphDocument,
  GraphEdge,
  GraphMemory,
  ImportCaptureScope,
  ImportOptions,
  ImportResult,
  ImportSessionEvent,
  ImportStatus,
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
  NotionItemRef,
  NotionListedPage,
  NotionScope,
  NotionStatus,
  NotionSyncEvent,
  NotionSyncOptions,
  NotionSyncResult,
  PossibleAnswer,
  PossibleContradiction,
  RecallOptions,
  RecallSource,
  ReconcileAction,
  ReconcileActionKind,
  ReconcileArbitration,
  ReconcileDecision,
  ReconcileEstimate,
  ReconcileMode,
  ReconcileOptions,
  ReconcilePass,
  ReconcileRecheckResult,
  ReconcileReport,
  ReconcileRevertResult,
  ReconcileRun,
  ReconcileRunStatus,
  ReconcileSettings,
  ReconcileTrigger,
  ReembedOptions,
  ReembedProgressEvent,
  ReembedResult,
  RelatedEntities,
  RelatedEntity,
  ResolveDecision,
  ResolvedConflict,
  SaveInput,
  SaveOutcome,
  SaveResult,
  SpeakerRoster,
  SyncTargets,
  UpdateInput,
  UpdateResult,
} from "./types.js";
// The saveable memory taxonomy (fact | preference | episode | procedure).
export { FREE_RECONCILE_PASSES, MEMORY_TYPES, RECONCILE_PASSES } from "./types.js";

// Utilities
export { toVectorLiteral } from "./vector.js";
export type { WalkedFile, WalkOptions, WalkResult } from "./walk.js";
export {
  hasDiskPath,
  WALK_MAX_DEPTH,
  WALK_MAX_FILES,
  WALK_SKIP_DIRS,
  walkSupportedFiles,
} from "./walk.js";

export const VERSION = "0.0.0";
