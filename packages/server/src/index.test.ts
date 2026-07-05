import {
  HashingEmbeddingProvider,
  Memloom,
  PgliteAdapter,
  ScriptedLLMProvider,
} from "@memloom/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./index.js";

// Exercise the HTTP surface end-to-end via Hono's request helper (no network needed).

const extractor = new ScriptedLLMProvider((prompt) =>
  prompt.includes("Postgres") ? '[{"name":"Postgres","type":"technology"}]' : "[]",
);

describe("server", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function app() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();
    return createServer(memloom);
  }

  it("health check", async () => {
    const res = await (await app()).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("save then query round-trips", async () => {
    const server = await app();
    const saved = await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "the staging database runs on Postgres" }),
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { outcome: string }).outcome).toBe("added");

    const queried = await server.request("/memory/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "staging database" }),
    });
    const { memories } = (await queried.json()) as { memories: Array<{ content: string }> };
    expect(memories[0]?.content).toContain("staging database");
  });

  it("index then graph exposes entities", async () => {
    const server = await app();
    await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "we run Postgres in production" }),
    });
    await server.request("/memory/index", { method: "POST" });
    const graph = (await (await server.request("/memory/graph")).json()) as {
      entities: Array<{ name: string }>;
    };
    expect(graph.entities.map((e) => e.name)).toContain("Postgres");
  });
});
