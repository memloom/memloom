import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";

// Phase 4: the indexer extracts entities, links memories to them, and the entity arm retrieves
// memories by entity anchor. Scripted LLM extracts entities deterministically from content.

const extractor = new ScriptedLLMProvider((prompt) => {
  const entities: Array<{ name: string; type: string }> = [];
  if (prompt.includes("Postgres")) entities.push({ name: "Postgres", type: "technology" });
  if (prompt.includes("Redis")) entities.push({ name: "Redis", type: "technology" });
  if (prompt.includes("Fly")) entities.push({ name: "Fly.io", type: "platform" });
  return JSON.stringify(entities);
});

describe("entities + indexer", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh(): Promise<Memloom> {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false, // seed raw; we're testing indexing, not the belief pipeline
    });
    await m.init();
    return m;
  }

  it("indexes memories into entities and mention edges", async () => {
    const m = await fresh();
    await m.save({ content: "the staging database runs on Postgres" });
    await m.save({ content: "we cache queries in Redis" });

    const result = await m.index();
    expect(result.indexed).toBe(2);

    const graph = await m.graph();
    expect(graph.entities.map((e) => e.name).sort()).toEqual(["Postgres", "Redis"]);
    expect(graph.edges.filter((e) => e.relation === "mention")).toHaveLength(2);
    expect(graph.memories).toHaveLength(2);
  });

  it("resolves the same entity across memories to one node", async () => {
    const m = await fresh();
    await m.save({ content: "the primary database is Postgres" });
    await m.save({ content: "the analytics store is also Postgres" });
    await m.index();

    const graph = await m.graph();
    const postgres = graph.entities.filter((e) => e.name === "Postgres");
    expect(postgres).toHaveLength(1);
    // Both memories mention the single Postgres node.
    const mentions = graph.edges.filter(
      (e) => e.to === postgres[0]?.id && e.relation === "mention",
    );
    expect(mentions).toHaveLength(2);
  });

  it("index is idempotent", async () => {
    const m = await fresh();
    await m.save({ content: "deployed to Fly" });
    expect((await m.index()).indexed).toBe(1);
    expect((await m.index()).indexed).toBe(0);
  });

  it("entity arm retrieves memories by entity anchor", async () => {
    const m = await fresh();
    await m.save({ content: "the staging database runs on Postgres" });
    await m.save({ content: "the daily standup is at 9am" });
    await m.index();

    // Query is the entity name, so its embedding matches the Postgres entity embedding exactly
    // (cosine 1.0 >= the anchor gate) -> the entity arm fires and surfaces the memory.
    const results = await m.recall("Postgres");
    expect(results.some((r) => r.content.includes("Postgres"))).toBe(true);
  });
});
