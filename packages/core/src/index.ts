// Ports (interfaces)

// Providers
export { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
export type { ReleaseLock } from "./lock.js";
export { acquireDataDirLock } from "./lock.js";
export type { MemloomConfig } from "./memloom.js";
// The engine facade
export { Memloom, SENTINEL_OWNER } from "./memloom.js";
// Migrations
export { migrate } from "./migrate.js";
export type { Migration } from "./migrations.js";
export { MIGRATIONS } from "./migrations.js";
export type {
  OpenRouterEmbeddingsOptions,
  OpenRouterLLMOptions,
} from "./openrouter-provider.js";
export { OpenRouterEmbeddings, OpenRouterLLM } from "./openrouter-provider.js";
export { PgAdapter } from "./pg-adapter.js";
// Storage adapters
export { PgliteAdapter } from "./pglite-adapter.js";
export type { EmbeddingProvider, LLMProvider } from "./providers.js";
export type { StorageAdapter } from "./storage.js";
// Domain types
export type {
  Memory,
  MemoryStatus,
  RecallOptions,
  SaveInput,
  SaveResult,
} from "./types.js";

// Utilities
export { toVectorLiteral } from "./vector.js";

export const VERSION = "0.0.0";
