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

  it("allows local browser origins via CORS, refuses foreign ones", async () => {
    const server = await app();
    const local = await server.request("/health", {
      headers: { origin: "http://localhost:3000" },
    });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

    const foreign = await server.request("/health", {
      headers: { origin: "https://evil.example.com" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("shutdown endpoint acks then invokes the hook", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();

    let stopped = false;
    const server = createServer(memloom, {
      onShutdown: async () => {
        stopped = true;
      },
    });
    const res = await server.request("/admin/shutdown", { method: "POST" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    expect(stopped).toBe(true);

    // Without the hook, the route does not exist at all.
    const bare = createServer(memloom);
    expect((await bare.request("/admin/shutdown", { method: "POST" })).status).toBe(404);
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

  it("rejects bad request bodies with a 400 naming the field", async () => {
    const server = await app();

    // The real-world mistake: a resolve payload posted to /memory/query.
    const wrongShape = await server.request("/memory/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "supersede", winnerId: "x" }),
    });
    expect(wrongShape.status).toBe(400);
    const queryErr = (await wrongShape.json()) as { issues: Array<{ path: string }> };
    expect(queryErr.issues.some((i) => i.path === "query")).toBe(true);

    const emptySave = await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(emptySave.status).toBe(400);

    const badAction = await server.request("/memory/conflicts/some-id/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "supersede" }),
    });
    expect(badAction.status).toBe(400);

    const notJson = await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: string }).error).toContain("valid JSON");
  });

  it("responds 503 fast when the store is locked instead of hanging", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();
    // Simulate a wire client holding PGLite's exclusive lock: the probe never resolves.
    (memloom as unknown as { ping: () => Promise<void> }).ping = () => new Promise(() => {});
    const server = createServer(memloom);

    const res = await server.request("/memory/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("Postgres wire client");
  });

  it("engine errors surface as JSON 500, not bare text", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();
    const server = createServer(memloom);

    // Resolving a conflict that doesn't exist throws inside the engine.
    const res = await server.request(
      "/memory/conflicts/00000000-0000-0000-0000-000000000001/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "keep_both" }),
      },
    );
    expect(res.status).toBe(500);
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
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
