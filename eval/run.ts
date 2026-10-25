import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDistillPrompt,
  type DistilledMemory,
  parseDistillation,
} from "../packages/core/src/distill.js";
import {
  chunksOf,
  FIXTURE_FOLDERS,
  type Fixture,
  type FixtureKind,
  keywordsMatch,
  loadFixtures,
  transcriptText,
} from "./lib/fixtures.js";
import { judgeDuplicates, judgeGrounding, judgeRecall } from "./lib/judge.js";
import { buildProvider, DEFAULT_MODELS, type ProviderName } from "./lib/providers.js";
import { aggregate, type FixtureResult, type MemoryResult, summaryTable } from "./lib/score.js";
import { buildBaselinePrompt } from "./prompts/baseline.js";

// The distillation eval. Distills every fixture with the chosen prompt, then judges the output
// against the hand-written expectations. Writes eval/runs/<label>.json with every extracted
// memory and its labels, so a number in the table can always be traced to the memories
// behind it, and prints the summary table.
//
//   pnpm eval                                   current prompt, claude -p (subscription)
//   pnpm eval -- --prompt baseline --label before
//   pnpm eval -- --provider openrouter --max-usd 1  the shipped model, capped spend
//   pnpm eval -- --judge keywords               no judge calls: keyword recall only
//   pnpm eval -- --kinds advice --only advice-03

interface Args {
  provider: ProviderName;
  model?: string;
  judgeProvider?: ProviderName;
  judgeModel?: string;
  judge: "llm" | "keywords";
  prompt: "current" | "baseline";
  kinds: FixtureKind[];
  only?: string;
  label?: string;
  maxUsd?: number;
  concurrency: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    provider: "claude-cli",
    judge: "llm",
    prompt: "current",
    kinds: [...FIXTURE_FOLDERS],
    concurrency: 3,
  };
  // pnpm forwards its own "--" separator; it is not a flag.
  const words = argv.filter((w) => w !== "--");
  while (words.length > 0) {
    const flag = words.shift() as string;
    const value = () => {
      const v = words.shift();
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--provider":
        args.provider = value() as ProviderName;
        break;
      case "--model":
        args.model = value();
        break;
      case "--judge-provider":
        args.judgeProvider = value() as ProviderName;
        break;
      case "--judge-model":
        args.judgeModel = value();
        break;
      case "--judge":
        args.judge = value() as Args["judge"];
        break;
      case "--prompt":
        args.prompt = value() as Args["prompt"];
        break;
      case "--kinds":
        args.kinds = value().split(",") as FixtureKind[];
        break;
      case "--only":
        args.only = value();
        break;
      case "--label":
        args.label = value();
        break;
      case "--max-usd":
        args.maxUsd = Number(value());
        break;
      case "--concurrency":
        args.concurrency = Number(value());
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return args;
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const fixtures = loadFixtures(join(here, "fixtures"), args.kinds).filter(
    (f) => !args.only || f.id === args.only,
  );
  if (fixtures.length === 0) throw new Error("no fixtures matched");

  const distillModel = args.model ?? DEFAULT_MODELS[args.provider].distill;
  const judgeName = args.judgeProvider ?? args.provider;
  const judgeModel = args.judgeModel ?? DEFAULT_MODELS[judgeName].judge;
  const distiller = buildProvider(args.provider, distillModel, {
    maxUsd: args.maxUsd,
    concurrency: args.concurrency,
  });
  const judge =
    args.judge === "llm"
      ? buildProvider(judgeName, judgeModel, { maxUsd: args.maxUsd, concurrency: args.concurrency })
      : null;
  const buildPrompt = (fixture: Fixture, chunk: Parameters<typeof buildDistillPrompt>[0]) =>
    args.prompt === "baseline"
      ? buildBaselinePrompt(chunk)
      : buildDistillPrompt(chunk, {
          kind: fixture.kind,
          ...(fixture.date ? { recordedAt: fixture.date } : {}),
        });

  console.log(
    `eval: ${fixtures.length} fixtures, prompt=${args.prompt}, distill=${distiller.label}, ` +
      `judge=${judge ? judge.label : "keywords"}`,
  );
  const started = performance.now();

  const results = await pool(
    fixtures,
    args.concurrency,
    async (fixture): Promise<FixtureResult> => {
      const chunks = chunksOf(fixture);
      const base: FixtureResult = {
        id: fixture.id,
        folder: fixture.folder,
        kind: fixture.kind,
        chunks: chunks.length,
        expected: fixture.expected.length,
        recalled: 0,
        coverage: [],
        extracted: 0,
        generic: 0,
        unsupported: 0,
        duplicates: 0,
        dropped: 0,
        memories: [],
      };
      try {
        const distilled: DistilledMemory[] = [];
        for (const chunk of chunks) {
          const raw = await distiller.complete(buildPrompt(fixture, chunk));
          const out = parseDistillation(raw, chunk);
          distilled.push(...out.memories);
          base.dropped += out.dropped;
        }
        const texts = distilled.map((m) => m.content);
        const memories: MemoryResult[] = distilled.map((m) => ({
          content: m.content,
          type: m.memoryType,
          ...(m.source ? { source: m.source } : {}),
        }));
        base.extracted = memories.length;

        if (judge) {
          const [coverage, grounding, groups] = await Promise.all([
            judgeRecall(judge, fixture.expected, texts),
            judgeGrounding(judge, transcriptText(fixture), texts),
            judgeDuplicates(judge, texts),
          ]);
          base.coverage = coverage;
          grounding.forEach((g, i) => {
            const m = memories[i];
            if (m) m.grounding = g;
          });
          base.generic = grounding.filter((g) => g === "generic").length;
          base.unsupported = grounding.filter((g) => g === "unsupported").length;
          base.duplicates = memories.length - groups.length;
        } else {
          base.coverage = fixture.expected.map((e) => (keywordsMatch(e, texts) ? 1 : 0));
        }
        base.recalled = base.coverage.filter((c) => c > 0).length;
        base.memories = memories;
        const line =
          `${fixture.id}: ${base.recalled}/${base.expected} recalled, ${base.extracted} extracted` +
          (judge ? `, ${base.generic} generic, ${base.duplicates} dup` : "");
        console.log(line);
      } catch (err) {
        base.error = err instanceof Error ? err.message : String(err);
        console.log(`${fixture.id}: FAILED ${base.error}`);
      }
      return base;
    },
  );

  const elapsedS = (performance.now() - started) / 1000;
  const label = args.label ?? `${args.prompt}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const report = {
    label,
    ranAt: new Date().toISOString(),
    prompt: args.prompt,
    distill: { provider: distiller.label, calls: distiller.calls, usd: distiller.usd },
    judge: judge
      ? { provider: judge.label, calls: judge.calls, usd: judge.usd }
      : { provider: "keywords", calls: 0, usd: 0 },
    elapsedS,
    totals: aggregate(results, "all"),
    byKind: args.kinds.map((k) => aggregate(results, k)),
    results,
  };
  const runsDir = join(here, "runs");
  mkdirSync(runsDir, { recursive: true });
  const outPath = join(runsDir, `${label}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log("");
  console.log(summaryTable(results, args.kinds));
  console.log("");
  console.log(
    `calls: ${distiller.calls} distill ($${distiller.usd.toFixed(3)}), ` +
      `${judge ? `${judge.calls} judge ($${judge.usd.toFixed(3)})` : "0 judge"}, ` +
      `${elapsedS.toFixed(0)}s. Saved ${outPath}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
