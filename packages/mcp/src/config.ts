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

// Same local store as the CLI (~/.memloom, override with MEMLOOM_HOME). The MCP owns the store
// directly here; when a `memloom serve` is already running it should route through that instead
// (single-owner, D1) — a follow-up once the server exposes the client shape.
export function storeDir(): string {
  return process.env.MEMLOOM_HOME ?? join(homedir(), ".memloom");
}

export interface OpenedStore {
  memloom: Memloom;
  storage: StorageAdapter;
  close(): Promise<void>;
}

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
  return { memloom, storage, close: () => storage.close() };
}
