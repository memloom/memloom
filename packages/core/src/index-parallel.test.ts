import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { LLMProvider } from "./providers.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";

// The parallel index run: extractions overlap, writes stay serialized (no duplicate
// entities from racing read-check-insert), the circuit breaker stops a run whose
// provider is down instead of failing every remaining item, and a resume finishes the
// job. Providers here are hand-rolled: the tests need async delays and mid-run failure
// toggles that the sync ScriptedLLMProvider cannot express.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extracts one "Postgres" entity per item, slowly, and records call overlap. */
class SlowExtractor implements LLMProvider {
  inFlight = 0;
  maxInFlight = 0;
  async complete(): Promise<string> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await sleep(25);
    this.inFlight--;
    return JSON.stringify({
      entities: [{ name: "Postgres", type: "technology" }],
      relationships: [],
    });
  }
}

/** Fails while `down` is true; extracts nothing when healthy. */
class FlakyExtractor implements LLMProvider {
  down = true;
  async complete(): Promise<string> {
    if (this.down) throw new Error("fetch failed (ECONNRESET)");
    return JSON.stringify({ entities: [], relationships: [] });
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  delete process.env.MEMLOOM_INDEX_CONCURRENCY;
});

async function fresh(llm: LLMProvider): Promise<Memloom> {
  await truncateAll(storage);
  const m = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm,
    dedup: false,
  });
  await m.init();
  return m;
}

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

describe("parallel index run", () => {
  it("overlaps extractions but never duplicates a shared entity", async () => {
    const llm = new SlowExtractor();
    const m = await fresh(llm);
    for (let i = 0; i < 8; i++) await m.save({ content: `note ${i} about the database` });

    const events: number[] = [];
    const result = await m.index(undefined, (e) => events.push(e.index));
    expect(result.indexed).toBe(8);
    // Extractions genuinely ran concurrently...
    expect(llm.maxInFlight).toBeGreaterThan(1);

    // ...yet the serialized write phase resolved every mention to ONE entity node.
    const graph = await m.graph();
    expect(graph.entities.filter((e) => e.name === "Postgres")).toHaveLength(1);
    expect(graph.edges.filter((e) => e.relation === "mention")).toHaveLength(8);

    // The run counter reports entities CREATED (one), not the eight resolves: the
    // console's "+N entities" has to reconcile with the entity table.
    const [run] = await m.listIndexRuns();
    expect(run?.entitiesLinked).toBe(1);

    // Progress arrived in completion order with a clean 1..N counter.
    expect([...events].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("respects MEMLOOM_INDEX_CONCURRENCY=1 (fully sequential)", async () => {
    process.env.MEMLOOM_INDEX_CONCURRENCY = "1";
    const llm = new SlowExtractor();
    const m = await fresh(llm);
    for (let i = 0; i < 4; i++) await m.save({ content: `note ${i}` });
    await m.index();
    expect(llm.maxInFlight).toBe(1);
  });

  it("trips the breaker after 5 consecutive failures, then a resume finishes the job", async () => {
    process.env.MEMLOOM_INDEX_CONCURRENCY = "1";
    const llm = new FlakyExtractor();
    const m = await fresh(llm);
    for (let i = 0; i < 12; i++) await m.save({ content: `doomed note ${i}` });

    const first = await m.index();
    expect(first.indexed).toBe(0);

    const [run] = await m.listIndexRuns();
    expect(run?.status).toBe("interrupted");
    // Exactly the threshold failed; the other 7 were never attempted, no wasted calls.
    expect(run?.itemsFailed).toBe(5);

    llm.down = false;
    const second = await m.index();
    expect(second.indexed).toBe(12);
    const [resumed] = await m.listIndexRuns();
    expect(resumed?.status).toBe("success");
  });

  it("scattered failures do not trip the breaker; failed items resume later", async () => {
    process.env.MEMLOOM_INDEX_CONCURRENCY = "1";
    // Every third call fails: consecutive-failure count keeps resetting.
    let calls = 0;
    const llm: LLMProvider = {
      async complete() {
        calls++;
        if (calls % 3 === 0) throw new Error("fetch failed (ECONNRESET)");
        return JSON.stringify({ entities: [], relationships: [] });
      },
    };
    const m = await fresh(llm);
    for (let i = 0; i < 9; i++) await m.save({ content: `note ${i}` });

    const first = await m.index();
    expect(first.indexed).toBe(6);
    const [run] = await m.listIndexRuns();
    expect(run?.status).toBe("warning");
    expect(run?.itemsFailed).toBe(3);

    // The failed three are still pending; a re-run picks up exactly those (and the
    // every-third-fails provider deterministically fails one of them again).
    const second = await m.index();
    expect(second.indexed).toBe(2);
  });
});
