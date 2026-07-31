import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";

// Entity resolution end to end: folding variants into one canonical, keeping the fold
// visible and reversible, routing uncertain folds to the conflicts surface, and a backfill
// that is safe to run twice.
//
// The extractor echoes whatever spelling the text used, which is exactly how the real store
// ended up with "Claude Opus 4.8" and "Opus 4.8" as separate rows.
const textOf = (prompt: string) => prompt.slice(prompt.indexOf("TEXT:"));

const SPELLINGS: Array<[string, string]> = [
  ["Claude Opus 4.8", "agent"],
  ["Opus 4.8", "agent"],
  ["Claude Opus 4.7", "agent"],
  ["PostgreSQL", "technology"],
  ["Postgres", "technology"],
  ["claude-code", "technology"],
  ["Claude Code", "project"],
];

const extractor = new ScriptedLLMProvider((prompt) => {
  const text = textOf(prompt);
  const entities: Array<{ name: string; type: string }> = [];
  for (const [name, type] of SPELLINGS) {
    if (text.includes(name)) entities.push({ name, type });
  }
  // Longest match wins, so "Claude Opus 4.8" does not also yield "Opus 4.8".
  const kept = entities.filter((e) => !entities.some((o) => o !== e && o.name.includes(e.name)));
  return JSON.stringify({ entities: kept, relationships: [] });
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

describe("entity resolution", () => {
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

  /** Seed the two spellings of one thing that the live store actually contains. */
  async function seedVariants(m: Memloom): Promise<Memloom> {
    await m.save({ content: "we shipped the release on Claude Opus 4.8 yesterday" });
    await m.save({ content: "the eval ran on Claude Opus 4.8 overnight" });
    await m.save({ content: "Opus 4.8 handled the migration" });
    await m.index();
    return m;
  }

  it("folds a variant into the canonical and keeps the variant addressable", async () => {
    const m = await seedVariants(await fresh());
    const before = await m.listEntities();
    expect(before.map((e) => e.name).sort()).toEqual(["Claude Opus 4.8", "Opus 4.8"]);

    const canonical = await byName(m, "Claude Opus 4.8");
    const variant = await byName(m, "Opus 4.8");
    await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");

    const after = await m.listEntities();
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("Claude Opus 4.8");
    // The fold is VISIBLE: the absorbed spelling is listed, not silently dropped.
    expect(after[0]?.aliases).toEqual(["Opus 4.8"]);
    // and every mention followed it, so nothing lost its link to the graph.
    expect(after[0]?.memories).toBe(3);
  });

  it("a folded spelling resolves to the canonical instead of re-creating the row", async () => {
    // The regression that makes folding worth anything. #resolveEntity looks up the INCOMING
    // name, so without the alias lookup the very next memory using the old spelling mints a
    // fresh duplicate and the merge quietly undoes itself. Running the backfill twice would
    // never catch this: it only shows up when NEW content arrives.
    const m = await seedVariants(await fresh());
    const canonical = await byName(m, "Claude Opus 4.8");
    const variant = await byName(m, "Opus 4.8");
    await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");

    await m.save({ content: "Opus 4.8 also passed the regression suite" });
    await m.index();

    const after = await m.listEntities();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(canonical?.id);
    expect(after[0]?.memories).toBe(4); // the new memory landed on the canonical
  });

  it("reverts a fold completely, edges and all", async () => {
    const m = await seedVariants(await fresh());
    const canonical = await byName(m, "Claude Opus 4.8");
    const variant = await byName(m, "Opus 4.8");
    const variantId = variant?.id ?? "";
    const beforeMentions = variant?.mentions ?? 0;

    const mergeId = await m.mergeEntities(variantId, canonical?.id ?? "");
    expect(await m.listEntities()).toHaveLength(1);

    await m.revertEntityMerge(mergeId);

    const after = await m.listEntities();
    expect(after).toHaveLength(2);
    const restored = after.find((e) => e.name === "Opus 4.8");
    // Restored with its ORIGINAL id, so anything still pointing at it stays valid.
    expect(restored?.id).toBe(variantId);
    expect(restored?.mentions).toBe(beforeMentions);
    expect(after.find((e) => e.name === "Claude Opus 4.8")?.aliases).toEqual([]);

    const merges = await m.entityMerges();
    expect(merges[0]?.revertedAt).not.toBeNull();
  });

  it("revert is idempotent and a reverted spelling can be re-indexed", async () => {
    const m = await seedVariants(await fresh());
    const canonical = await byName(m, "Claude Opus 4.8");
    const variant = await byName(m, "Opus 4.8");
    const mergeId = await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");
    await m.revertEntityMerge(mergeId);
    await m.revertEntityMerge(mergeId); // no throw, no double-restore
    expect(await m.listEntities()).toHaveLength(2);

    await m.save({ content: "Opus 4.8 shipped again" });
    await m.index();
    expect((await m.listEntities()).filter((e) => e.name === "Opus 4.8")).toHaveLength(1);
  });

  it("folds pure spelling variants automatically and asks about the rest", async () => {
    const m = await fresh();
    await m.save({ content: "the hook runs inside claude-code" });
    await m.save({ content: "Claude Code is the CLI" });
    await m.save({ content: "we store beliefs in PostgreSQL" });
    await m.save({ content: "Postgres also runs the queue" });
    await m.index();
    expect(await m.listEntities()).toHaveLength(4);

    const result = await m.resolveEntities();

    // "claude-code" / "Claude Code" differ only in punctuation and case: certain.
    expect(result.merged).toBe(1);
    // "Postgres" / "PostgreSQL" is a spelling variant, not an identity: ask.
    expect(result.queued).toBe(1);

    const names = (await m.listEntities()).map((e) => e.name).sort();
    expect(names).toEqual(["Claude Code", "PostgreSQL", "Postgres"]);

    const queue = await m.entityConflicts();
    expect(queue).toHaveLength(1);
    expect([queue[0]?.incoming.name, queue[0]?.candidates[0]?.name].sort()).toEqual([
      "PostgreSQL",
      "Postgres",
    ]);
  });

  it("never folds two releases of one family", async () => {
    const m = await fresh();
    await m.save({ content: "Claude Opus 4.8 is the newest" });
    await m.save({ content: "Claude Opus 4.7 came before it" });
    await m.index();

    const result = await m.resolveEntities();
    expect(result.merged).toBe(0);
    expect(result.queued).toBe(0);
    expect(await m.listEntities()).toHaveLength(2);
    expect(await m.entityConflicts()).toHaveLength(0);
  });

  it("backfill runs twice with no change on the second run", async () => {
    const m = await fresh();
    await m.save({ content: "the hook runs inside claude-code" });
    await m.save({ content: "Claude Code is the CLI" });
    await m.save({ content: "we store beliefs in PostgreSQL" });
    await m.save({ content: "Postgres also runs the queue" });
    await m.index();

    const first = await m.resolveEntities();
    expect(first.merged + first.queued).toBeGreaterThan(0);
    const entitiesAfterFirst = await m.listEntities();
    const queueAfterFirst = await m.entityConflicts();

    const second = await m.resolveEntities();
    expect(second.merged).toBe(0);
    expect(second.queued).toBe(0);
    expect(await m.listEntities()).toEqual(entitiesAfterFirst);
    expect(await m.entityConflicts()).toHaveLength(queueAfterFirst.length);
  });

  it("refuses to delete a canonical while a fold into it is still undoable", async () => {
    // Deleting the canonical would take the alias row with it, and the alias row is what
    // holds the absorbed entity's id and vector. The fold would silently become permanent
    // and its mentions would be swept along with it. Reversibility is the property the
    // pipeline rests on, so this is a refusal, not a cascade.
    const m = await seedVariants(await fresh());
    const canonical = await byName(m, "Claude Opus 4.8");
    const variant = await byName(m, "Opus 4.8");
    const mergeId = await m.mergeEntities(variant?.id ?? "", canonical?.id ?? "");

    await expect(m.deleteEntity(canonical?.id ?? "")).rejects.toThrow(/revert/i);
    expect(await m.listEntities()).toHaveLength(1);

    // Revert first, and the delete goes through.
    await m.revertEntityMerge(mergeId);
    await m.deleteEntity(canonical?.id ?? "");
    expect((await m.listEntities()).map((e) => e.name)).toEqual(["Opus 4.8"]);
  });

  it("caps the queue by impact and reports what it deferred", async () => {
    const m = await fresh();
    await m.save({ content: "we store beliefs in PostgreSQL" });
    await m.save({ content: "Postgres also runs the queue" });
    await m.save({ content: "Opus 4.8 handled the migration" });
    await m.save({ content: "Claude Opus 4.8 shipped" });
    await m.index();

    const capped = await m.resolveEntities({ limit: 1 });
    expect(capped.queued).toBe(1);
    expect(capped.deferred).toBe(1);
    expect(await m.entityConflicts()).toHaveLength(1);

    // The limit bounds the QUEUE, not the pass: re-running while the question is still
    // waiting must not stack a second one on top of it.
    const again = await m.resolveEntities({ limit: 1 });
    expect(again.queued).toBe(0);
    expect(again.deferred).toBe(1);
    expect(await m.entityConflicts()).toHaveLength(1);

    // Nothing was lost. Answer the waiting question and the deferred pair gets its turn.
    const waiting = (await m.entityConflicts())[0];
    await m.resolveConflict(waiting?.id ?? "", { action: "keep_both" });
    const next = await m.resolveEntities({ limit: 1 });
    expect(next.queued).toBe(1);
    expect(next.deferred).toBe(0);
  });

  it("dryRun reports the same plan without changing anything", async () => {
    const m = await fresh();
    await m.save({ content: "the hook runs inside claude-code" });
    await m.save({ content: "Claude Code is the CLI" });
    await m.index();

    const planned = await m.resolveEntities({ dryRun: true });
    expect(planned.merged).toBe(1);
    expect(await m.listEntities()).toHaveLength(2); // untouched

    const applied = await m.resolveEntities();
    expect(applied.merged).toBe(planned.merged);
    expect(await m.listEntities()).toHaveLength(1);
  });
});

describe("entity conflicts share the conflicts surface", () => {
  // One store for this suite, emptied between tests. See test-store.ts.
  let storage: StorageAdapter;
  beforeAll(async () => {
    storage = await PgliteAdapter.open();
  });
  afterAll(async () => {
    await storage.close();
  });

  async function seeded(): Promise<Memloom> {
    await truncateAll(storage);
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await m.init();
    await m.save({ content: "we store beliefs in PostgreSQL" });
    await m.save({ content: "Postgres also runs the queue" });
    await m.index();
    await m.resolveEntities();
    return m;
  }

  it("keeps entity folds out of the memory conflict queue", async () => {
    const m = await seeded();
    expect(await m.entityConflicts()).toHaveLength(1);
    expect(await m.conflicts()).toHaveLength(0);
  });

  it("keep_existing folds the queued spelling into the candidate", async () => {
    const m = await seeded();
    const conflict = (await m.entityConflicts())[0];
    const target = conflict?.candidates[0];
    await m.resolveConflict(conflict?.id ?? "", {
      action: "keep_existing",
      candidateId: target?.id ?? "",
    });

    const entities = await m.listEntities();
    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe(target?.name);
    expect(entities[0]?.aliases).toEqual([conflict?.incoming.name]);
    expect(await m.entityConflicts()).toHaveLength(0);
  });

  it("keep_new makes the queued spelling the canonical one", async () => {
    const m = await seeded();
    const conflict = (await m.entityConflicts())[0];
    await m.resolveConflict(conflict?.id ?? "", { action: "keep_new" });

    const entities = await m.listEntities();
    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe(conflict?.incoming.name);
    expect(entities[0]?.aliases).toEqual([conflict?.candidates[0]?.name]);
  });

  it("keep_both leaves the graph alone and never asks again", async () => {
    const m = await seeded();
    const conflict = (await m.entityConflicts())[0];
    await m.resolveConflict(conflict?.id ?? "", { action: "keep_both" });

    expect(await m.listEntities()).toHaveLength(2);
    expect(await m.entityConflicts()).toHaveLength(0);

    const again = await m.resolveEntities();
    expect(again.queued).toBe(0);
    expect(await m.entityConflicts()).toHaveLength(0);
  });

  it("reverting an arbitrated fold restores the entity and re-queues the question", async () => {
    const m = await seeded();
    const conflict = (await m.entityConflicts())[0];
    const conflictId = conflict?.id ?? "";
    await m.resolveConflict(conflictId, {
      action: "keep_existing",
      candidateId: conflict?.candidates[0]?.id ?? "",
    });
    expect(await m.listEntities()).toHaveLength(1);

    await m.revertConflict(conflictId);

    expect(await m.listEntities()).toHaveLength(2);
    expect(await m.entityConflicts()).toHaveLength(1);
  });

  it("still resolves a queued pair after the other side was folded by another answer", async () => {
    // On the real store "Claude Code" is the candidate in eleven queued pairs. Answering one
    // of them with keep_new folds "Claude Code" away, and every other row then names an
    // entity that no longer exists. Those rows must stay answerable, or the queue collects
    // questions the user cannot clear.
    await truncateAll(storage);
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await m.init();
    await m.save({ content: "we store beliefs in PostgreSQL" });
    await m.save({ content: "Postgres also runs the queue" });
    await m.index();
    await m.resolveEntities();

    const first = (await m.entityConflicts())[0];
    const shared = first?.candidates[0];
    // Queue a second question against the SAME candidate, by hand.
    const entities = await m.listEntities();
    const other = entities.find((e) => e.id !== shared?.id && e.id !== first?.incoming.id);
    expect(first).toBeDefined();

    // Answer the first with keep_new, which folds the shared candidate away.
    await m.resolveConflict(first?.id ?? "", { action: "keep_new" });
    expect((await m.listEntities()).some((e) => e.id === shared?.id)).toBe(false);
    expect(other).toBeUndefined(); // only the two spellings exist in this fixture

    // A second pass must not re-ask about the pair that is now one row.
    const again = await m.resolveEntities();
    expect(again.queued).toBe(0);
  });

  it("clears a queued pair whose sides have since become the same entity", async () => {
    await truncateAll(storage);
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await m.init();
    await m.save({ content: "we store beliefs in PostgreSQL" });
    await m.save({ content: "Postgres also runs the queue" });
    await m.index();
    await m.resolveEntities();

    const conflict = (await m.entityConflicts())[0];
    const incomingId = conflict?.incoming.id ?? "";
    const candidateId = conflict?.candidates[0]?.id ?? "";
    // Fold them together directly, behind the queue's back.
    await m.mergeEntities(incomingId, candidateId);

    // The queued question is now moot. Answering it must settle the row, not throw.
    await m.resolveConflict(conflict?.id ?? "", {
      action: "keep_existing",
      candidateId,
    });
    expect(await m.entityConflicts()).toHaveLength(0);
    expect(await m.listEntities()).toHaveLength(1);
  });

  it("follows a moved candidate when the queued spelling is chosen as canonical", async () => {
    // keep_new folds the CANDIDATE into the queued spelling. The other new test covers the
    // case where both sides converge on one row; this covers the other half, where chasing
    // moves the candidate to a different live row. The fold must follow it there, in the
    // right direction: the queued spelling survives and absorbs, not the reverse.
    await truncateAll(storage);
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await m.init();
    await m.save({ content: "we store beliefs in PostgreSQL" });
    await m.save({ content: "Postgres also runs the queue" });
    await m.save({ content: "Claude Code is the CLI" });
    await m.index();
    await m.resolveEntities();

    const conflict = (await m.entityConflicts())[0];
    const candidateId = conflict?.candidates[0]?.id ?? "";
    const elsewhere = (await m.listEntities()).find((e) => e.name === "Claude Code");
    expect(elsewhere).toBeDefined();

    // Another decision absorbs the candidate, so the queued row now names a dead id.
    await m.mergeEntities(candidateId, elsewhere?.id ?? "");

    await m.resolveConflict(conflict?.id ?? "", { action: "keep_new" });

    const names = (await m.listEntities()).map((e) => e.name);
    expect(names).toContain(conflict?.incoming.name);
    expect(names).not.toContain("Claude Code"); // followed and folded in, not left behind
    expect(names).not.toContain(conflict?.candidates[0]?.name);
  });

  it("rejects the merge action, which needs prose an entity does not have", async () => {
    const m = await seeded();
    const conflict = (await m.entityConflicts())[0];
    await expect(
      m.resolveConflict(conflict?.id ?? "", { action: "merge", content: "Postgres" }),
    ).rejects.toThrow(/does not apply to entities/);
  });
});
