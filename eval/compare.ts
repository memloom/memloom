import { readFileSync } from "node:fs";
import { type Aggregate, pct } from "./lib/score.js";

// Before/after table from two run files: pnpm eval:compare eval/runs/before.json eval/runs/after.json

interface Report {
  label: string;
  prompt: string;
  distill: { provider: string; calls: number; usd: number };
  judge: { provider: string; calls: number; usd: number };
  totals: Aggregate;
  byKind: Aggregate[];
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: compare <before.json> <after.json>");
  process.exit(1);
}
const before = JSON.parse(readFileSync(beforePath, "utf8")) as Report;
const after = JSON.parse(readFileSync(afterPath, "utf8")) as Report;

const cell = (a: Aggregate, metric: "recall" | "advice" | "dup" | "per") => {
  switch (metric) {
    case "recall":
      return `${a.recalled}/${a.expected} (${pct(a.recalled, a.expected)})`;
    case "advice":
      return `${a.generic}/${a.extracted} (${pct(a.generic, a.extracted)})`;
    case "dup":
      return `${a.duplicates}/${a.extracted} (${pct(a.duplicates, a.extracted)})`;
    case "per":
      return a.fixtures ? (a.extracted / a.fixtures).toFixed(1) : "-";
  }
};

const rows: string[] = [];
rows.push(
  `Before: \`${before.label}\` (prompt=${before.prompt}, ${before.distill.provider}); ` +
    `after: \`${after.label}\` (prompt=${after.prompt}, ${after.distill.provider}); ` +
    `judge ${after.judge.provider}.`,
);
rows.push("");
rows.push("| kind | metric | before | after |");
rows.push("|---|---|---|---|");
const kinds = [...before.byKind.map((k) => k.folder), "all"] as const;
for (const kind of kinds) {
  const b = kind === "all" ? before.totals : before.byKind.find((k) => k.folder === kind);
  const a = kind === "all" ? after.totals : after.byKind.find((k) => k.folder === kind);
  if (!b || !a) continue;
  rows.push(`| ${kind} | facts recalled | ${cell(b, "recall")} | ${cell(a, "recall")} |`);
  rows.push(`| ${kind} | advice wrongly stored | ${cell(b, "advice")} | ${cell(a, "advice")} |`);
  rows.push(`| ${kind} | duplicates | ${cell(b, "dup")} | ${cell(a, "dup")} |`);
  rows.push(`| ${kind} | memories per transcript | ${cell(b, "per")} | ${cell(a, "per")} |`);
}
console.log(rows.join("\n"));
