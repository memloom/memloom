import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteFactory } from "./testkit.js";
import type { ConflictAutoEvent } from "./types.js";

// The conflict auto-resolver end to end: a pending conflict seeded through the ordinary
// dedup path is re-judged with context, decisive verdicts land in the revertable history,
// and "unsure" leaves the queue untouched.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

// Scripted brain: the dedup classifier calls everything contradictory (so two similar
// saves produce a conflict), and the resolver answers whatever the test sets.
function scripted(resolverReply: () => string) {
  return new ScriptedLLMProvider((prompt) => {
    if (prompt.startsWith("You compare")) {
      return JSON.stringify([
        { candidate: 1, relation: "contradictory", reason: "cannot both be true" },
      ]);
    }
    if (prompt.startsWith("Two memories")) return resolverReply();
    return "[]";
  });
}

async function seedConflict(llm: ScriptedLLMProvider) {
  const storage = await PgliteFactory.open();
  cleanups.push(() => storage.close());
  const memloom = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm,
    autoIndexDelayMs: 999_999,
  });
  await memloom.init();

  await memloom.save({ content: "the deploy target is fly.io" });
  const second = await memloom.save({ content: "the deploy target is railway" });
  expect(second.outcome).toBe("conflict");
  expect(await memloom.conflicts()).toHaveLength(1);
  return memloom;
}

describe("autoResolveConflicts", () => {
  it("applies a decisive keep_new revertably and empties the queue", async () => {
    const memloom = await seedConflict(
      scripted(() => '[{"verdict":"keep_new","reason":"the newer session shows the change"}]'),
    );

    const events: ConflictAutoEvent[] = [];
    const result = await memloom.autoResolveConflicts(undefined, (e) => events.push(e));

    expect(result).toMatchObject({ examined: 1, resolved: 1, keepNew: 1, unsure: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]?.verdict).toBe("keep_new");
    expect(await memloom.conflicts()).toHaveLength(0);

    const [resolved] = await memloom.resolvedConflicts();
    expect(resolved?.resolution).toBe("keep_new");
    expect((await memloom.memories()).map((m) => m.content)).toEqual([
      "the deploy target is railway",
    ]);

    // The auto-resolution sits in the same history as a human one: revert restores the pair.
    if (resolved) await memloom.revertConflict(resolved.id);
    expect(await memloom.conflicts()).toHaveLength(1);
    expect((await memloom.memories()).map((m) => m.content).sort()).toEqual([
      "the deploy target is fly.io",
      "the deploy target is railway",
    ]);
  });

  it("leaves the queue untouched when the model is unsure", async () => {
    const memloom = await seedConflict(
      scripted(() => '[{"verdict":"unsure","reason":"times are too close"}]'),
    );

    const result = await memloom.autoResolveConflicts();

    expect(result).toMatchObject({ examined: 1, resolved: 0, unsure: 1 });
    expect(await memloom.conflicts()).toHaveLength(1);
    expect(await memloom.resolvedConflicts()).toHaveLength(0);
  });
});
