import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";

// Phase 4: the indexer extracts entities, links memories to them, and the entity arm retrieves
// memories by entity anchor. Scripted LLM extracts entities deterministically from content.
// Context chunks go through the same pipeline (one graph, two granularities); "elephant
// database" maps to Postgres WITHOUT the word appearing, so entity-arm tests can prove
// retrieval that the keyword/vector arms cannot explain.

const extractor = new ScriptedLLMProvider((prompt) => {
  const entities: Array<{ name: string; type: string }> = [];
  if (prompt.includes("Postgres")) entities.push({ name: "Postgres", type: "technology" });
  if (prompt.includes("elephant database")) entities.push({ name: "Postgres", type: "technology" });
  if (prompt.includes("Redis")) entities.push({ name: "Redis", type: "technology" });
  if (prompt.includes("Fly")) entities.push({ name: "Fly.io", type: "platform" });
  return JSON.stringify(entities);
});

describe("entities + indexer", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
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

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "memloom-ctx-graph-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
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

  it("indexes context chunks and rolls mentions up to one weighted document edge", async () => {
    const m = await fresh();
    const path = join(tempDir(), "runbook.md");
    writeFileSync(
      path,
      "# Runbook\n## DB\nthe staging database is Postgres\n## Cache\nwe cache in Redis",
    );
    const added = await m.contextAdd({ path });

    const result = await m.index();
    expect(result.chunksIndexed).toBeGreaterThan(0);
    // Idempotent for chunks too.
    expect((await m.index()).chunksIndexed).toBe(0);

    const graph = await m.graph();
    expect(graph.documents).toHaveLength(1);
    expect(graph.documents[0]?.id).toBe(added.documentId);
    expect(graph.entities.map((e) => e.name).sort()).toEqual(["Postgres", "Redis"]);

    // Chunk mentions surface only as rolled-up document -> entity edges: every edge endpoint
    // is a node the viewer knows (no raw chunk ids), and rollup edges carry a weight.
    const nodeIds = new Set([
      ...graph.memories.map((x) => x.id),
      ...graph.entities.map((x) => x.id),
      ...graph.documents.map((x) => x.id),
    ]);
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
    const docEdges = graph.edges.filter((e) => e.from === added.documentId);
    expect(docEdges).toHaveLength(2); // one per entity, however many chunks mention it
    for (const edge of docEdges) expect(edge.weight).toBeGreaterThanOrEqual(1);
  });

  it("entity arm ranks a chunk the keyword and vector arms cannot explain", async () => {
    const m = await fresh();
    await m.save({ content: "the daily standup is at 9am" }); // distractor, no entities
    const path = join(tempDir(), "infra.md");
    // "elephant database" -> Postgres entity, but the word "Postgres" never appears in the
    // text, so keyword search abstains and hashing-embedding similarity is near zero for both
    // rows. Only the entity anchor (query == entity name, cosine 1.0) separates them — the
    // chunk collects the whole entity arm's score, so it must rank first.
    writeFileSync(path, "# Infra\nthe elephant database powers the staging environment");
    await m.contextAdd({ path });
    await m.index();

    const results = await m.recall("Postgres");
    expect(results[0]?.kind).toBe("context");
    expect(results[0]?.content).toContain("elephant database");
  });

  it("contextChunks drills a document down to chunks and their entity edges", async () => {
    const m = await fresh();
    const path = join(tempDir(), "runbook.md");
    writeFileSync(
      path,
      "# Runbook\n## DB\nthe staging database is Postgres\n## Cache\nwe cache in Redis",
    );
    const added = await m.contextAdd({ path });
    await m.index();

    const { chunks, edges } = await m.contextChunks(added.documentId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i)); // ordered
    expect(chunks.some((c) => c.content.includes("Postgres"))).toBe(true);

    // Every edge runs from one of this document's chunks to a known entity.
    const chunkIds = new Set(chunks.map((c) => c.id));
    const entityIds = new Set((await m.graph()).entities.map((e) => e.id));
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(chunkIds.has(edge.from)).toBe(true);
      expect(entityIds.has(edge.to)).toBe(true);
      expect(edge.relation).toBe("mention");
    }

    await expect(m.contextChunks("00000000-0000-0000-0000-000000000001")).rejects.toThrow(
      /no context document/,
    );
  });

  it("removing a document cleans up its chunk mention edges", async () => {
    const m = await fresh();
    const path = join(tempDir(), "db.md");
    writeFileSync(path, "# DB\nthe staging database is Postgres");
    const added = await m.contextAdd({ path });
    await m.index();
    expect((await m.graph()).edges.some((e) => e.from === added.documentId)).toBe(true);

    await m.contextRemove(added.documentId);
    const graph = await m.graph();
    expect(graph.documents).toHaveLength(0);
    expect(graph.edges.some((e) => e.from === added.documentId)).toBe(false);
    // The entity survives — it may be mentioned by memories or other documents.
    expect(graph.entities.map((e) => e.name)).toContain("Postgres");
  });

  it("re-adding a changed file drops stale chunk edges until re-indexed", async () => {
    const m = await fresh();
    const path = join(tempDir(), "notes.md");
    writeFileSync(path, "# Notes\nthe staging database is Postgres");
    const added = await m.contextAdd({ path });
    await m.index();

    writeFileSync(path, "# Notes\nwe cache everything in Redis now");
    expect((await m.contextAdd({ path })).outcome).toBe("updated");
    // Old chunks (and their edges) are gone; the new chunks are not indexed yet.
    let graph = await m.graph();
    expect(graph.edges.some((e) => e.from === added.documentId)).toBe(false);

    expect((await m.index()).chunksIndexed).toBeGreaterThan(0);
    graph = await m.graph();
    const docEdges = graph.edges.filter((e) => e.from === added.documentId);
    expect(docEdges).toHaveLength(1);
    expect(graph.entities.map((e) => e.name)).toContain("Redis");
  });
});
