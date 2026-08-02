import type { StorageAdapter } from "@memloom/core";
import {
  type FetchLike,
  HashingEmbeddingProvider,
  HttpMemloomClient,
  Memloom,
  PgliteAdapter,
  ScriptedLLMProvider,
  truncateAll,
} from "@memloom/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./index.js";

// HttpMemloomClient talks to the HTTP surface. We point it at the Hono app's request handler
// (no network), proving a surface can drive the engine remotely with the same MemoryEngine API.

const contradictory = new ScriptedLLMProvider(
  () => '[{"candidate": 1, "relation": "contradictory", "reason": "different"}]',
);

// The two beliefs the re-check pass is scripted to clash, and a model that quotes both verbatim
// so the finding survives verification. The save path is answered separately and sees nothing,
// which is the situation that pass exists for.
const OLD_BELIEF = "the deploy target is fly.io";
const NEW_BELIEF = "we run on railway now";
const recheckArbiter = new ScriptedLLMProvider((prompt) => {
  if (!prompt.startsWith("You compare a NEW memory")) return "[]";
  if (!prompt.includes("These ARE contradictions")) {
    return JSON.stringify([{ candidate: 1, relation: "complementary", reason: "unrelated" }]);
  }
  return JSON.stringify([
    {
      candidate: 1,
      relation: "contradictory",
      reason: "deploy target changed",
      new_quote: NEW_BELIEF,
      old_quote: OLD_BELIEF,
    },
  ]);
});

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

describe("HttpMemloomClient", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function client() {
    await truncateAll(storage);
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

  /**
   * A client over a store holding exactly one unconfirmed contradiction.
   *
   * The hashing embedding provider is not semantic, so the two beliefs are made each other's
   * nearest neighbour by hand: cosine is all the re-check pass sees. The pass is driven on the
   * engine because which passes run is not something the HTTP reconcile route takes.
   */
  async function clientWithPossible() {
    await truncateAll(storage);
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: recheckArbiter,
      autoIndexDelayMs: 999_999,
    });
    await memloom.init();
    await memloom.save({ content: OLD_BELIEF });
    await memloom.save({ content: NEW_BELIEF });
    await storage.query(
      `UPDATE memory_objects SET embedding = (
         SELECT embedding FROM memory_objects WHERE content = $1 LIMIT 1
       ) WHERE content = $2`,
      [OLD_BELIEF, NEW_BELIEF],
    );
    await memloom.reconcile({ mode: "apply", passes: ["llm_recheck"] });
    const app = createServer(memloom);
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

  it("possible contradictions and answering one over HTTP", async () => {
    const c = await clientWithPossible();
    const possible = await c.possibleContradictions();
    expect(possible).toHaveLength(1);
    expect(possible[0]?.newQuote).toBe(NEW_BELIEF);
    expect(possible[0]?.oldQuote).toBe(OLD_BELIEF);
    expect(possible[0]?.reason).toContain("deploy target changed");
    // Approving is what writes the conflict row, so the queue is empty until then.
    expect(await c.conflicts()).toHaveLength(0);

    const answer = await c.answerPossible(possible[0]?.id as string, "approved");
    expect(answer.conflictId).toBeTruthy();
    expect(await c.conflicts()).toHaveLength(1);
    expect(await c.possibleContradictions()).toHaveLength(0);
  });

  it("a rejection over HTTP records the pair and raises nothing", async () => {
    const c = await clientWithPossible();
    const [finding] = await c.possibleContradictions();
    const answer = await c.answerPossible(finding?.id as string, "rejected");
    expect(answer).toEqual({ conflictId: null, decision: "rejected" });
    expect(await c.possibleContradictions()).toHaveLength(0);
    expect(await c.conflicts()).toHaveLength(0);
  });

  it("stopping a run that is not going answers instead of failing", async () => {
    const c = await client();
    expect(await c.stopReconcile("00000000-0000-0000-0000-000000000000")).toEqual({ stopped: false });
  });
});

// The daemon binds 127.0.0.1, but cors() alone does not block a cross-site request: it only
// withholds response headers, so a handler's side effects still fire. These guard against a
// drive-by POST /admin/shutdown from any visited page and against DNS rebinding.
describe("access-control gate", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function app() {
    await truncateAll(storage);
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: contradictory,
    });
    await memloom.init();
    let stopped = false;
    const server = createServer(memloom, {
      onShutdown: async () => {
        stopped = true;
      },
    });
    return { server, wasStopped: () => stopped };
  }

  it("rejects a cross-site Origin and does not run the handler", async () => {
    const { server, wasStopped } = await app();
    const res = await server.request("http://127.0.0.1:4319/admin/shutdown", {
      method: "POST",
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
    // The shutdown side effect must NOT have fired.
    expect(wasStopped()).toBe(false);
  });

  it("rejects a non-loopback Host (DNS rebinding)", async () => {
    const { server } = await app();
    const res = await server.request("http://127.0.0.1:4319/memory/list", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a same-origin viewer request", async () => {
    const { server } = await app();
    const res = await server.request("http://127.0.0.1:4319/memory/list", {
      headers: { origin: "http://127.0.0.1:4319", host: "127.0.0.1:4319" },
    });
    expect(res.status).toBe(200);
  });

  it("allows a non-browser client that sends no Origin", async () => {
    const { server } = await app();
    const res = await server.request("http://127.0.0.1:4319/memory/list", {
      headers: { host: "127.0.0.1:4319" },
    });
    expect(res.status).toBe(200);
  });
});
