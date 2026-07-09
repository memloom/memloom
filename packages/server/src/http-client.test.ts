import {
  type FetchLike,
  HashingEmbeddingProvider,
  HttpMemloomClient,
  Memloom,
  PgliteAdapter,
  ScriptedLLMProvider,
} from "@memloom/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./index.js";

// HttpMemloomClient talks to the HTTP surface. We point it at the Hono app's request handler
// (no network), proving a surface can drive the engine remotely with the same MemoryEngine API.

const contradictory = new ScriptedLLMProvider(
  () => '[{"candidate": 1, "relation": "contradictory", "reason": "different"}]',
);

describe("HttpMemloomClient", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function client() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: contradictory,
    });
    await memloom.init();
    const app = createServer(memloom);
    // Route the client's fetch at the Hono app directly (no network).
    const fetchImpl: FetchLike = async (url, init) => app.request(url, init as RequestInit);
    return new HttpMemloomClient("", fetchImpl);
  }

  it("save + recall over HTTP", async () => {
    const c = await client();
    const saved = await c.save({ content: "the staging database is postgres" });
    expect(saved.outcome).toBe("added");
    const results = await c.recall("staging database");
    expect(results[0]?.content).toContain("staging database");
  });

  it("update + history over HTTP", async () => {
    const c = await client();
    const a = await c.save({ content: "the api runs on port 3000" });
    const edited = await c.update({ id: a.id, content: "the api runs on port 4000" });
    expect(edited.version).toBe(2);

    const versions = await c.history(a.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]?.content).toContain("4000");

    // Recall returns only the current version.
    const results = await c.recall("api port");
    expect(results.filter((r) => r.kind !== "context")).toHaveLength(1);
    expect(results.find((r) => r.content.includes("port"))?.content).toContain("4000");
  });

  it("conflict flow over HTTP", async () => {
    const c = await client();
    await c.save({ content: "the deploy window is friday afternoon" });
    const conflicted = await c.save({ content: "the deploy window is monday morning" });
    expect(conflicted.outcome).toBe("conflict");

    const conflicts = await c.conflicts();
    expect(conflicts).toHaveLength(1);

    const id = conflicts[0]?.id as string;
    await c.resolveConflict(id, { action: "keep_new" });
    expect(await c.conflicts()).toHaveLength(0);
  });
});
