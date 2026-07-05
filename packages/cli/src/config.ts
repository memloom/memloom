import { homedir } from "node:os";
import { join } from "node:path";
import {
  HashingEmbeddingProvider,
  Memloom,
  NullLLMProvider,
  OpenRouterEmbeddings,
  OpenRouterLLM,
  PgliteAdapter,
  type StorageAdapter,
} from "@memloom/core";

// Where the local store lives: ~/.memloom by default (override with MEMLOOM_HOME). This is a
// real Postgres data directory — copy it, back it up, move it. It is your memory.
export function storeDir(): string {
  return process.env.MEMLOOM_HOME ?? join(homedir(), ".memloom");
}

export interface OpenedStore {
  memloom: Memloom;
  storage: StorageAdapter;
  offline: boolean;
  close(): Promise<void>;
}

// Open the persistent store. With OPENROUTER_API_KEY set, the full pipeline runs (real
// embeddings + LLM dedup/entities). Without a key, offline mode uses the deterministic
// provider with dedup off — good enough to populate and inspect data, no account needed.
// Both default to 1024 dims, so the schema is compatible across modes.
export async function openStore(): Promise<OpenedStore> {
  const storage = await PgliteAdapter.open({ dataDir: storeDir() });
  const apiKey = process.env.OPENROUTER_API_KEY;

  const memloom = apiKey
    ? new Memloom({
        storage,
        embedding: new OpenRouterEmbeddings({ apiKey }),
        llm: new OpenRouterLLM({ apiKey }),
      })
    : new Memloom({
        storage,
        embedding: new HashingEmbeddingProvider(1024),
        llm: new NullLLMProvider(),
        dedup: false,
      });

  await memloom.init();
  return { memloom, storage, offline: !apiKey, close: () => storage.close() };
}
