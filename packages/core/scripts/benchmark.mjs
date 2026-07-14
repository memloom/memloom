// Live retrieval benchmark against a real embedding model. Reproduces production-grade
// recall@k / MRR numbers: the Phase 2 "validate the real numbers" gate.
//
// Usage:
//   pnpm --filter @memloom/core build
//   OPENROUTER_API_KEY=sk-... node packages/core/scripts/benchmark.mjs [path/to/corpus.json]
//
// Provide your own corpus (same shape as corpus.sample.json) for a real evaluation; the
// bundled sample is tiny and only exercises the wiring.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Memloom,
  OpenRouterEmbeddings,
  OpenRouterLLM,
  PgliteAdapter,
  runBenchmark,
} from "../dist/index.js";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY to run the live benchmark.");
  process.exit(1);
}

const corpusPath =
  process.argv[2] ?? fileURLToPath(new URL("./corpus.sample.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const storage = await PgliteAdapter.open();
const memloom = new Memloom({
  storage,
  embedding: new OpenRouterEmbeddings({ apiKey }),
  llm: new OpenRouterLLM({ apiKey }),
  dedup: false, // seed the benchmark corpus raw so dedup can't merge similar docs
});
await memloom.init();

console.log(`Seeding ${corpus.docs.length} docs, running ${corpus.queries.length} queries...`);
const report = await runBenchmark(memloom, corpus);
console.log("\nRetrieval benchmark");
console.log("-------------------");
console.log(`queries     ${report.count}`);
console.log(`MRR         ${report.mrr.toFixed(3)}`);
console.log(`recall@1    ${report.recallAt1.toFixed(3)}`);
console.log(`recall@5    ${report.recallAt5.toFixed(3)}`);
console.log(`recall@10   ${report.recallAt10.toFixed(3)}`);

await storage.close();
