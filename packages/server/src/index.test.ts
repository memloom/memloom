import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("lists active memories with their type and date", async () => {
    const server = await app();
    for (const body of [
      { content: "the staging database runs on Postgres" },
      { content: "prefers pnpm over npm", memoryType: "preference" },
    ]) {
      await server.request("/memory/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    const res = await server.request("/memory/list");
    expect(res.status).toBe(200);
    const { memories } = (await res.json()) as {
      memories: Array<{ content: string; memoryType: string; createdAt: string }>;
    };
    expect(memories).toHaveLength(2);
    const pref = memories.find((m) => m.content.includes("pnpm"));
    expect(pref?.memoryType).toBe("preference");
    for (const m of memories) expect(new Date(m.createdAt).getTime()).not.toBeNaN();
  });

  it("accepts a valid memoryType and rejects one outside the taxonomy", async () => {
    const server = await app();

    const ok = await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "prefers pnpm over npm", memoryType: "preference" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { outcome: string }).outcome).toBe("added");

    const bad = await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", memoryType: "banana" }),
    });
    expect(bad.status).toBe(400);
    const err = (await bad.json()) as { issues: Array<{ path: string }> };
    expect(err.issues.some((i) => i.path === "memoryType")).toBe(true);
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

  it("serves the viewer bundle without shadowing the API", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();

    const dir = mkdtempSync(join(tmpdir(), "memloom-viewer-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "index.html"), "<html><body>viewer</body></html>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");

    const server = createServer(memloom, { staticDir: dir });

    const index = await server.request("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("viewer");

    const asset = await server.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    // Unknown paths fall back to the SPA shell; the API still wins over static.
    expect(await (await server.request("/some/route")).text()).toContain("viewer");
    expect(await (await server.request("/health")).json()).toEqual({ ok: true });

    // Traversal never escapes the bundle dir.
    const evil = await server.request("/..%2f..%2fsecrets.txt");
    expect(await evil.text()).toContain("viewer"); // falls back to index, no file read outside
  });

  it("context routes: add a file, recall it with a source, list, remove", async () => {
    const server = await app();
    const dir = mkdtempSync(join(tmpdir(), "memloom-ctx-http-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const filePath = join(dir, "runbook.md");
    writeFileSync(filePath, "# Runbook\n## Restarts\nrestart the ingest worker with systemctl");

    const added = await server.request("/context/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    expect(added.status).toBe(200);
    const addResult = (await added.json()) as { outcome: string; documentId: string };
    expect(addResult.outcome).toBe("added");

    const queried = await server.request("/memory/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "restart ingest worker" }),
    });
    const { memories } = (await queried.json()) as {
      memories: Array<{ kind?: string; source?: { title: string } }>;
    };
    const chunk = memories.find((m) => m.kind === "context");
    expect(chunk?.source?.title).toBe("Runbook");

    const listed = await server.request("/context/documents");
    expect(((await listed.json()) as { documents: unknown[] }).documents).toHaveLength(1);

    // Drill-down: the chunks route returns the document's chunks (edges need indexing first).
    const drilled = await server.request(`/context/documents/${addResult.documentId}/chunks`);
    expect(drilled.status).toBe(200);
    const { chunks, edges } = (await drilled.json()) as {
      chunks: Array<{ content: string; headingPath: string | null }>;
      edges: unknown[];
    };
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.content).toContain("restart the ingest worker");
    expect(Array.isArray(edges)).toBe(true);

    const removed = await server.request(`/context/documents/${addResult.documentId}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const relisted = await server.request("/context/documents");
    expect(((await relisted.json()) as { documents: unknown[] }).documents).toHaveLength(0);

    // Validation still guards the new surface.
    const bad = await server.request("/context/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
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
