import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";

// Node versioning: a belief is a chain of versions sharing a root_id; the newest active row is
// current, older ones are stale but queryable via history(). The dedup classifier is scripted
// so each test controls whether a save is a restatement (identical) or a contradiction.

function classifierReturning(relation: string): ScriptedLLMProvider {
  return new ScriptedLLMProvider((prompt) =>
    prompt.includes("classify how each existing")
      ? `[{"candidate": 1, "relation": "${relation}", "reason": "test"}]`
      : "[]",
  );
}

describe("node versioning", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh(llm: ScriptedLLMProvider): Promise<Memloom> {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({ storage, embedding: new HashingEmbeddingProvider(1024), llm });
    await memloom.init();
    return memloom;
  }

  it("a restatement appends a new version and stales the prior one; recall shows only current", async () => {
    const m = await fresh(classifierReturning("identical"));
    const a = await m.save({ content: "the sky is blue" });
    expect(a.outcome).toBe("added");

    const b = await m.save({ content: "the sky is blue today" });
    expect(b.outcome).toBe("versioned");
    expect(b.version).toBe(2);

    const hist = await m.history(b.id);
    expect(hist.map((h) => h.version)).toEqual([2, 1]);
    expect(hist.find((h) => h.version === 2)?.status).toBe("active");
    expect(hist.find((h) => h.version === 1)?.status).toBe("stale");
    expect(new Set(hist.map((h) => h.rootId)).size).toBe(1); // one lineage
    expect(await m.history(a.id)).toHaveLength(2); // reachable from either version's id

    const active = await m.memories();
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(2);
  });

  it("a verbatim re-save is merged, not versioned", async () => {
    const m = await fresh(classifierReturning("identical"));
    const a = await m.save({ content: "water is wet" });
    const b = await m.save({ content: "water is wet" });
    expect(b.outcome).toBe("merged");
    expect(b.id).toBe(a.id);
    expect(await m.memories()).toHaveLength(1);
  });

  it("update() edits a belief into a new current version", async () => {
    const m = await fresh(classifierReturning("complementary"));
    const a = await m.save({ content: "deploy on friday" });
    const u = await m.update({ id: a.id, content: "deploy on monday" });
    expect(u.version).toBe(2);
    expect(u.rootId).toBe(a.id); // a was the root

    const hist = await m.history(a.id);
    expect(hist.map((h) => h.content)).toEqual(["deploy on monday", "deploy on friday"]);
    const active = await m.memories();
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toBe("deploy on monday");
  });

  it("update() refuses a stale or unknown memory", async () => {
    const m = await fresh(classifierReturning("complementary"));
    const a = await m.save({ content: "port is 3000" });
    await m.update({ id: a.id, content: "port is 4000" }); // a is now stale
    await expect(m.update({ id: a.id, content: "port is 5000" })).rejects.toThrow(/no active/);
  });

  it("resolving keep_new makes the change a version step; revert restores lineage", async () => {
    const m = await fresh(classifierReturning("contradictory"));
    const a = await m.save({ content: "staging runs Postgres" });
    const b = await m.save({ content: "staging runs MySQL" });
    expect(b.outcome).toBe("conflict");
    expect(a).toBeDefined();
    expect((await m.memories()).length).toBe(2); // both active pre-resolution (HITL)

    await m.resolveConflict(b.conflictId as string, { action: "keep_new" });
    const hist = await m.history(b.id);
    expect(hist.map((h) => h.content)).toEqual(["staging runs MySQL", "staging runs Postgres"]);
    expect(hist.find((h) => h.content.includes("Postgres"))?.status).toBe("stale");
    expect((await m.memories()).length).toBe(1);

    await m.revertConflict(b.conflictId as string);
    expect((await m.memories()).length).toBe(2); // both active again
    expect(await m.history(b.id)).toHaveLength(1); // b back on its own root
  });

  it("keep_both leaves two independent beliefs, not a version chain", async () => {
    const m = await fresh(classifierReturning("contradictory"));
    const a = await m.save({ content: "cats are better" });
    const b = await m.save({ content: "cats are worse" });
    await m.resolveConflict(b.conflictId as string, { action: "keep_both" });
    expect((await m.memories()).length).toBe(2);
    expect(await m.history(a.id)).toHaveLength(1);
    expect(await m.history(b.id)).toHaveLength(1);
  });
});
