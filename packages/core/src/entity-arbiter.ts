import type { EntityConflict } from "./types.js";

// Arbitrating an uncertain fold with a model, for the pass reconciliation runs when the user turns it
// on. Pure: the prompt and the parser live here so both can be read and tested without a store
// or a network, the same split dedup.ts and conflict-resolver.ts use.
//
// Why a model at all, when entity-resolution.ts is deliberately rule-based: the rules produce a
// score, and the score cannot separate the two cases that matter. Measured with judgePair on the
// live rules, "Phasmaphobia" / "Phasmophobia" (a typo that should fold) scores 0.74 while
// "memloom.ai" (product) / "memloom ui" (project) (two different things) scores 0.73, rising to
// 0.83 once vector agreement is added. The pair that must not fold outscores the pair that
// should, both are one character apart, and the embedding makes it worse rather than better.
//
// Two consequences, both load-bearing:
//  - No score threshold may ever auto-approve a fold. If one could, the rules would already
//    have done it, and this pass would not exist.
//  - The model only ever sees pairs the rules already flagged as uncertain. It is an arbiter,
//    never a proposer: it cannot pair two rows the lexical stage did not pair first.

export type EntityVerdictKind = "same" | "distinct" | "unsure";

export interface EntityVerdict {
  verdict: EntityVerdictKind;
  /** The model's own confidence, recorded on the fold. Not judgePair's score. */
  confidence: number;
  reason: string;
}

/** One pending pair, flattened to what the model needs and nothing else. */
export interface EntityArbitrationCase {
  name: string;
  entityType: string;
  mentions: number;
  candidateName: string;
  candidateType: string;
  candidateMentions: number;
  /** What the lexical rules made of it, so the model knows why it was asked and not told. */
  ruleReason: string;
}

export function arbitrationCase(conflict: EntityConflict): EntityArbitrationCase | null {
  const candidate = conflict.candidates[0];
  if (!candidate) return null;
  return {
    name: conflict.incoming.name,
    entityType: conflict.incoming.entityType,
    mentions: conflict.incoming.mentions,
    candidateName: candidate.name,
    candidateType: candidate.entityType,
    candidateMentions: candidate.mentions,
    ruleReason: candidate.reason,
  };
}

export function buildEntityArbiterPrompt(input: EntityArbitrationCase): string {
  return `You decide whether two names in a personal knowledge graph refer to the same thing.

A: "${input.name}" (type: ${input.entityType}, mentioned ${input.mentions} times)
B: "${input.candidateName}" (type: ${input.candidateType}, mentioned ${input.candidateMentions} times)

A spelling check already found them similar: ${input.ruleReason}
Similar spelling is why you are being asked. It is not evidence either way.

Answer "same" only when they name one thing and merging them loses nothing. A misspelling, a
capitalisation difference, an abbreviation, or a product and its official name are the same.

Answer "distinct" when they name different things that happen to look alike: a company and its
product, a website and the project behind it, two releases, two people with similar names, or a
tool and the file format it reads. Different types are a strong signal of distinct.

Answer "unsure" when you would need to know something about this person's work to decide. Being
unsure is a real answer and it is better than a wrong merge: a human will look at it.

Reply with JSON only:
{"verdict": "same" | "distinct" | "unsure", "confidence": 0.0-1.0, "reason": "one short sentence"}`;
}

const VERDICTS = new Set<EntityVerdictKind>(["same", "distinct", "unsure"]);

/**
 * Parse the reply. Anything unrecognisable becomes null, and the caller leaves the pair pending:
 * a model that answered garbage has not decided anything, and defaulting to a fold would be the
 * one irreversible-feeling mistake this pass can make.
 */
export function parseEntityVerdict(raw: string): EntityVerdict | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as { verdict?: unknown; confidence?: unknown; reason?: unknown };
  const verdict = typeof value.verdict === "string" ? value.verdict.toLowerCase().trim() : "";
  if (!VERDICTS.has(verdict as EntityVerdictKind)) return null;
  const confidence = Number(value.confidence);
  return {
    verdict: verdict as EntityVerdictKind,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    reason: typeof value.reason === "string" ? value.reason.trim() : "",
  };
}
