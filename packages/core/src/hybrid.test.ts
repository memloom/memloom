import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom, SENTINEL_OWNER } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";
import { toVectorLiteral } from "./vector.js";

// Phase 2: the fused retrieval works and both arms contribute. We can't reproduce real MRR
// numbers without a real embedding model (that's the key-gated benchmark), but we can prove
// the *structure* deterministically: the keyword arm surfaces an exact match the vector arm
// misses. We do that by calling memloom_fuse with a query embedding that is lexically
// unrelated to the target — so only the keyword arm can retrieve it.

describe("hybrid retrieval", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh(): Promise<Memloom> {
    const storage: StorageAdapter = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
      dedup: false, // retrieval tests seed raw
    });
    await m.init();
    return m;
  }

  it("recall returns fused order with rrfScore and similarity populated", async () => {
    const m = await fresh();
    await m.save({ content: "the staging database is postgres on fly.io" });
    await m.save({ content: "the daily stand-up is at 9am" });
    await m.save({ content: "we deploy on fridays after review" });

    const results = await m.recall("what database do we use for staging?");
    expect(results[0]?.content).toContain("staging database");
    expect(results[0]?.rrfScore).toBeGreaterThan(0);
    expect(results[0]?.similarity).toBeGreaterThan(0);
  });

  it("keyword arm surfaces an exact match the vector arm misses", async () => {
    const m = await fresh();
    const storage = m.deps.storage;
    const embedding = m.deps.embedding;

    // Fillers each share a word with the query text below (so the vector arm ranks them high).
    const fillers = [
      "banana bread baking tips",
      "spaceship docking procedure",
      "orbit insertion burn timing",
      "banana plantation logistics",
      "spaceship hull inspection",
      "orbit decay simulation notes",
      "banana smoothie nutrition",
      "spaceship crew rotation",
      "orbit period calculation",
      "banana ripeness chart",
      "spaceship fuel margins",
      "orbit debris tracking",
    ];
    for (const content of fillers) await m.save({ content });
    // The target shares NO words with the query text, but contains the exact keyword.
    const { id: targetId } = await m.save({
      content: "the rare quokka was photographed on rottnest island",
    });

    // Query text and query embedding are deliberately decoupled: the embedding is of an
    // unrelated phrase, so the vector arm cannot surface the target; only the keyword can.
    const [qemb] = await embedding.embed(["banana spaceship orbit"]);
    const qvec = toVectorLiteral(qemb ?? []);

    const withKeyword = await storage.query<{ id: string }>(
      "SELECT id FROM memloom_fuse($1, $2::vector, $3, 10, 50, 60, true, true)",
      ["quokka", qvec, SENTINEL_OWNER],
    );
    const vectorOnly = await storage.query<{ id: string }>(
      "SELECT id FROM memloom_fuse($1, $2::vector, $3, 10, 50, 60, true, false)",
      ["quokka", qvec, SENTINEL_OWNER],
    );

    expect(withKeyword.map((r) => r.id)).toContain(targetId);
    expect(vectorOnly.map((r) => r.id)).not.toContain(targetId);
  });
});
