import {
  HashingEmbeddingProvider,
  Memloom,
  PgliteAdapter,
  ScriptedLLMProvider,
} from "@memloom/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  listConflicts,
  memoryHistory,
  recallMemory,
  resolveConflict,
  saveMemory,
} from "./tools.js";

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

  it("recall_memory formats items as title / content / saved / similarity lists", async () => {
    const m = await fresh();
    await saveMemory(m, {
      content: "the staging database is postgres",
      canonical: "staging DB engine",
    });
    await saveMemory(m, { content: "the staging database lives in Frankfurt" });

    const recalled = await recallMemory(m, { query: "staging database" });
    const items = recalled.split("\n---\n");
    expect(items).toHaveLength(2);

    // The canonical becomes the title; without one, the content leads.
    const titled = items.find((i) => i.startsWith("staging DB engine")) as string;
    const lines = titled.split("\n");
    expect(lines[1]).toBe("- the staging database is postgres");
    expect(lines[2]).toMatch(/^- saved \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(lines[3]).toMatch(/^- similarity \d\.\d{2}$/);

    const untitled = items.find((i) => !i.startsWith("staging DB engine")) as string;
    expect(untitled.startsWith("the staging database lives in Frankfurt")).toBe(true);
  });

  it("recall exposes a memory id, and memory_history returns the version chain", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new ScriptedLLMProvider(() => "[]"),
    });
    await m.init();

    const a = await saveMemory(m, { content: "the api runs on port 3000" });
    const id = a.match(/Saved memory (\S+)\./)?.[1] as string;
    const recalled = await recallMemory(m, { query: "api port" });
    expect(recalled).toContain(`- id ${id}`);

    // Edit into a new version (a human action; driven directly here).
    await m.update({ id, content: "the api runs on port 4000" });
    const hist = await memoryHistory(m, { memoryId: id });
    const entries = hist.split("\n---\n");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("v2 (current");
    expect(entries[0]).toContain("port 4000");
    expect(entries[1]).toContain("v1 (superseded");
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
