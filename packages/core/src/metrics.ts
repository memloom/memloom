// Retrieval-quality metrics. Pure functions — the measurement foundation for the benchmark
// (and unit-tested so we trust the numbers). `retrieved` is an ordered list of ids (best
// first); `relevant` is the set of ids that count as correct for that query.

/** Fraction of the relevant set found within the top k retrieved. */
export function recallAtK(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  const top = retrieved.slice(0, k);
  for (const id of top) if (relevant.has(id)) hits++;
  return hits / relevant.size;
}

/** 1 / (rank of the first relevant result), or 0 if none is retrieved. */
export function reciprocalRank(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
): number {
  for (let i = 0; i < retrieved.length; i++) {
    const id = retrieved[i];
    if (id !== undefined && relevant.has(id)) return 1 / (i + 1);
  }
  return 0;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export interface QueryResult {
  retrieved: string[];
  relevant: Set<string>;
}

export interface EvalReport {
  count: number;
  mrr: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
}

/** Aggregate MRR and recall@{1,5,10} over many queries. */
export function evaluate(results: readonly QueryResult[]): EvalReport {
  return {
    count: results.length,
    mrr: mean(results.map((r) => reciprocalRank(r.retrieved, r.relevant))),
    recallAt1: mean(results.map((r) => recallAtK(r.retrieved, r.relevant, 1))),
    recallAt5: mean(results.map((r) => recallAtK(r.retrieved, r.relevant, 5))),
    recallAt10: mean(results.map((r) => recallAtK(r.retrieved, r.relevant, 10))),
  };
}
