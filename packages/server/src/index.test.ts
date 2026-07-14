import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatProvider,
  HashingEmbeddingProvider,
  type LLMProvider,
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

  it("reindex/stream wipes entities and streams NDJSON item + done events", async () => {
    const server = await app();
    await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "the staging database runs on Postgres" }),
    });
    expect((await server.request("/memory/index", { method: "POST" })).status).toBe(200);

    const res = await server.request("/memory/reindex/stream", { method: "POST" });
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const items = lines.filter((l) => l.type === "item");
    const done = lines.at(-1);
    expect(items).toHaveLength(1); // the one active memory re-indexed after the wipe
    expect(items[0]?.entities).toEqual(["Postgres"]);
    expect(done).toMatchObject({ type: "done", indexed: 1, chunksIndexed: 0 });
  });

  it("index run sessions are listed, expandable, and deletable over HTTP", async () => {
    const server = await app();
    await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "the staging database runs on Postgres" }),
    });
    await server.request("/memory/index", { method: "POST" });

    const runsRes = await server.request("/memory/index/runs");
    expect(runsRes.status).toBe(200);
    const { runs } = (await runsRes.json()) as {
      runs: Array<{ id: string; status: string; trigger: string; batchSize: number }>;
    };
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "success", trigger: "index", batchSize: 1 });

    const eventsRes = await server.request(`/memory/index/runs/${runs[0]?.id}/events`);
    expect(eventsRes.status).toBe(200);
    const { events } = (await eventsRes.json()) as {
      events: Array<{ level: string; message: string }>;
    };
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain("Postgres");

    const del = await server.request(`/memory/index/runs/${runs[0]?.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = (await (await server.request("/memory/index/runs")).json()) as {
      runs: unknown[];
    };
    expect(after.runs).toHaveLength(0);
  });

  it("assistant chat streams SSE and manages sessions; offline mode 503s", async () => {
    // The default test provider is complete-only, so /assistant/chat must 503 with a hint.
    const offline = await app();
    const denied = await offline.request("/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(denied.status).toBe(503);

    // A chat-capable provider: answers directly, no tools.
    const chatLLM: LLMProvider & ChatProvider = {
      complete: async () => "[]",
      chat: async () => ({ content: "It is Sunday.", toolCalls: [] }),
      chatStream: async () => "unused",
    };
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: chatLLM,
      dedup: false,
    });
    await memloom.init();
    const server = createServer(memloom);

    const res = await server.request("/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "what day is today?" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text())
      .split("\n\n")
      .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
      .filter((l): l is string => Boolean(l))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; sessionId?: string });
    expect(events.at(-1)?.type).toBe("done");
    const sessionId = events.at(-1)?.sessionId ?? "";

    // Session surface: list, rename+star via PATCH, search, delete.
    const list = (await (await server.request("/assistant/sessions")).json()) as {
      sessions: Array<{ id: string; title: string; isStarred: boolean }>;
    };
    expect(list.sessions[0]?.id).toBe(sessionId);
    await server.request(`/assistant/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "daily", starred: true }),
    });
    const found = (await (await server.request("/assistant/sessions/search?q=daily")).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(found.sessions.some((s) => s.id === sessionId)).toBe(true);
    const del = await server.request(`/assistant/sessions/${sessionId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("pick route returns the native picker's paths, 501 when unavailable", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();

    const picked = createServer(memloom, { pickPaths: async () => ["C:\\notes\\a.md"] });
    const ok = await picked.request("/context/pick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "file" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ paths: ["C:\\notes\\a.md"] });

    const bare = createServer(memloom, { pickPaths: async () => null });
    const missing = await bare.request("/context/pick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(501);
  });

  it("browse lists a directory and folder add ingests every supported file", async () => {
    const server = await app();
    const dir = mkdtempSync(join(tmpdir(), "memloom-folder-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "a.md"), "# A\nthe staging database is Postgres");
    writeFileSync(join(dir, "b.txt"), "plain notes");
    writeFileSync(join(dir, "skip.exe"), "binary");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "c.md"), "# C\nnested notes");

    const browsed = (await (
      await server.request(`/context/browse?path=${encodeURIComponent(dir)}`)
    ).json()) as { path: string; entries: Array<{ name: string; kind: string }> };
    expect(browsed.entries.map((e) => e.name)).toEqual(["nested", "a.md", "b.txt"]); // dirs first, .exe hidden

    const res = await server.request("/context/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { documents: number; chunks: number };
    expect(result.documents).toBe(3); // a.md, b.txt, nested/c.md
    expect(result.chunks).toBeGreaterThan(0);

    const docs = (await (await server.request("/context/documents")).json()) as {
      documents: unknown[];
    };
    expect(docs.documents).toHaveLength(3);
  });

  it("schema endpoint reports vocabularies with live counts", async () => {
    const server = await app();
    await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "the staging database runs on Postgres" }),
    });
    await server.request("/memory/index", { method: "POST" });

    const res = await server.request("/memory/schema");
    expect(res.status).toBe(200);
    const schema = (await res.json()) as {
      entityTypes: Array<{ name: string; description: string; count: number }>;
      relations: Array<{ name: string; count: number }>;
      predicates: Array<{ name: string; count: number }>;
    };
    // Zero-filled over the whole vocabulary; the one extracted entity is counted.
    expect(schema.entityTypes.map((t) => t.name)).toContain("technology");
    expect(schema.entityTypes.find((t) => t.name === "technology")?.count).toBe(1);
    expect(schema.entityTypes.find((t) => t.name === "person")?.count).toBe(0);
    expect(schema.relations.find((r) => r.name === "mention")?.count).toBe(1);
    expect(schema.predicates.map((p) => p.name)).toContain("works_on");
  });

  it("schema delete: disabled user entries only, guards mapped to 409/404", async () => {
    const server = await app();
    const added = (await (
      await server.request("/memory/schema", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "entity_type", name: "medication", description: "a drug" }),
      })
    ).json()) as { id: string };

    // Still active: refused with the reason.
    const active = await server.request(`/memory/schema/${added.id}`, { method: "DELETE" });
    expect(active.status).toBe(409);

    await server.request(`/memory/schema/${added.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled" }),
    });
    const deleted = await server.request(`/memory/schema/${added.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const again = await server.request(`/memory/schema/${added.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);

    const schema = (await (await server.request("/memory/schema")).json()) as {
      entityTypes: Array<{ name: string }>;
    };
    expect(schema.entityTypes.map((t) => t.name)).not.toContain("medication");
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

  it("open route launches the injected opener for known documents only", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();

    const openedPaths: string[] = [];
    const server = createServer(memloom, { openPath: (p) => openedPaths.push(p) });

    const dir = mkdtempSync(join(tmpdir(), "memloom-open-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const filePath = join(dir, "notes.md");
    writeFileSync(filePath, "# Notes\nsome context");
    const added = await server.request("/context/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    const { documentId } = (await added.json()) as { documentId: string };

    const opened = await server.request(`/context/documents/${documentId}/open`, {
      method: "POST",
    });
    expect(opened.status).toBe(200);
    expect(openedPaths).toEqual([filePath]);

    const missing = await server.request(
      "/context/documents/00000000-0000-0000-0000-000000000001/open",
      { method: "POST" },
    );
    expect(missing.status).toBe(404);
    expect(openedPaths).toHaveLength(1); // nothing launched for the unknown id
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

  it("attachments: upload creates a session-scoped doc, listed and removable", async () => {
    const server = await app();
    const contentBase64 = Buffer.from("# Brief\nthe kickoff is on tuesday").toString("base64");

    const res = await server.request("/assistant/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "brief.md", contentBase64 }),
    });
    expect(res.status).toBe(200);
    const attached = (await res.json()) as {
      sessionId: string;
      documentId: string;
      outcome: string;
      chunks: number;
    };
    expect(attached.outcome).toBe("added");
    expect(attached.sessionId).toBeTruthy();
    expect(attached.chunks).toBeGreaterThan(0);

    // Listed under the session, absent from the global documents tab.
    const listed = (await (
      await server.request(`/assistant/sessions/${attached.sessionId}/attachments`)
    ).json()) as { attachments: Array<{ id: string }> };
    expect(listed.attachments.map((a) => a.id)).toEqual([attached.documentId]);
    const docs = (await (await server.request("/context/documents")).json()) as {
      documents: unknown[];
    };
    expect(docs.documents).toHaveLength(0);

    // Attaching to a bogus session 404s; a bad extension 400s.
    const bogus = await server.request("/assistant/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "x.md",
        contentBase64,
        sessionId: "00000000-0000-0000-0000-000000000001",
      }),
    });
    expect(bogus.status).toBe(404);
    const badExt = await server.request("/assistant/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "image.png", contentBase64 }),
    });
    expect(badExt.status).toBe(400);

    // The generic document delete works on attachments too.
    const del = await server.request(`/context/documents/${attached.documentId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
  });

  it("models route shapes and caches the OpenRouter catalog", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();

    let fetches = 0;
    const fetchModels = (async () => {
      fetches += 1;
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "anthropic/claude-sonnet-5",
              name: "Anthropic: Claude Sonnet 5",
              description: "A capable model.",
              context_length: 1_000_000,
              pricing: { prompt: "0.000002", completion: "0.00001" },
            },
            {
              id: "google/gemini-2.5-flash",
              name: "Google: Gemini 2.5 Flash",
              description: "Fast.",
              context_length: 1_048_576,
              pricing: { prompt: "0.0000003", completion: "0.0000025" },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    const server = createServer(memloom, {
      defaultChatModel: "google/gemini-2.5-flash",
      fetchModels,
    });

    const res = await server.request("/assistant/models");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      defaultModel: string;
      models: Array<{
        id: string;
        provider: string;
        promptPer1M: number;
        completionPer1M: number;
      }>;
    };
    expect(payload.defaultModel).toBe("google/gemini-2.5-flash");
    const sonnet = payload.models.find((m) => m.id === "anthropic/claude-sonnet-5");
    expect(sonnet).toMatchObject({ provider: "anthropic", promptPer1M: 2, completionPer1M: 10 });

    // Second call is served from the 1h cache: no second upstream fetch.
    await server.request("/assistant/models");
    expect(fetches).toBe(1);
  });

  it("assistant chat accepts a model override in the body", async () => {
    const seenModels: (string | undefined)[] = [];
    const chatLLM: LLMProvider & ChatProvider = {
      complete: async () => "[]",
      chat: async (_m, opts?: { model?: string }) => {
        seenModels.push(opts?.model);
        return { content: "ok", toolCalls: [] };
      },
      chatStream: async () => "unused",
    };
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: chatLLM,
      dedup: false,
    });
    await memloom.init();
    const server = createServer(memloom);

    const res = await server.request("/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", model: "anthropic/claude-sonnet-5" }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream so the turn completes
    expect(seenModels).toEqual(["anthropic/claude-sonnet-5"]);
  });
});
