import type { StorageAdapter } from "@memloom/core";
import {
  HashingEmbeddingProvider,
  Memloom,
  NullLLMProvider,
  PgliteAdapter,
  truncateAll,
} from "@memloom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listScopes, recallMemory, saveMemory } from "./tools.js";

// The scope-aware MCP surface (PLAN-memory-scopes.md child 2): what an agent actually reads
// back. Answers, not errors: an unknown folder must come back as instructive text, because
// the agent's next move (call list_scopes, pick one) is written in it.

let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

async function make(): Promise<Memloom> {
  await truncateAll(storage);
  const m = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm: new NullLLMProvider(),
    dedup: false,
  });
  await m.init();
  return m;
}

describe("scope-aware mcp tools", () => {
  it("list_scopes renders copyable paths with counts and the widening rule", async () => {
    const m = await make();
    await m.createScope("projects/memloom", { description: "the engine" });
    await m.save({ content: "a fact", scope: "projects/memloom" });
    const text = await listScopes(m);
    expect(text).toContain("projects/memloom (1 memories) - the engine");
    expect(text).toContain("uncategorized [system]");
    expect(text).toContain("global [system]");
    expect(text).toContain('"*" searches everything');
  });

  it("save into an unknown folder answers with the fix instead of throwing", async () => {
    const m = await make();
    const text = await saveMemory(m, { content: "x", scope: "no-such" });
    expect(text).toMatch(/unknown scope/);
    expect(text).toContain("list_scopes");
    // and nothing was saved
    expect(await m.memories()).toHaveLength(0);
  });

  it("scoped recall shows each hit's folder and stays out of other scopes", async () => {
    const m = await make();
    await m.createScope("personal-life");
    await m.createScope("projects");
    await m.save({ content: "sigma personal fact", scope: "personal-life", tags: ["fun"] });
    await m.save({ content: "sigma project fact", scope: "projects" });

    const text = await recallMemory(m, { query: "sigma", scope: "personal-life" });
    expect(text).toContain("sigma personal fact");
    expect(text).not.toContain("sigma project fact");
    expect(text).toContain("- scope personal-life");
    expect(text).toContain("- tags fun");
  });

  it("an empty scoped recall names the scope and the escape hatch", async () => {
    const m = await make();
    await m.createScope("personal-life");
    const text = await recallMemory(m, { query: "anything", scope: "personal-life" });
    expect(text).toContain('scope "personal-life"');
    expect(text).toContain('"*"');
  });

  it("an unknown recall scope answers with the folder tree pointer", async () => {
    const m = await make();
    const text = await recallMemory(m, { query: "x", scope: "bogus" });
    expect(text).toMatch(/unknown scope/);
    expect(text).toContain("list_scopes");
  });
});
