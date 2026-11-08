import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicLLM, anthropicCostUsd } from "../../packages/core/src/anthropic-provider.js";
import {
  type Candidate,
  type Classification,
  classify,
  LlmDedupClassifier,
  type Relation,
} from "../../packages/core/src/dedup.js";
import {
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_THRESHOLD,
  type JevAnswer,
  type JevDecision,
  JevDedupClassifier,
} from "../../packages/core/src/jev-dedup.js";
import { OpenRouterLLM } from "../../packages/core/src/openrouter-provider.js";
import type { LLMProvider, LlmUsage } from "../../packages/core/src/providers.js";
import { openRouterKey } from "../lib/providers.js";

// The dedup eval: memloom's LLM classifier and the Jev classifier side by side on hand-labelled
// cases. Each case is one incoming memory with the 2 to 4 existing memories a save would hand the
// classifier, so both see the request shape production sends. Writes
// eval/dedup/runs/<label>.json with every label, probability, latency and cost, and prints the
// report. Both arms bill the same OpenRouter key.
//
//   pnpm eval:dedup                                     Haiku 5.5 vs Jev, default threshold
//   pnpm eval:dedup -- --threshold 0.8 --label t080
//   pnpm eval:dedup -- --llm openrouter:google/gemini-2.5-flash --label gemini
//
// The LLM arm is AnthropicLLM, the exact class the owner's server runs (effort low), pointed at
// OpenRouter's Anthropic-compatible endpoint. Its labels match a direct Anthropic call; its
// latency includes OpenRouter's hop. Its cost is priced at Anthropic's list price.

const HERE = dirname(fileURLToPath(import.meta.url));
const RELATIONS: readonly Relation[] = ["identical", "complementary", "contradictory"];

interface CaseCandidate {
  text: string;
  gold: Relation;
  accept?: Relation[];
  trap: string;
}
interface Case {
  id: string;
  new: string;
  candidates: CaseCandidate[];
}

interface Args {
  llm: string;
  jevModel: string;
  threshold: number;
  label: string;
  concurrency: number;
  maxUsd: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    llm: "anthropic:anthropic/claude-haiku-5.5",
    jevModel: DEFAULT_JEV_MODEL,
    threshold: DEFAULT_JEV_THRESHOLD,
    label: "latest",
    concurrency: 4,
    maxUsd: 0.5,
  };
  const words = argv.filter((w) => w !== "--");
  while (words.length > 0) {
    const flag = words.shift() as string;
    const value = () => {
      const v = words.shift();
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--llm") args.llm = value();
    else if (flag === "--jev-model") args.jevModel = value();
    else if (flag === "--threshold") args.threshold = Number(value());
    else if (flag === "--label") args.label = value();
    else if (flag === "--concurrency") args.concurrency = Number(value());
    else if (flag === "--max-usd") args.maxUsd = Number(value());
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** Counts spend across both arms and stops the run at the cap. */
class Budget {
  usd = 0;
  constructor(readonly cap: number) {}
  add(usd: number): void {
    this.usd += usd;
    if (this.usd > this.cap) {
      throw new Error(`eval budget spent: $${this.usd.toFixed(4)} of the $${this.cap} cap`);
    }
  }
}

/** Wraps the LLM so every call records tokens, the billed price and wall time. */
class MeteredLLM implements LLMProvider {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;
  constructor(
    readonly inner: LLMProvider,
    readonly price: (u: LlmUsage) => number,
    readonly budget: Budget,
  ) {}
  async complete(prompt: string): Promise<string> {
    this.calls++;
    return this.inner.complete(prompt, {
      onUsage: (u) => {
        const usd = this.price(u);
        this.inputTokens += u.inputTokens;
        this.outputTokens += u.outputTokens;
        this.usd += usd;
        this.budget.add(usd);
      },
    });
  }
}

function buildLlm(spec: string, apiKey: string, budget: Budget): MeteredLLM {
  const [kind, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (kind === "anthropic") {
    // anthropic/claude-haiku-5.5 on OpenRouter is claude-haiku-5-5 on Anthropic's API.
    const direct = model.replace(/^anthropic\//, "").replace(/\./g, "-");
    return new MeteredLLM(
      new AnthropicLLM({ apiKey, baseUrl: "https://openrouter.ai/api", model, effort: "low" }),
      (u) => anthropicCostUsd(direct, u.inputTokens, u.outputTokens) ?? 0,
      budget,
    );
  }
  if (kind === "openrouter") {
    return new MeteredLLM(new OpenRouterLLM({ apiKey, model }), (u) => u.usd ?? 0, budget);
  }
  throw new Error(`--llm takes anthropic:<model> or openrouter:<model>; got "${spec}"`);
}

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

function candidatesOf(c: Case): Candidate[] {
  return c.candidates.map((cand, i) => ({
    id: `${c.id}#${i + 1}`,
    canonical: null,
    content: cand.text,
    similarity: 0.8,
  }));
}

// A candidate the classifier returns nothing for is complementary: that is what #save does.
function labelsOf(cands: Candidate[], out: Classification[]): Relation[] {
  return cands.map((c) => out.find((o) => o.candidateId === c.id)?.relation ?? "complementary");
}

interface PairResult {
  id: string;
  trap: string;
  gold: Relation;
  accept: Relation[];
  llm: Relation;
  jevRaw: Relation | null;
  jevProbability: number | null;
  jevConfidence: number | null;
  jevProbabilities: JevAnswer["probabilities"];
  gated: Relation;
  gatedBy: "jev" | "fallback" | "conflict";
}

interface CaseTiming {
  id: string;
  pairs: number;
  llmMs: number;
  jevMs: number;
  gatedMs: number;
  jevUsd: number;
  jevInputTokens: number;
  fellBack: boolean;
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const ok = (p: PairResult, label: Relation | null) => label !== null && p.accept.includes(label);

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

function matrix(pairs: PairResult[], pick: (p: PairResult) => Relation | null): string {
  const lines = [
    "| gold \\ predicted | identical | complementary | contradictory | no answer |",
    "|---|---|---|---|---|",
  ];
  for (const g of RELATIONS) {
    const row = pairs.filter((p) => p.gold === g);
    const cells = RELATIONS.map((r) => row.filter((p) => pick(p) === r).length);
    lines.push(`| ${g} | ${cells.join(" | ")} | ${row.filter((p) => pick(p) === null).length} |`);
  }
  return lines.join("\n");
}

// The two mistakes that cost something: an identical that was not (stales a memory) and a
// complementary that hid a real contradiction (the conflict never reaches a human).
function harm(pairs: PairResult[], pick: (p: PairResult) => Relation | null) {
  return {
    falseIdentical: pairs.filter((p) => pick(p) === "identical" && !p.accept.includes("identical"))
      .length,
    missedContradiction: pairs.filter(
      (p) => p.gold === "contradictory" && pick(p) !== "contradictory",
    ).length,
  };
}

function report(args: Args, pairs: PairResult[], timings: CaseTiming[], cost: CostSummary): string {
  const n = pairs.length;
  const acc = (pick: (p: PairResult) => Relation | null) =>
    `${pairs.filter((p) => ok(p, pick(p))).length}/${n} (${pct(pairs.filter((p) => ok(p, pick(p))).length, n)})`;
  const h = (pick: (p: PairResult) => Relation | null) => {
    const x = harm(pairs, pick);
    return `${x.falseIdentical} | ${x.missedContradiction}`;
  };
  const agree = pairs.filter((p) => p.jevRaw === p.llm).length;
  const out: string[] = [];
  out.push(
    `## ${args.llm} vs ${args.jevModel} at ${args.threshold}`,
    "",
    `${timings.length} incoming memories, ${n} candidate judgments.`,
    "",
    "| classifier | correct | false identical | missed contradiction |",
    "|---|---|---|---|",
    `| LLM (${args.llm}) | ${acc((p) => p.llm)} | ${h((p) => p.llm)} |`,
    `| Jev alone, top choice | ${acc((p) => p.jevRaw)} | ${h((p) => p.jevRaw)} |`,
    `| Jev gated at ${args.threshold}, LLM fallback | ${acc((p) => p.gated)} | ${h((p) => p.gated)} |`,
    "",
    `Jev and the LLM agree on ${agree}/${n} (${pct(agree, n)}) judgments.`,
    "",
    "LLM confusion matrix:",
    "",
    matrix(pairs, (p) => p.llm),
    "",
    "Jev (top choice, no gate) confusion matrix:",
    "",
    matrix(pairs, (p) => p.jevRaw),
    "",
    `Jev gated at ${args.threshold} with LLM fallback, end to end:`,
    "",
    matrix(pairs, (p) => p.gated),
    "",
  );

  // Calibration: how often Jev is right when it is this sure.
  const bands = [
    { label: ">= 0.99", lo: 0.99, hi: 1.01 },
    { label: "0.9 to 0.99", lo: 0.9, hi: 0.99 },
    { label: "0.7 to 0.9", lo: 0.7, hi: 0.9 },
    { label: "< 0.7", lo: -1, hi: 0.7 },
  ];
  out.push(
    "Jev accuracy by the probability of its chosen label, and by its `confidence` field:",
    "",
    "| band | by probability | by confidence |",
    "|---|---|---|",
  );
  for (const b of bands) {
    const byP = pairs.filter(
      (p) => (p.jevProbability ?? -1) >= b.lo && (p.jevProbability ?? -1) < b.hi,
    );
    const byC = pairs.filter(
      (p) => (p.jevConfidence ?? -1) >= b.lo && (p.jevConfidence ?? -1) < b.hi,
    );
    out.push(
      `| ${b.label} | ${byP.filter((p) => ok(p, p.jevRaw)).length}/${byP.length} | ${byC.filter((p) => ok(p, p.jevRaw)).length}/${byC.length} |`,
    );
  }
  out.push("");

  // Threshold sweep, simulated from the raw answers: below the threshold the LLM's label stands
  // in for the fallback (the real run sends only the unsure candidates, so it can differ).
  out.push(
    "Threshold sweep (simulated: below the threshold, the LLM arm's label stands in for the fallback):",
    "",
    "| threshold | pairs to fallback | requests with a fallback | correct | false identical | missed contradiction |",
    "|---|---|---|---|---|---|",
  );
  for (const t of [0.5, 0.7, 0.8, 0.9, 0.95, 0.99]) {
    const sure = (p: PairResult) => p.jevRaw !== null && (p.jevProbability ?? 0) >= t;
    const pick = (p: PairResult) => (sure(p) ? p.jevRaw : p.llm);
    const unsureCases = new Set(pairs.filter((p) => !sure(p)).map((p) => p.id.split("#")[0]));
    const hx = harm(pairs, pick);
    out.push(
      `| ${t} | ${pairs.filter((p) => !sure(p)).length}/${n} | ${unsureCases.size}/${timings.length} | ${pairs.filter((p) => ok(p, pick(p))).length}/${n} | ${hx.falseIdentical} | ${hx.missedContradiction} |`,
    );
  }
  out.push("");

  const llmMs = timings.map((t) => t.llmMs);
  const jevMs = timings.map((t) => t.jevMs);
  const gatedMs = timings.map((t) => t.gatedMs);
  const per1k = (usd: number) => `$${((usd / n) * 1000).toFixed(4)}`;
  out.push(
    "Latency per request (one request per incoming memory) and cost:",
    "",
    "| arm | p50 | p95 | cost per 1,000 pairs | tokens in / out |",
    "|---|---|---|---|---|",
    `| LLM | ${quantile(llmMs, 0.5)} ms | ${quantile(llmMs, 0.95)} ms | ${per1k(cost.llmUsd)} | ${cost.llmIn} / ${cost.llmOut} |`,
    `| Jev alone | ${quantile(jevMs, 0.5)} ms | ${quantile(jevMs, 0.95)} ms | ${per1k(cost.jevUsd)} | ${cost.jevIn} / ${cost.jevOut} (output free) |`,
    `| Jev gated + fallback | ${quantile(gatedMs, 0.5)} ms | ${quantile(gatedMs, 0.95)} ms | ${per1k(cost.jevUsd + cost.fallbackUsd)} | fallback: ${cost.fallbackCalls} LLM calls |`,
    "",
  );

  const wrong = pairs.filter((p) => !ok(p, p.gated) || !ok(p, p.llm) || !ok(p, p.jevRaw));
  if (wrong.length > 0) {
    out.push(
      "Pairs any arm got wrong:",
      "",
      "| pair | trap | gold | LLM | Jev (p) | gated |",
      "|---|---|---|---|---|---|",
    );
    for (const p of wrong) {
      out.push(
        `| ${p.id} | ${p.trap} | ${p.gold} | ${p.llm} | ${p.jevRaw ?? "none"} (${p.jevProbability?.toFixed(2) ?? "-"}) | ${p.gated} (${p.gatedBy}) |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

interface CostSummary {
  llmUsd: number;
  llmIn: number;
  llmOut: number;
  jevUsd: number;
  jevIn: number;
  jevOut: number;
  fallbackUsd: number;
  fallbackCalls: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8")) as Case[];
  const apiKey = openRouterKey();
  const budget = new Budget(args.maxUsd);
  const llm = buildLlm(args.llm, apiKey, budget);
  const fallbackLlm = buildLlm(args.llm, apiKey, budget);

  const pairs: PairResult[] = [];
  const timings: CaseTiming[] = [];
  let jevIn = 0;
  let jevOut = 0;
  let jevUsd = 0;

  await pool(cases, args.concurrency, async (c) => {
    const cands = candidatesOf(c);
    const incoming = { content: c.new };

    let t = Date.now();
    const llmOut = labelsOf(cands, await classify(llm, incoming, cands));
    const llmMs = Date.now() - t;

    let decision: JevDecision | undefined;
    const jev = new JevDedupClassifier({
      apiKey,
      model: args.jevModel,
      threshold: args.threshold,
      fallback: new LlmDedupClassifier(fallbackLlm),
      onDecision: (d) => {
        decision = d;
      },
    });
    t = Date.now();
    const gatedOut = await jev.classify(incoming, cands);
    const gatedMs = Date.now() - t;
    if (!decision) throw new Error(`no Jev decision recorded for ${c.id}`);
    if (decision.jevError) console.error(`${c.id}: Jev failed: ${decision.jevError}`);
    const usd = decision.usage?.usd ?? 0;
    jevUsd += usd;
    jevIn += decision.usage?.inputTokens ?? 0;
    jevOut += decision.usage?.outputTokens ?? 0;
    budget.add(usd);
    const gated = labelsOf(cands, gatedOut);

    cands.forEach((cand, i) => {
      const meta = c.candidates[i] as CaseCandidate;
      const a = decision?.answers[i];
      pairs.push({
        id: cand.id,
        trap: meta.trap,
        gold: meta.gold,
        accept: meta.accept ?? [meta.gold],
        llm: llmOut[i] as Relation,
        jevRaw: a?.choice ?? null,
        jevProbability: a?.probability ?? null,
        jevConfidence: a?.confidence ?? null,
        jevProbabilities: a?.probabilities ?? {},
        gated: gated[i] as Relation,
        gatedBy: !decision?.unsure.includes(cand.id)
          ? "jev"
          : decision.settledBy === "fallback"
            ? "fallback"
            : "conflict",
      });
    });
    timings.push({
      id: c.id,
      pairs: cands.length,
      llmMs,
      jevMs: decision.ms,
      gatedMs,
      jevUsd: usd,
      jevInputTokens: decision.usage?.inputTokens ?? 0,
      fellBack: decision.unsure.length > 0,
    });
    process.stderr.write(".");
  });
  process.stderr.write("\n");

  // Keep the file in case order, whatever order the pool finished in.
  const order = new Map(cases.map((c, i) => [c.id, i]));
  const caseOf = (id: string) => order.get(id.split("#")[0] as string) ?? 0;
  pairs.sort((a, b) => caseOf(a.id) - caseOf(b.id) || a.id.localeCompare(b.id));
  timings.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const cost: CostSummary = {
    llmUsd: llm.usd,
    llmIn: llm.inputTokens,
    llmOut: llm.outputTokens,
    jevUsd,
    jevIn,
    jevOut,
    fallbackUsd: fallbackLlm.usd,
    fallbackCalls: fallbackLlm.calls,
  };
  const text = report(args, pairs, timings, cost);
  mkdirSync(join(HERE, "runs"), { recursive: true });
  const file = join(HERE, "runs", `${args.label}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ args, ranAt: new Date().toISOString(), cost, timings, pairs }, null, 2)}\n`,
  );
  console.log(text);
  console.log(`\nwrote ${file}; spent $${budget.usd.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
