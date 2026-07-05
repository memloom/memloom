import { afterEach, describe, expect, it } from "vitest";
import {
  HashingEmbeddingProvider,
  NullLLMProvider,
  ScriptedLLMProvider,
} from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { LLMProvider } from "./providers.js";

// Phase 3: the belief pipeline. Uses a scripted LLM so the full classify -> route -> resolve
// path is deterministic without a live model.

const contradictory = new ScriptedLLMProvider(
  () =>
    '[{"candidate": 1, "relation": "contradictory", "reason": "different value for the same thing"}]',
);
const complementary = new ScriptedLLMProvider(
  () => '[{"candidate": 1, "relation": "complementary", "reason": "both can be true"}]',
);

describe("belief pipeline", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function make(llm: LLMProvider): Promise<Memloom> {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({ storage, embedding: new HashingEmbeddingProvider(1024), llm });
    await m.init();
    return m;
  }

  async function statusOf(m: Memloom, id: string): Promise<string> {
    const [r] = await m.deps.storage.query<{ status: string }>(
      "SELECT status FROM memory_objects WHERE id = $1",
      [id],
    );
    return r?.status ?? "missing";
  }

  async function edgeCount(m: Memloom, relation: string): Promise<number> {
    const [r] = await m.deps.storage.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_edges WHERE relation = $1 AND active",
      [relation],
    );
    return Number(r?.n ?? 0);
  }

  async function makeConflict() {
    const m = await make(contradictory);
    const a = await m.save({ content: "the deploy window is friday afternoon" });
    const b = await m.save({ content: "the deploy window is monday morning" });
    expect(b.outcome).toBe("conflict");
    expect(b.conflictId).toBeDefined();
    return { m, aId: a.id, bId: b.id, conflictId: b.conflictId as string };
  }

  it("merges an exact duplicate without calling the LLM", async () => {
    const m = await make(new NullLLMProvider());
    const a = await m.save({ content: "unique fact alpha bravo charlie" });
    const b = await m.save({ content: "unique fact alpha bravo charlie" });
    expect(b.outcome).toBe("merged");
    expect(b.id).toBe(a.id);
    const [c] = await m.deps.storage.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_objects",
    );
    expect(Number(c?.n)).toBe(1);
  });

  it("adds a complementary memory (no conflict)", async () => {
    const m = await make(complementary);
    await m.save({ content: "the database uses postgres for storage" });
    const b = await m.save({ content: "the database uses redis for caching" });
    expect(b.outcome).toBe("added");
    expect(await m.conflicts()).toHaveLength(0);
  });

  it("flags a contradiction as a conflict, both kept active", async () => {
    const { m, aId, bId } = await makeConflict();
    expect(await statusOf(m, aId)).toBe("active");
    expect(await statusOf(m, bId)).toBe("active");
    const conflicts = await m.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.incoming.id).toBe(bId);
    expect(conflicts[0]?.candidates[0]?.id).toBe(aId);
  });

  it("keep_new: the new memory supersedes the existing one", async () => {
    const { m, aId, bId, conflictId } = await makeConflict();
    await m.resolveConflict(conflictId, { action: "keep_new" });
    expect(await statusOf(m, aId)).toBe("stale");
    expect(await statusOf(m, bId)).toBe("active");
    expect(await edgeCount(m, "replaces")).toBe(1);
    expect(await m.conflicts()).toHaveLength(0);
  });

  it("keep_existing: the existing memory wins", async () => {
    const { m, aId, bId, conflictId } = await makeConflict();
    await m.resolveConflict(conflictId, { action: "keep_existing", candidateId: aId });
    expect(await statusOf(m, aId)).toBe("active");
    expect(await statusOf(m, bId)).toBe("stale");
  });

  it("keep_both: both stay active, distinct edge recorded", async () => {
    const { m, aId, bId, conflictId } = await makeConflict();
    await m.resolveConflict(conflictId, { action: "keep_both" });
    expect(await statusOf(m, aId)).toBe("active");
    expect(await statusOf(m, bId)).toBe("active");
    expect(await edgeCount(m, "distinct")).toBe(1);
  });

  it("merge: a reconciled memory supersedes both", async () => {
    const { m, aId, bId, conflictId } = await makeConflict();
    await m.resolveConflict(conflictId, {
      action: "merge",
      content: "the deploy window is friday afternoon; monday deploys are exceptions",
    });
    expect(await statusOf(m, aId)).toBe("stale");
    expect(await statusOf(m, bId)).toBe("stale");
    expect(await edgeCount(m, "replaces")).toBe(2);
    const [active] = await m.deps.storage.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_objects WHERE status = 'active'",
    );
    expect(Number(active?.n)).toBe(1);
  });

  it("revert: restores staled memories and re-queues the conflict", async () => {
    const { m, aId, conflictId } = await makeConflict();
    await m.resolveConflict(conflictId, { action: "keep_new" });
    expect(await statusOf(m, aId)).toBe("stale");

    await m.revertConflict(conflictId);
    expect(await statusOf(m, aId)).toBe("active");
    expect(await edgeCount(m, "replaces")).toBe(0);
    expect(await m.conflicts()).toHaveLength(1);
  });
});
