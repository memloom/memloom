import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom, SENTINEL_OWNER } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";
import { toVectorLiteral } from "./vector.js";

// Migration 0021: the fuse entity arm anchors on alias vectors as well as entity vectors.
//
// Without it, folding is a net LOSS for recall. mergeEntities deletes the absorbed row, so
// the vector a query spelled the old way used to match disappears from memory_entities and
// the entity arm goes quiet. These tests call memloom_fuse with the vector and keyword arms
// switched OFF, so what they measure is the entity arm alone and nothing else can carry the
// result.

const textOf = (prompt: string) => prompt.slice(prompt.indexOf("TEXT:"));

// Deliberately share no words: a hashing embedding of "Bob" is orthogonal to one of
// "Robert", so the canonical's own vector cannot rescue a query for the variant.
// That is what makes this a test of the alias arm rather than of proximity.
const NAMES = ["Robert", "Bob"];

const extractor = new ScriptedLLMProvider((prompt) => {
  const text = textOf(prompt);
  const entities = NAMES.filter((name) => text.includes(name)).map((name) => ({
    name,
    type: "person",
  }));
  return JSON.stringify({ entities, relationships: [] });
});

// One store for the whole file, emptied between tests. See test-store.ts: booting PGLite
// costs about six seconds and the tests themselves cost milliseconds, so a store per test
// spends effectively all of its wall clock on Postgres startup.
let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

describe("fuse anchors on aliases", () => {
  const embedding = new HashingEmbeddingProvider(1024);

  async function seeded(): Promise<{ m: Memloom; storage: StorageAdapter; variantMemory: string }> {
    await truncateAll(storage);
    const m = new Memloom({ storage, embedding, llm: extractor, dedup: false });
    await m.init();
    await m.save({ content: "Robert approved the release plan" });
    const { id } = await m.save({ content: "Bob filed the migration ticket" });
    await m.index();
    return { m, storage, variantMemory: id };
  }

  /** The entity arm on its own: vector and keyword contribute nothing. */
  async function entityArmOnly(storage: StorageAdapter, query: string): Promise<string[]> {
    const [qemb] = await embedding.embed([query]);
    const rows = await storage.query<{ id: string }>(
      `SELECT id FROM memloom_fuse(
         p_q => $1, p_emb => $2::vector, p_owner => $3,
         p_use_vector => false, p_use_keyword => false, p_use_entity => true)`,
      [query, toVectorLiteral(qemb ?? []), SENTINEL_OWNER],
    );
    return rows.map((r) => r.id);
  }

  const byName = async (m: Memloom, name: string) =>
    (await m.listEntities()).find((e) => e.name === name);

  it("still finds what a folded spelling anchored before the fold", async () => {
    const { m, storage, variantMemory } = await seeded();
    expect(await entityArmOnly(storage, "Bob")).toContain(variantMemory);

    const canonical = await byName(m, "Robert");
    const variant = await byName(m, "Bob");
    await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");

    // The Bob row no longer exists. The only vector left that a "Bob" query can match
    // lives in memory_entity_aliases, so this assertion is exactly what 0021 buys.
    expect(await entityArmOnly(storage, "Bob")).toContain(variantMemory);
  });

  it("gains the canonical's memories through the alias, not just keeps its own", async () => {
    const { m, storage } = await seeded();
    const canonical = await byName(m, "Robert");
    const variant = await byName(m, "Bob");
    await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");

    // Asking the old way now reaches everything the person is attached to, because the
    // alias resolves to the canonical and the canonical absorbed both mention edges.
    expect(await entityArmOnly(storage, "Bob")).toHaveLength(2);
  });

  it("reverting the fold takes the alias anchor back out", async () => {
    const { m, storage, variantMemory } = await seeded();
    const canonical = await byName(m, "Robert");
    const variant = await byName(m, "Bob");
    const mergeId = await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");
    await m.revertEntityMerge(mergeId);

    // Back to two separate people: the variant anchors on its own restored row again and
    // stops dragging the canonical's memory along with it.
    const hits = await entityArmOnly(storage, "Bob");
    expect(hits).toEqual([variantMemory]);
  });

  it("one entity never eats two anchor slots when its alias also matches", async () => {
    // Canonical and alias are spellings of one name, so a query close to one is usually close
    // to the other. Un-deduped, that pair would spend two of the ten anchor slots naming a
    // single entity and quietly halve the arm's reach.
    const { m, storage } = await seeded();
    const canonical = await byName(m, "Robert");
    const variant = await byName(m, "Bob");
    await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");

    const [qemb] = await embedding.embed(["Bob"]);
    const anchors = await storage.query<{ eid: string }>(
      `SELECT DISTINCT e.to_id AS eid
       FROM memory_edges e
       WHERE e.owner_id = $1 AND e.relation = 'mention' AND e.active`,
      [SENTINEL_OWNER],
    );
    // Every surviving mention edge points at the one canonical row.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.eid).toBe(canonical?.id);

    // And the arm returns each source once, not once per matching vector.
    const hits = await storage.query<{ id: string }>(
      `SELECT id FROM memloom_fuse(
         p_q => $1, p_emb => $2::vector, p_owner => $3,
         p_use_vector => false, p_use_keyword => false, p_use_entity => true)`,
      ["Bob", toVectorLiteral(qemb ?? []), SENTINEL_OWNER],
    );
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });
});
