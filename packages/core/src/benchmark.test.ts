import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BenchCorpus, runBenchmark } from "./benchmark.js";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";

// Proves the benchmark harness itself works (CI). Real MRR numbers need a real model.

const CORPUS: BenchCorpus = {
  docs: [
    { key: "db", content: "the staging database is postgres running on fly.io" },
    { key: "standup", content: "the daily engineering stand-up is at 9am" },
    { key: "deploy", content: "we deploy to production on fridays after code review" },
    { key: "editor", content: "the team prefers tabs over spaces in editor config" },
  ],
  queries: [
    { text: "what database do we use for staging", relevant: ["db"] },
    { text: "when is the daily standup meeting", relevant: ["standup"] },
    { text: "when do we deploy to production", relevant: ["deploy"] },
  ],
};

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

describe("benchmark harness", () => {
  it("scores a labeled corpus", async () => {
    await truncateAll(storage);
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
      dedup: false, // seed the labeled corpus raw
    });
    await m.init();

    const report = await runBenchmark(m, CORPUS);
    expect(report.count).toBe(3);
    expect(report.mrr).toBeGreaterThan(0);
    expect(report.mrr).toBeLessThanOrEqual(1);
    expect(report.recallAt10).toBeCloseTo(1); // small corpus: every relevant doc is within 10
  });
});
