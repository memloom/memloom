import type { Memloom } from "./memloom.js";
import { type EvalReport, evaluate } from "./metrics.js";

// The retrieval benchmark. Seeds a corpus, runs each query through recall(), and scores
// recall@k / MRR against the labeled relevant set. The mechanism is CI-tested with the
// deterministic hashing provider; run it with a real embedding model (scripts/benchmark.mjs)
// to reproduce production-grade numbers.

export interface BenchDoc {
  key: string;
  content: string;
  canonical?: string;
}

export interface BenchQuery {
  text: string;
  /** Keys of the docs that count as correct for this query. */
  relevant: string[];
}

export interface BenchCorpus {
  docs: BenchDoc[];
  queries: BenchQuery[];
}

export async function runBenchmark(
  memloom: Memloom,
  corpus: BenchCorpus,
  limit = 10,
): Promise<EvalReport> {
  const keyToId = new Map<string, string>();
  for (const doc of corpus.docs) {
    const { id } = await memloom.save({ content: doc.content, canonical: doc.canonical });
    keyToId.set(doc.key, id);
  }

  const results = [];
  for (const query of corpus.queries) {
    const recalled = await memloom.recall(query.text, { limit });
    const retrieved = recalled.map((m) => m.id);
    const relevant = new Set(
      query.relevant.map((k) => keyToId.get(k)).filter((x): x is string => x !== undefined),
    );
    results.push({ retrieved, relevant });
  }
  return evaluate(results);
}
