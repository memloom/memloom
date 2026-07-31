import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageAdapter } from "@memloom/core";
import {
  CATALOG,
  type ChatProvider,
  findModel,
  HashingEmbeddingProvider,
  type LLMProvider,
  Memloom,
  PgliteAdapter,
  registerExtractor,
  ScriptedLLMProvider,
  truncateAll,
} from "@memloom/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./index.js";

// Exercise the HTTP surface end-to-end via Hono's request helper (no network needed).

// Match only the TEXT section: the prompt's KNOWN ENTITIES list would otherwise trip
// the matcher with names extracted from earlier items.
const extractor = new ScriptedLLMProvider((prompt) =>
  prompt.slice(prompt.indexOf("TEXT:")).includes("Postgres")
    ? '[{"name":"Postgres","type":"technology"}]'
    : "[]",
);

// One store for the whole file, emptied between tests. See test-store.ts: booting PGLite
// costs about six seconds and the tests themselves cost milliseconds, so a store per test
// spends effectively all of its wall clock on Postgres startup.
let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

describe("server", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function app() {
    await truncateAll(storage);
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

  it("import notify confines paths to the Claude Code sessions directory", async () => {
    const server = await app();
    // An arbitrary local file must never become LLM input via the notify endpoint.
    const outside = await server.request("/import/claude-code/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "C:\\Windows\\system32\\drivers\\etc\\hosts" }),
    });
    expect(outside.status).toBe(400);
    // Traversal out of the root is caught after normalization.
    const traversal = await server.request("/import/claude-code/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: join(homedir(), ".claude", "projects", "..", "..", "secret.jsonl"),
      }),
    });
    expect(traversal.status).toBe(400);
    // Inside the root but not a transcript: refused.
    const notJsonl = await server.request("/import/claude-code/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(homedir(), ".claude", "projects", "p", "notes.txt") }),
    });
    expect(notJsonl.status).toBe(400);
    // A well-formed transcript path is accepted for async processing.
    const ok = await server.request("/import/claude-code/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: join(
          homedir(),
          ".claude",
          "projects",
          "p",
          "00000000-0000-0000-0000-000000000000.jsonl",
        ),
      }),
    });
    expect(ok.status).toBe(202);
  });

  it("import scope round-trips through the HTTP surface", async () => {
    const server = await app();
    const put = await server.request("/import/claude-code/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { projects: ["memloom"] } }),
    });
    expect(put.status).toBe(200);
    const status = await server.request("/import/claude-code/status");
    expect(((await status.json()) as { scope: unknown }).scope).toEqual({ projects: ["memloom"] });
  });

  it("import/sessions/stream validates the body", async () => {
    const res = await (await app()).request("/import/sessions/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: -3 }),
    });
    expect(res.status).toBe(400);
  });

  it("import/sessions/stream streams a done event on a dry run", async () => {
    // dryRun never touches an LLM or the store; on a machine without transcripts the run
    // legitimately reports zero sessions, so only the stream contract is asserted here
    // (the import behavior itself is covered in core's import.test.ts).
    const res = await (await app()).request("/import/sessions/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true, project: "no-such-project-name-anywhere" }),
    });
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({ type: "done", dryRun: true });
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
    await truncateAll(storage);
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
    await truncateAll(storage);
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

  // The streaming variant exists because transcribing an hour of audio takes 8 to 11
  // minutes, far past what a plain request can hold open without looking hung. Markdown
  // emits no progress of its own, so this asserts the envelope rather than the events.
  it("context add streams NDJSON and ends with a done line", async () => {
    const server = await app();
    const dir = mkdtempSync(join(tmpdir(), "memloom-ctx-stream-"));
    writeFileSync(join(dir, "a.md"), "# A\nthe staging database is Postgres");
    writeFileSync(join(dir, "b.md"), "# B\nmore notes here");

    const res = await server.request("/context/add/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const lines = (await res.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; stage?: string; documents?: number });

    // One completion line per file as it lands, so a folder of recordings reports as it goes
    // rather than only at the end.
    expect(lines.filter((l) => l.type === "item" && l.stage === "file")).toHaveLength(2);

    const done = lines.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.documents).toBe(2);
  });

  // A single file must come back as a ContextAddResult, the same shape /context/add returns.
  // This route answered folder-shaped totals for every request, so a caller reading
  // `outcome` got undefined and crashed on it.
  it("context add stream returns a single file's own result, not folder totals", async () => {
    const server = await app();
    const dir = mkdtempSync(join(tmpdir(), "memloom-ctx-one-"));
    const file = join(dir, "solo.md");
    writeFileSync(file, "# Solo\nthe staging database is Postgres");

    const res = await server.request("/context/add/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: file }),
    });
    expect(res.status).toBe(200);

    const done = (await res.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .at(-1);

    expect(done?.type).toBe("done");
    expect(done?.outcome).toBe("added");
    expect(done?.title).toBeTruthy();
    expect(done?.documentId).toBeTruthy();
    expect(done?.chunks).toBeGreaterThan(0);
  });

  it("context add stream rejects a missing path up front, not mid-stream", async () => {
    const server = await app();
    const res = await server.request("/context/add/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(tmpdir(), "memloom-does-not-exist-12345") }),
    });
    expect(res.status).toBe(400);
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

  it("auto-index toggle: unavailable without a stance, toggles and persists with one", async () => {
    // The default test engine never mentions autoIndex: no toggle, setter refused.
    const bare = await app();
    const off = (await (await bare.request("/memory/auto-index")).json()) as {
      enabled: boolean;
      available: boolean;
    };
    expect(off).toEqual({ enabled: false, available: false });
    const refused = await bare.request("/memory/auto-index", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(refused.status).toBe(409);

    // A daemon-like engine (flag passed) can toggle, and the choice survives a "restart"
    // (a second engine on the same storage reads the persisted value in init).
    await truncateAll(storage);
    const config = {
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
      autoIndex: false,
      autoIndexDelayMs: 60_000, // never fires during the test
    };
    const memloom = new Memloom(config);
    await memloom.init();
    const server = createServer(memloom);

    const patched = await server.request("/memory/auto-index", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ enabled: true });

    const restarted = new Memloom(config);
    await restarted.init();
    expect(restarted.autoIndexEnabled).toBe(true);
    expect(restarted.autoIndexAvailable).toBe(true);
  });

  it("entity routes: list with counts, patch, merge, delete", async () => {
    const server = await app();
    await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "the staging database runs on Postgres" }),
    });
    await server.request("/memory/index", { method: "POST" });

    const list = (await (await server.request("/memory/entities")).json()) as {
      entities: Array<{ id: string; name: string; entityType: string; mentions: number }>;
    };
    expect(list.entities).toHaveLength(1);
    const entity = list.entities[0];
    expect(entity).toMatchObject({ name: "Postgres", entityType: "technology", mentions: 1 });

    // The arbitration button's route. Registered ahead of /memory/entities/:id, so it must
    // answer JSON rather than being read as an entity id, and with nothing queued it makes no
    // calls at all: this pass costs one per pair and never runs as a side effect.
    const auto = await server.request("/memory/entities/resolve-auto", { method: "POST" });
    expect(auto.status).toBe(200);
    expect((await auto.json()) as { calls: number }).toMatchObject({
      calls: 0,
      folded: 0,
      rejected: 0,
      unsure: 0,
    });

    const patched = await server.request(`/memory/entities/${entity?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "PostgreSQL", entityType: "tool" }),
    });
    expect(patched.status).toBe(200);
    const badType = await server.request(`/memory/entities/${entity?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityType: "starship" }),
    });
    expect(badType.status).toBe(400);

    const selfMerge = await server.request(`/memory/entities/${entity?.id}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ into: entity?.id }),
    });
    expect(selfMerge.status).toBe(400);

    const deleted = await server.request(`/memory/entities/${entity?.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const gone = await server.request(`/memory/entities/${entity?.id}`, { method: "DELETE" });
    expect(gone.status).toBe(404);
  });

  it("related route: resolves by name, filters by type, and 404s on an unknown target", async () => {
    // Registered ABOVE /memory/entities/:id, so the first thing this proves is that "related"
    // is not being read as an entity id by the router.
    const server = await app();
    await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "the staging database runs on Postgres" }),
    });
    await server.request("/memory/index", { method: "POST" });

    const ok = await server.request("/memory/entities/related?q=Postgres");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { entity: { name: string }; related: unknown[] };
    expect(body.entity.name).toBe("Postgres");
    expect(Array.isArray(body.related)).toBe(true);

    const filtered = await server.request("/memory/entities/related?q=Postgres&type=person");
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { related: unknown[] }).related).toEqual([]);

    expect((await server.request("/memory/entities/related?q=Nobody")).status).toBe(404);
    // A missing target is a bad request, not an empty answer about nothing.
    expect((await server.request("/memory/entities/related")).status).toBe(400);
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
    await truncateAll(storage);
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

  it("conflict round trip over HTTP: resolve, list resolved history, revert re-queues", async () => {
    await truncateAll(storage);
    const contradictory = new ScriptedLLMProvider((prompt) =>
      prompt.includes("classify how each existing")
        ? '[{"candidate": 1, "relation": "contradictory", "reason": "different value"}]'
        : "[]",
    );
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: contradictory,
    });
    await memloom.init();
    const server = createServer(memloom);

    for (const content of ["the deploy window is friday", "the deploy window is monday"]) {
      await server.request("/memory/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
    }
    const { conflicts } = (await (await server.request("/memory/conflicts")).json()) as {
      conflicts: Array<{ id: string }>;
    };
    expect(conflicts).toHaveLength(1);
    const conflictId = conflicts[0]?.id as string;

    await server.request(`/memory/conflicts/${conflictId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "keep_new" }),
    });
    const resolvedRes = await server.request("/memory/conflicts/resolved");
    expect(resolvedRes.status).toBe(200);
    const resolved = (await resolvedRes.json()) as {
      conflicts: Array<{ id: string; resolution: string; resolvedAt: string }>;
    };
    expect(resolved.conflicts).toHaveLength(1);
    expect(resolved.conflicts[0]?.resolution).toBe("keep_new");
    expect(new Date(resolved.conflicts[0]?.resolvedAt as string).getTime()).not.toBeNaN();

    await server.request(`/memory/conflicts/${conflictId}/revert`, { method: "POST" });
    const requeued = (await (await server.request("/memory/conflicts")).json()) as {
      conflicts: unknown[];
    };
    expect(requeued.conflicts).toHaveLength(1);
    const emptied = (await (await server.request("/memory/conflicts/resolved")).json()) as {
      conflicts: unknown[];
    };
    expect(emptied.conflicts).toHaveLength(0);
  });

  it("reconciles over HTTP, and RECONCILE_ENABLED=0 stops it acting", async () => {
    const server = await app();
    await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "the staging database runs on Postgres" }),
    });

    const res = await server.request("/memory/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      run: { id: string; mode: string; scanned: number };
      estimate: { window: number; usd: number | null };
    };
    expect(report.run.mode).toBe("dry_run");
    expect(report.run.scanned).toBe(1);
    expect(report.estimate.window).toBe(1);

    const runs = (await (await server.request("/memory/reconcile/runs")).json()) as {
      runs: Array<{ id: string }>;
    };
    expect(runs.runs.map((r) => r.id)).toEqual([report.run.id]);

    // The Console expands a run by reading its findings back. This has to answer JSON: a path
    // no route claims falls through to the viewer's index.html, which is a 200 the client
    // cannot parse, and the row it feeds sits on "loading" forever.
    const actionsRes = await server.request(`/memory/reconcile/runs/${report.run.id}/actions`);
    expect(actionsRes.headers.get("content-type")).toContain("application/json");
    expect((await actionsRes.json()) as { actions: unknown[] }).toHaveProperty("actions");
    // An unknown id is an empty run, never another owner's ledger.
    const strangerRes = await server.request(`/memory/reconcile/runs/${randomUUID()}/actions`);
    expect((await strangerRes.json()) as { actions: unknown[] }).toEqual({ actions: [] });

    // Which passes run is the user's setting, and the two that spend money start off. A host
    // that wants the reports and none of the repairs sets the kill switch instead.
    const settings = (await (await server.request("/memory/reconcile/settings")).json()) as Record<
      string,
      boolean
    >;
    expect(settings).toMatchObject({ invariants: true, entities: true, llm_entities: false });

    const saved = await server.request("/memory/reconcile/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entities: false }),
    });
    expect(((await saved.json()) as { entities: boolean }).entities).toBe(false);

    process.env.RECONCILE_ENABLED = "0";
    const applied = await server.request("/memory/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "apply" }),
    });
    expect(applied.status).toBe(403);
    delete process.env.RECONCILE_ENABLED;

    const missing = await server.request(`/memory/reconcile/${randomUUID()}/revert`, {
      method: "POST",
    });
    expect(missing.status).toBe(404);
  });

  it("deletes a memory over HTTP; a made-up id maps to 404", async () => {
    const server = await app();
    const saved = await server.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "the staging database runs on Postgres" }),
    });
    const { id } = (await saved.json()) as { id: string };

    const del = await server.request(`/memory/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const list = (await (await server.request("/memory/list")).json()) as {
      memories: unknown[];
    };
    expect(list.memories).toHaveLength(0);

    const missing = await server.request(`/memory/${crypto.randomUUID()}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
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
    await truncateAll(storage);
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
    await truncateAll(storage);
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
    await truncateAll(storage);
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

  it("context/url ingests caller-supplied html, so no test ever hits the network", async () => {
    const server = await app();
    const html =
      "<html><head><title>Deploy Guide</title></head><body><article>" +
      "<h1>Deploy Guide</h1><h2>Database</h2>" +
      "<p>the staging database runs postgres seventeen with pgvector enabled for recall</p>" +
      "<p>checkpoints are written by the ingest worker every thirty seconds without fail</p>" +
      "</article></body></html>";

    const added = await server.request("/context/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/deploy?utm_source=x#top", html }),
    });
    expect(added.status).toBe(200);
    const result = (await added.json()) as { outcome: string; documentId: string };
    expect(result.outcome).toBe("added");

    // Stored under the normalized URL: tracking parameters and the fragment are gone.
    const listed = await server.request("/context/documents");
    const { documents } = (await listed.json()) as { documents: Array<{ path: string }> };
    expect(documents).toHaveLength(1);
    expect(documents[0]?.path).toBe("https://example.com/deploy");

    // An extraction failure answers 400 with a stable code, not a 500.
    const thin = await server.request("/context/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/spa",
        html: "<html><body><div id='root'></div></body></html>",
      }),
    });
    expect(thin.status).toBe(400);
    expect((await thin.json()) as { code: string }).toMatchObject({ code: "empty" });

    // A non-URL is refused by validation before anything is fetched.
    const bad = await server.request("/context/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "/etc/passwd" }),
    });
    expect(bad.status).toBe(400);
  });

  it("open route launches the injected opener for known documents only", async () => {
    await truncateAll(storage);
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

  it("context upload: bytes become a global document; open refuses (no disk file)", async () => {
    const server = await app();
    const contentBase64 = Buffer.from("# Notes\nthe staging database runs on Postgres").toString(
      "base64",
    );

    const res = await server.request("/context/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "notes.md", contentBase64 }),
    });
    expect(res.status).toBe(200);
    const uploaded = (await res.json()) as { documentId: string; outcome: string; chunks: number };
    expect(uploaded.outcome).toBe("added");
    expect(uploaded.chunks).toBeGreaterThan(0);

    // First-class document: listed with upload:// provenance, same bytes are a no-op.
    const docs = (await (await server.request("/context/documents")).json()) as {
      documents: Array<{ id: string; path: string }>;
    };
    expect(docs.documents.map((d) => d.path)).toEqual(["upload://notes.md"]);
    const again = await server.request("/context/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "notes.md", contentBase64 }),
    });
    expect(((await again.json()) as { outcome: string }).outcome).toBe("unchanged");

    // Nothing on disk to open; unsupported extensions refused.
    const open = await server.request(`/context/documents/${uploaded.documentId}/open`, {
      method: "POST",
    });
    expect(open.status).toBe(400);
    const badExt = await server.request("/context/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "image.png", contentBase64 }),
    });
    expect(badExt.status).toBe(400);
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
    await truncateAll(storage);
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
    await truncateAll(storage);
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

// The speech-model routes. MEMLOOM_MODEL_DIR points at a throwaway directory for every test
// here, so nothing reads a real install, overwrites a real selection, or downloads 465 MB.
describe("speech models over HTTP", () => {
  let dir: string;
  const originalDir = process.env.MEMLOOM_MODEL_DIR;
  const originalModel = process.env.MEMLOOM_ASR_MODEL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memloom-server-models-"));
    process.env.MEMLOOM_MODEL_DIR = dir;
    delete process.env.MEMLOOM_ASR_MODEL;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.MEMLOOM_MODEL_DIR;
    else process.env.MEMLOOM_MODEL_DIR = originalDir;
    if (originalModel === undefined) delete process.env.MEMLOOM_ASR_MODEL;
    else process.env.MEMLOOM_ASR_MODEL = originalModel;
  });

  /** Lay down the files an unpacked model would have, without downloading one. */
  function fakeInstall(id: string, files: string[]) {
    const modelDir = join(dir, findModel(id).archive);
    mkdirSync(modelDir, { recursive: true });
    for (const f of [...files, "tokens.txt"]) writeFileSync(join(modelDir, f), "x");
  }

  const PARAKEET_FILES = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"];

  async function app() {
    await truncateAll(storage);
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();
    return createServer(memloom);
  }

  it("lists the whole catalog with install and selection state in one call", async () => {
    fakeInstall("sense-voice", ["model.int8.onnx"]);
    const res = await (await app()).request("/audio/models");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      dir: string;
      ffmpeg: boolean;
      selected: string;
      installed: boolean;
      models: Array<{ id: string; downloadMb: number; installed: boolean; selected: boolean }>;
    };
    expect(payload.dir).toBe(dir);
    expect(typeof payload.ffmpeg).toBe("boolean");
    // Every catalog row is present, so a picker renders the un-downloaded ones too.
    expect(payload.models).toHaveLength(CATALOG.length);
    expect(payload.models.find((m) => m.id === "sense-voice")).toMatchObject({ installed: true });
    expect(payload.models.find((m) => m.id === "parakeet-v3")).toMatchObject({
      installed: false,
      selected: true,
      downloadMb: 465,
    });
    // The default is selected but not on disk: the state the viewer must offer setup for.
    expect(payload.selected).toBe("parakeet-v3");
    expect(payload.installed).toBe(false);
  });

  it("select switches the model transcription would use", async () => {
    fakeInstall("sense-voice", ["model.int8.onnx"]);
    const server = await app();
    const res = await server.request("/audio/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "sense-voice" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, selected: "sense-voice", installed: true });

    const after = (await (await server.request("/audio/models")).json()) as { selected: string };
    expect(after.selected).toBe("sense-voice");
  });

  it("select answers an unknown model with a 400 and its code, never a 500", async () => {
    const server = await app();
    const res = await server.request("/audio/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gpt-voice" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("no_model");
    expect(body.error).toMatch(/unknown speech model/);

    const empty = await server.request("/audio/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

  it("setup/stream rejects an unknown id before it opens the stream", async () => {
    const res = await (await app()).request("/audio/setup/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gpt-voice" }),
    });
    // A 200 here would mean the failure could only arrive as an in-band error line.
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "no_model" });
  });

  // The requirement with the most reach: /context/add is where a missing model or a missing
  // ffmpeg actually surfaces, and without the mapping it would be an opaque 500.
  it("context/add answers 400 with a code when a recording cannot be transcribed", async () => {
    const files = mkdtempSync(join(tmpdir(), "memloom-server-media-"));
    const recording = join(files, "interview.mp3");
    writeFileSync(recording, "not really audio");
    try {
      const res = await (await app()).request("/context/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: recording }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      // No model in the throwaway dir, and the bytes are not decodable either, so which
      // wall it hits depends on the machine. What matters is that it is a coded 400.
      expect(["no_model", "no_ffmpeg", "no_asr", "decode_failed"]).toContain(body.code);
      expect(body.error.length).toBeGreaterThan(0);
    } finally {
      rmSync(files, { recursive: true, force: true });
    }
  });

  it("setup/stream streams a done event and downloads nothing when everything is present", async () => {
    // Setup is idempotent, so with the model, the VAD, and the diarization pair already on
    // disk it must reach done without touching the network. This is also the only way to
    // exercise the stream contract without a 465 MB download.
    fakeInstall("parakeet-v3", PARAKEET_FILES);
    writeFileSync(join(dir, "silero_vad.onnx"), "x");
    mkdirSync(join(dir, "sherpa-onnx-pyannote-segmentation-3-0"), { recursive: true });
    writeFileSync(join(dir, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"), "x");
    writeFileSync(join(dir, "wespeaker_en_voxceleb_resnet34_LM.onnx"), "x");

    const res = await (await app()).request("/audio/setup/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await res.text())
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l.type === "error")).toBe(false);
    expect(lines.some((l) => l.stage === "download")).toBe(false);
    expect(lines.at(-1)).toMatchObject({
      type: "done",
      selected: "parakeet-v3",
      installed: true,
    });
  });
});

// ----------------------------------------------------------------------------------------
// The speaker routes: media bytes for the labeling UI, and the rename PATCH. A fake .wav
// extractor stands in for the ASR pipeline (the same trick as core's speakers.test.ts): it
// emits exactly the markdown shape transcribeMedia produces plus a roster, so these tests
// exercise the HTTP surface without models, ffmpeg, or a real recording. Registered for
// .wav only; the coded-400 media test above uses .mp3 and still hits the real extractor.
// ----------------------------------------------------------------------------------------

const SPEAKER_TRANSCRIPT = [
  "## 0:00 - 0:05, Speaker 1",
  "",
  "Hello and welcome.",
  "## 0:05 - 0:12, Speaker 2",
  "",
  "Glad to be here.",
].join("\n");

registerExtractor({
  kind: "audio",
  extensions: [".wav"],
  version: 1,
  chunker: "markdown",
  async extract() {
    return {
      units: [{ text: SPEAKER_TRANSCRIPT, page: null }],
      speakers: {
        version: 1 as const,
        embeddingModel: "test",
        speakers: [
          {
            id: 1,
            label: "Speaker 1",
            name: null,
            seconds: 5,
            sampleStart: 0,
            sampleEnd: 5,
            embedding: null,
          },
          {
            id: 2,
            label: "Speaker 2",
            name: null,
            seconds: 7,
            sampleStart: 5,
            sampleEnd: 12,
            embedding: null,
          },
        ],
      },
    };
  },
});

describe("speaker routes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memloom-server-speakers-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function appWithRecording() {
    await truncateAll(storage);
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
    });
    await memloom.init();
    const server = createServer(memloom);
    const path = join(dir, "standup.wav");
    writeFileSync(path, "RIFF-not-really-audio-but-bytes-all-the-same");
    const added = await server.request("/context/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    expect(added.status).toBe(200);
    const { documentId } = (await added.json()) as { documentId: string };
    return { server, documentId, path };
  }

  it("lists the roster on the document", async () => {
    const { server } = await appWithRecording();
    const res = await server.request("/context/documents");
    const { documents } = (await res.json()) as {
      documents: Array<{ kind: string; speakers?: { speakers: unknown[] } | null }>;
    };
    expect(documents[0]?.kind).toBe("audio");
    expect(documents[0]?.speakers?.speakers).toHaveLength(2);
  });

  it("serves the recording's bytes with Range support", async () => {
    const { server, documentId } = await appWithRecording();

    const whole = await server.request(`/context/documents/${documentId}/media`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/wav");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await whole.text()).toBe("RIFF-not-really-audio-but-bytes-all-the-same");

    const part = await server.request(`/context/documents/${documentId}/media`, {
      headers: { range: "bytes=5-8" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 5-8/44");
    expect(await part.text()).toBe("not-");

    const past = await server.request(`/context/documents/${documentId}/media`, {
      headers: { range: "bytes=999999-" },
    });
    expect(past.status).toBe(416);
  });

  it("refuses media for a document that is not a recording", async () => {
    const { server } = await appWithRecording();
    const md = join(dir, "notes.md");
    writeFileSync(md, "# hello");
    const added = await server.request("/context/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: md }),
    });
    const { documentId } = (await added.json()) as { documentId: string };
    const res = await server.request(`/context/documents/${documentId}/media`);
    expect(res.status).toBe(400);
  });

  it("renames a speaker and the chunk breadcrumbs follow", async () => {
    const { server, documentId } = await appWithRecording();
    const res = await server.request(`/context/documents/${documentId}/speakers`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speakerId: 2, name: "Alice" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      speakers: { speakers: Array<{ id: number; name: string | null }> };
    };
    expect(body.speakers.speakers.find((s) => s.id === 2)?.name).toBe("Alice");

    const chunks = await server.request(`/context/documents/${documentId}/chunks`);
    const { chunks: rows } = (await chunks.json()) as {
      chunks: Array<{ headingPath: string | null }>;
    };
    expect(rows.map((r) => r.headingPath)).toEqual([
      "0:00 - 0:05, Speaker 1",
      "0:05 - 0:12, Alice",
    ]);
  });

  it("validates sample ranges before touching ffmpeg", async () => {
    const { server, documentId } = await appWithRecording();
    const bad = async (qs: string) =>
      (await server.request(`/context/documents/${documentId}/sample?${qs}`)).status;
    expect(await bad("start=5&end=2")).toBe(400);
    expect(await bad("start=abc&end=9")).toBe(400);
    expect(await bad("start=0&end=99")).toBe(400);
    // The fixture's bytes are not real audio, so a valid range reaches ffmpeg and fails
    // there: a coded 500, not a hang and not a 200 with garbage.
    const res = await server.request(`/context/documents/${documentId}/sample?start=0&end=4`);
    expect(res.status).toBe(500);
  });

  it("refuses a sample for a document that is not a recording", async () => {
    const { server } = await appWithRecording();
    const md = join(dir, "sample-notes.md");
    writeFileSync(md, "# hello");
    const added = await server.request("/context/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: md }),
    });
    const { documentId } = (await added.json()) as { documentId: string };
    const res = await server.request(`/context/documents/${documentId}/sample?start=0&end=4`);
    expect(res.status).toBe(400);
  });

  it("answers 400 for an unknown speaker and 404 for an unknown document", async () => {
    const { server, documentId } = await appWithRecording();
    const unknown = await server.request(`/context/documents/${documentId}/speakers`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speakerId: 9, name: "Bob" }),
    });
    expect(unknown.status).toBe(400);
    const missing = await server.request(
      "/context/documents/00000000-0000-0000-0000-000000000001/speakers",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ speakerId: 1, name: "Bob" }),
      },
    );
    expect(missing.status).toBe(404);
  });
});
