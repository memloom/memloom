import {
  HashingEmbeddingProvider,
  Memloom,
  PgliteAdapter,
  ScriptedLLMProvider,
} from "@memloom/core";
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts, recallMemory, resolveConflict, saveMemory } from "./tools.js";

// The MCP tool functions are pure over a Memloom, so we test them directly (the stdio wiring
// in server.ts/bin.ts is thin). Uses a scripted LLM for the conflict path.

const contradictory = new ScriptedLLMProvider(
  () => '[{"candidate": 1, "relation": "contradictory", "reason": "different value"}]',
);

describe("mcp tools", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: contradictory,
    });
    await memloom.init();
    return memloom;
  }

  it("save_memory then recall_memory", async () => {
    const m = await fresh();
    const saved = await saveMemory(m, { content: "the staging database is postgres" });
    expect(saved).toContain("Saved memory");

    const recalled = await recallMemory(m, { query: "staging database" });
    expect(recalled).toContain("staging database");
  });

  it("save_memory reports a conflict, list + resolve work", async () => {
    const m = await fresh();
    await saveMemory(m, { content: "the deploy window is friday afternoon" });
    const conflicted = await saveMemory(m, { content: "the deploy window is monday morning" });
    expect(conflicted).toContain("CONTRADICTS");

    const list = await listConflicts(m);
    expect(list).toContain("Conflict");

    const conflictId = (await m.conflicts())[0]?.id as string;
    const resolved = await resolveConflict(m, { conflictId, action: "keep_new" });
    expect(resolved).toContain("keep_new");
    expect(await listConflicts(m)).toBe("No pending conflicts.");
  });
});
