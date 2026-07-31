import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";

// Graph traversal: "which people are related to this person", asked of the edges rather than
// of recall. The fixture is the shape that motivated it: one human written two ways, working
// with other humans on a project, where some connections were stated by the extractor and the
// rest are only co-mention.

const textOf = (prompt: string) => prompt.slice(prompt.indexOf("TEXT:"));

const PEOPLE: Array<[string, string]> = [
  ["Robert", "person"],
  ["Bob", "person"],
  ["Grace", "person"],
  ["Alan", "person"],
  ["memloom", "project"],
  ["Acme", "organization"],
  ["PGLite", "technology"],
];

// Stated relationships, emitted whenever both endpoints appear in the text.
const RELATIONSHIPS: Array<[string, string, string]> = [
  ["Robert", "works_on", "memloom"],
  ["Grace", "works_on", "memloom"],
  ["memloom", "uses", "PGLite"],
];

const extractor = new ScriptedLLMProvider((prompt) => {
  const text = textOf(prompt);
  const entities = PEOPLE.filter(([name]) => text.includes(name)).map(([name, type]) => ({
    name,
    type,
  }));
  const present = new Set(entities.map((e) => e.name));
  const relationships = RELATIONSHIPS.filter(([s, , o]) => present.has(s) && present.has(o)).map(
    ([subject, predicate, object]) => ({ subject, predicate, object, confidence: 0.9 }),
  );
  return JSON.stringify({ entities, relationships });
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

describe("entity traversal", () => {
  async function fresh(): Promise<Memloom> {
    await truncateAll(storage);
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await m.init();
    return m;
  }

  const byName = async (m: Memloom, name: string) =>
    (await m.listEntities()).find((e) => e.name === name);

  async function seeded(): Promise<Memloom> {
    const m = await fresh();
    await m.save({ content: "Robert and Grace pair on memloom most weeks" });
    await m.save({ content: "memloom stores everything in PGLite locally" });
    await m.save({ content: "Bob reviewed the release with Grace" });
    await m.save({ content: "Alan runs the design work at Acme" });
    await m.index();
    return m;
  }

  it("answers who a person is connected to, stated links first", async () => {
    const m = await seeded();
    const result = await m.relatedEntities("Robert");

    expect(result?.entity.name).toBe("Robert");
    expect(result?.matchedAlias).toBeNull();

    const names = result?.related.map((r) => r.name) ?? [];
    // memloom is a STATED works_on, so it outranks Grace, who is only a co-mention, even
    // though both appear in the same single memory.
    expect(names[0]).toBe("memloom");
    expect(names).toContain("Grace");
    // Alan shares no source with them and must not appear at all.
    expect(names).not.toContain("Alan");

    const memloom = result?.related.find((r) => r.name === "memloom");
    expect(memloom?.links).toEqual([{ relation: "works_on", direction: "out", confidence: 0.9 }]);
    const grace = result?.related.find((r) => r.name === "Grace");
    expect(grace?.links).toEqual([]);
    expect(grace?.sharedSources).toBe(1);
  });

  it("filters the neighbourhood by entity type", async () => {
    const m = await seeded();
    const people = await m.relatedEntities("memloom", { entityType: "person" });

    expect(people?.related.map((r) => r.name).sort()).toEqual(["Grace", "Robert"]);
    // The type filter must not quietly drop the direction of a stated link.
    const robert = people?.related.find((r) => r.name === "Robert");
    expect(robert?.links).toEqual([{ relation: "works_on", direction: "in", confidence: 0.9 }]);
    // PGLite is a real neighbour of memloom, just not a person.
    const all = await m.relatedEntities("memloom");
    expect(all?.related.map((r) => r.name)).toContain("PGLite");
  });

  it("reports the direction of a stated link from each end", async () => {
    const m = await seeded();
    const fromProject = await m.relatedEntities("memloom", { entityType: "technology" });
    expect(fromProject?.related.find((r) => r.name === "PGLite")?.links).toEqual([
      { relation: "uses", direction: "out", confidence: 0.9 },
    ]);
    const fromTech = await m.relatedEntities("PGLite");
    expect(fromTech?.related.find((r) => r.name === "memloom")?.links).toEqual([
      { relation: "uses", direction: "in", confidence: 0.9 },
    ]);
  });

  it("answers about a folded-away spelling and says which one it was", async () => {
    // The whole reason traversal comes after resolution. Asking about "Bob" has to answer
    // about Robert, and it has to SAY so, because "Bob is a known alias" is part of
    // what the user wanted to learn.
    const m = await seeded();
    const canonical = await byName(m, "Robert");
    const variant = await byName(m, "Bob");
    await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");

    const result = await m.relatedEntities("Bob");
    expect(result?.entity.id).toBe(canonical?.id);
    expect(result?.entity.name).toBe("Robert");
    expect(result?.matchedAlias).toBe("Bob");
    expect(result?.entity.aliases).toEqual(["Bob"]);

    // The fold ADDED a connection: Bob's shared memory with Grace now counts for
    // Robert, so Grace went from one shared source to two.
    const grace = result?.related.find((r) => r.name === "Grace");
    expect(grace?.sharedSources).toBe(2);
  });

  it("chases a uuid that names an absorbed row", async () => {
    const m = await seeded();
    const canonical = await byName(m, "Robert");
    const variant = await byName(m, "Bob");
    const variantId = variant?.id ?? "";
    await m.mergeEntities(variantId, canonical?.id ?? "");

    // That uuid is gone from memory_entities. Asking by it must still land somewhere, or
    // every id an agent cached before a fold becomes a dead end.
    const result = await m.relatedEntities(variantId);
    expect(result?.entity.id).toBe(canonical?.id);
    // Asked by id rather than by the alias spelling, so there is no alias to report.
    expect(result?.matchedAlias).toBeNull();
  });

  it("returns null for an unknown entity rather than an empty neighbourhood", async () => {
    // The two cases read identically to a caller otherwise, and they mean opposite things:
    // "no such person" versus "that person is in the graph and connected to nobody".
    const m = await seeded();
    expect(await m.relatedEntities("Nobody At All")).toBeNull();
    expect(await m.relatedEntities("11111111-2222-3333-4444-555555555555")).toBeNull();

    const isolated = await m.relatedEntities("Alan", { entityType: "project" });
    expect(isolated).not.toBeNull();
    expect(isolated?.related).toEqual([]);
  });

  it("caps the answer and says how much it cut", async () => {
    const m = await seeded();
    const all = await m.relatedEntities("memloom");
    const capped = await m.relatedEntities("memloom", { limit: 1 });

    expect(capped?.related).toHaveLength(1);
    expect(capped?.truncated).toBe((all?.related.length ?? 0) - 1);
    expect(all?.truncated).toBe(0);
    // The kept one is the strongest, not an arbitrary one.
    expect(capped?.related[0]?.links.length).toBeGreaterThan(0);
  });

  it("never lists the entity as its own neighbour", async () => {
    const m = await seeded();
    const result = await m.relatedEntities("memloom");
    expect(result?.related.map((r) => r.id)).not.toContain(result?.entity.id);
  });

  it("names a neighbour's own aliases so the answer is not written in dead spellings", async () => {
    const m = await seeded();
    const canonical = await byName(m, "Robert");
    const variant = await byName(m, "Bob");
    await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");

    const fromProject = await m.relatedEntities("memloom", { entityType: "person" });
    const him = fromProject?.related.find((r) => r.name === "Robert");
    expect(him?.aliases).toEqual(["Bob"]);
  });
});
