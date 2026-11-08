import type {
  Candidate,
  Classification,
  DedupClassifier,
  DedupIncoming,
  Relation,
} from "./dedup.js";
import { postJson } from "./openrouter-provider.js";

// The dedup classifier on a decision model. TypeSafe's Jev, on OpenRouter's Decisions API,
// answers a typed question with probabilities instead of text: one request per incoming
// memory, one `choice` question per candidate, three options. It writes no reasons and costs
// a fraction of a chat model, so it suits a label this narrow.
//
// It is only trusted when it is sure. A wrong "identical" versions a memory away (the old one
// goes stale) and a wrong "complementary" hides a real contradiction, so every answer below the
// threshold, every refusal and every failed request goes to the fallback classifier (the LLM).
// When there is no fallback, or the fallback fails too, the candidate is filed as a conflict
// for a human: the save still lands, and nothing is merged on a guess.

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.14";
/**
 * The probability Jev must give its chosen label before memloom acts on it. Set from the dedup
 * eval (eval/dedup/README.md). Probabilities differ between model versions, so a new model
 * needs a new eval run before this number means anything for it.
 */
export const DEFAULT_JEV_THRESHOLD = 0.9;

const RELATIONS: readonly Relation[] = ["identical", "complementary", "contradictory"];

// The three options, worded to match buildDedupPrompt so the two classifiers answer the same
// question. The criteria name the state keys Jev reads ("new_memory", "the existing memory").
const CRITERIA: Record<Relation, string> = {
  identical: "The existing memory states the same fact as new_memory, restated.",
  complementary:
    "Both can be true at once, whether or not they are about the same topic. This includes " +
    "memories that are unrelated to each other or about a different topic entirely.",
  contradictory: "They are about the same subject and cannot both be true.",
};

/** One candidate's answer, as Jev gave it, before gating. */
export interface JevAnswer {
  candidateId: string;
  /** Jev's pick, or null when it refused or the answer was missing or malformed. */
  choice: Relation | null;
  /** probabilities[choice]: what the gate compares against the threshold. */
  probability: number | null;
  confidence: number | null;
  probabilities: Partial<Record<Relation, number>>;
}

/** What one classify() call did, for the eval and for anyone watching the pipeline. */
export interface JevDecision {
  model: string;
  answers: JevAnswer[];
  /** Candidates sent to the fallback (or filed as conflicts) because Jev was unsure. */
  unsure: string[];
  /** How the unsure candidates were settled. */
  settledBy: "none" | "fallback" | "conflict";
  usage: { inputTokens: number; outputTokens: number; usd: number | null } | null;
  /** Wall time of the Decisions request alone. */
  ms: number;
  jevError: string | null;
  fallbackError: string | null;
}

export interface JevDedupOptions {
  apiKey: string;
  model?: string;
  threshold?: number;
  /** Classifier for the answers Jev is unsure of. Null files them as conflicts instead. */
  fallback: DedupClassifier | null;
  url?: string;
  fetch?: typeof globalThis.fetch;
  onDecision?: (decision: JevDecision) => void;
}

interface WireAnswer {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface WireResponse {
  model?: string;
  answers?: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

export function buildJevRequest(
  model: string,
  incoming: DedupIncoming,
  candidates: readonly Candidate[],
): { model: string; state: Record<string, string>; questions: Record<string, unknown> } {
  const state: Record<string, string> = { new_memory: incoming.content };
  const questions: Record<string, unknown> = {};
  candidates.forEach((c, i) => {
    const key = `existing_${i + 1}`;
    state[key] = c.content;
    questions[`relation_${i + 1}`] = {
      type: "choice",
      instructions:
        `How does ${key} relate to new_memory? Memories about different topics are ` +
        "complementary, not contradictory.",
      criteria: CRITERIA,
    };
  });
  return { model, state, questions };
}

function isRelation(value: unknown): value is Relation {
  return typeof value === "string" && (RELATIONS as readonly string[]).includes(value);
}

export function parseJevAnswers(
  json: WireResponse | null,
  candidates: readonly Candidate[],
): JevAnswer[] {
  return candidates.map((c, i) => {
    const wire = json?.answers?.[`relation_${i + 1}`];
    const probabilities: Partial<Record<Relation, number>> = {};
    for (const r of RELATIONS) {
      const p = wire?.probabilities?.[r];
      if (typeof p === "number" && Number.isFinite(p)) probabilities[r] = p;
    }
    const choice = wire?.type === "choice" && isRelation(wire.choice) ? wire.choice : null;
    return {
      candidateId: c.id,
      choice,
      probability: choice ? (probabilities[choice] ?? null) : null,
      confidence: typeof wire?.confidence === "number" ? wire.confidence : null,
      probabilities,
    };
  });
}

function describe(a: JevAnswer): string {
  if (!a.choice) return "no answer";
  return RELATIONS.filter((r) => a.probabilities[r] !== undefined)
    .map((r) => `${r} ${(a.probabilities[r] ?? 0).toFixed(2)}`)
    .join(", ");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class JevDedupClassifier implements DedupClassifier {
  readonly model: string;
  readonly threshold: number;
  readonly #apiKey: string;
  readonly #fallback: DedupClassifier | null;
  readonly #url: string;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #onDecision: ((d: JevDecision) => void) | undefined;

  constructor(opts: JevDedupOptions) {
    this.#apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_JEV_MODEL;
    this.threshold = opts.threshold ?? DEFAULT_JEV_THRESHOLD;
    if (!(this.threshold > 0 && this.threshold <= 1)) {
      throw new Error(`memloom: the Jev threshold must be in (0, 1]; got ${opts.threshold}`);
    }
    this.#fallback = opts.fallback;
    this.#url = opts.url ?? DECISIONS_URL;
    this.#fetch = opts.fetch;
    this.#onDecision = opts.onDecision;
  }

  async classify(
    incoming: DedupIncoming,
    candidates: readonly Candidate[],
  ): Promise<Classification[]> {
    const decision: JevDecision = {
      model: this.model,
      answers: [],
      unsure: [],
      settledBy: "none",
      usage: null,
      ms: 0,
      jevError: null,
      fallbackError: null,
    };

    const started = Date.now();
    try {
      const json = (await postJson(
        this.#url,
        this.#apiKey,
        buildJevRequest(this.model, incoming, candidates),
        "decisions",
        this.#fetch,
      )) as WireResponse | null;
      decision.model = json?.model ?? this.model;
      decision.answers = parseJevAnswers(json, candidates);
      decision.usage = {
        inputTokens: json?.usage?.input_tokens ?? 0,
        outputTokens: json?.usage?.output_tokens ?? 0,
        usd: typeof json?.usage?.cost === "number" ? json.usage.cost : null,
      };
    } catch (err) {
      decision.jevError = message(err);
      decision.answers = parseJevAnswers(null, candidates);
    }
    decision.ms = Date.now() - started;

    const out: Classification[] = [];
    const unsure: Candidate[] = [];
    candidates.forEach((c, i) => {
      const a = decision.answers[i];
      if (a?.choice && a.probability !== null && a.probability >= this.threshold) {
        out.push({
          candidateId: c.id,
          relation: a.choice,
          reason: `${decision.model}: ${a.choice} (${a.probability.toFixed(2)})`,
        });
      } else {
        unsure.push(c);
      }
    });
    decision.unsure = unsure.map((c) => c.id);

    if (unsure.length > 0) {
      const why = (c: Candidate): string => {
        if (decision.jevError) return `jev failed: ${decision.jevError}`;
        const a = decision.answers.find((x) => x.candidateId === c.id);
        return `jev unsure (${a ? describe(a) : "no answer"})`;
      };
      let settled: Classification[] | null = null;
      if (this.#fallback) {
        try {
          const fb = await this.#fallback.classify(incoming, unsure);
          settled = fb.map((cl) => {
            const c = unsure.find((u) => u.id === cl.candidateId);
            return { ...cl, reason: `${c ? why(c) : "jev unsure"}; llm: ${cl.reason}` };
          });
          decision.settledBy = "fallback";
        } catch (err) {
          decision.fallbackError = message(err);
        }
      }
      if (!settled) {
        // Nobody could decide. A conflict keeps both memories active and puts the pair in
        // front of a human, which is the one outcome that cannot lose information.
        settled = unsure.map((c) => ({
          candidateId: c.id,
          relation: "contradictory" as const,
          reason:
            `${why(c)}; ` +
            (decision.fallbackError
              ? `the fallback classifier failed too (${decision.fallbackError}), so a human decides`
              : "no fallback classifier, so a human decides"),
        }));
        decision.settledBy = "conflict";
      }
      out.push(...settled);
    }

    this.#onDecision?.(decision);
    return out;
  }
}
