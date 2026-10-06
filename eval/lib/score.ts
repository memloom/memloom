import type { FixtureKind } from "./fixtures.js";
import type { Grounding } from "./judge.js";

// Per-fixture results and their roll-up. Three headline numbers per transcript kind:
//   recall      expected memories the extractor covered / expected memories
//   advice      extracted memories the judge called generic (assistant advice, general
//               knowledge) / extracted memories; the failure the Phase 0 probe found
//   duplicates  extracted memories that restate another one / extracted memories
// plus counts that explain them (memories per transcript, unsupported, parser drops).

export interface MemoryResult {
  content: string;
  type: string;
  source?: string;
  grounding?: Grounding;
}

export interface FixtureResult {
  id: string;
  folder: FixtureKind;
  kind: string;
  chunks: number;
  expected: number;
  recalled: number;
  /** Per expected memory: the 1-based extracted index that covers it, 0 = missed. */
  coverage: number[];
  extracted: number;
  generic: number;
  unsupported: number;
  duplicates: number;
  dropped: number;
  memories: MemoryResult[];
  error?: string;
}

export interface Aggregate {
  folder: FixtureKind | "all";
  fixtures: number;
  expected: number;
  recalled: number;
  extracted: number;
  generic: number;
  unsupported: number;
  duplicates: number;
  dropped: number;
  errors: number;
}

export function aggregate(results: readonly FixtureResult[], folder: Aggregate["folder"]): Aggregate {
  const rows = folder === "all" ? results : results.filter((r) => r.folder === folder);
  const sum = (pick: (r: FixtureResult) => number) => rows.reduce((a, r) => a + pick(r), 0);
  return {
    folder,
    fixtures: rows.length,
    expected: sum((r) => r.expected),
    recalled: sum((r) => r.recalled),
    extracted: sum((r) => r.extracted),
    generic: sum((r) => r.generic),
    unsupported: sum((r) => r.unsupported),
    duplicates: sum((r) => r.duplicates),
    dropped: sum((r) => r.dropped),
    errors: rows.filter((r) => r.error).length,
  };
}

export const pct = (n: number, d: number): string => (d === 0 ? "-" : `${((100 * n) / d).toFixed(0)}%`);

export function summaryTable(results: readonly FixtureResult[], folders: readonly FixtureKind[]): string {
  const rows = [...folders.map((f) => aggregate(results, f)), aggregate(results, "all")];
  const header =
    "| kind | transcripts | expected | recalled | extracted | advice stored | duplicates | unsupported | dropped by parser |\n" +
    "|---|---|---|---|---|---|---|---|---|";
  const body = rows
    .filter((r) => r.fixtures > 0)
    .map(
      (r) =>
        `| ${r.folder} | ${r.fixtures}${r.errors ? ` (${r.errors} failed)` : ""} | ${r.expected} | ` +
        `${r.recalled} (${pct(r.recalled, r.expected)}) | ${r.extracted} | ` +
        `${r.generic} (${pct(r.generic, r.extracted)}) | ${r.duplicates} (${pct(r.duplicates, r.extracted)}) | ` +
        `${r.unsupported} | ${r.dropped} |`,
    )
    .join("\n");
  return `${header}\n${body}`;
}
