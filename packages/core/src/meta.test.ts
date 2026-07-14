import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { EmbeddingProvider } from "./providers.js";
import type { StorageAdapter } from "./storage.js";

// The embedding-fingerprint guard: a store embedded under one provider/model must refuse to
// open under another: mixed vector spaces don't error, they make recall garbage.

describe("embedding fingerprint guard", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  function engine(storage: StorageAdapter, embedding: EmbeddingProvider) {
    return new Memloom({ storage, embedding, llm: new NullLLMProvider(), dedup: false });
  }

  it("same fingerprint reopens fine; a different one is refused", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());

    await engine(storage, new HashingEmbeddingProvider(1024)).init();
    // Same config again: the normal restart path.
    await engine(storage, new HashingEmbeddingProvider(1024)).init();

    // Same dims, different vector space (what switching offline → cloud looks like).
    const cloudish: EmbeddingProvider = {
      dims: 1024,
      fingerprint: "openrouter:qwen/qwen3-embedding-8b@1024",
      embed: async (texts) => texts.map(() => new Array(1024).fill(0)),
    };
    await expect(engine(storage, cloudish).init()).rejects.toThrow(/embedded with "hashing:1024"/);
  });
});
