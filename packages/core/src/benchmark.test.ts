import { afterEach, describe, expect, it } from "vitest";
import { type BenchCorpus, runBenchmark } from "./benchmark.js";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";

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

describe("benchmark harness", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  it("scores a labeled corpus", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
    });
    await m.init();

    const report = await runBenchmark(m, CORPUS);
    expect(report.count).toBe(3);
    expect(report.mrr).toBeGreaterThan(0);
    expect(report.mrr).toBeLessThanOrEqual(1);
    expect(report.recallAt10).toBeCloseTo(1); // small corpus: every relevant doc is within 10
  });
});
