import type { LLMProvider } from "./providers.js";

// The dedup classifier. Given an incoming memory and the existing memories most similar to it,
// the LLM labels each existing one's relationship to the incoming: identical (same fact),
// complementary (both can be true), or contradictory (cannot both be true). Contradictions
// become human-in-the-loop conflicts; identicals dedupe; complementary coexist.

export type Relation = "identical" | "complementary" | "contradictory";

export interface Candidate {
  id: string;
  canonical: string | null;
  content: string;
  similarity: number;
}

export interface Classification {
  candidateId: string;
  relation: Relation;
  reason: string;
}

export function buildDedupPrompt(
  incoming: { canonical?: string | null; content: string },
  candidates: readonly Candidate[],
): string {
  const list = candidates.map((c, i) => `${i + 1}. ${c.content}`).join("\n");
  return [
    "You compare a NEW memory against EXISTING memories and classify how each existing one",
    "relates to the new one.",
    "",
    `NEW: ${incoming.content}`,
    "",
    "EXISTING:",
    list,
    "",
    "For each existing memory choose exactly one relation:",
    '- "identical": the same fact restated',
    '- "complementary": related, but both can be true at once',
    '- "contradictory": they cannot both be true',
    "",
    "Return ONLY a JSON array, one object per existing memory:",
    '[{"candidate": <number>, "relation": "identical|complementary|contradictory", "reason": "<short>"}]',
  ].join("\n");
}

function extractJsonArray(raw: string): unknown[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRelation(value: unknown): Relation {
  const s = String(value ?? "").toLowerCase();
  if (s.includes("ident")) return "identical";
  if (s.includes("contra")) return "contradictory";
  return "complementary";
}

export function parseClassifications(
  raw: string,
  candidates: readonly Candidate[],
): Classification[] {
  const out: Classification[] = [];
  for (const item of extractJsonArray(raw)) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const n = Number(rec.candidate);
    const cand = Number.isInteger(n) ? candidates[n - 1] : undefined;
    if (!cand) continue;
    out.push({
      candidateId: cand.id,
      relation: normalizeRelation(rec.relation),
      reason: String(rec.reason ?? ""),
    });
  }
  return out;
}

export async function classify(
  llm: LLMProvider,
  incoming: { canonical?: string | null; content: string },
  candidates: readonly Candidate[],
): Promise<Classification[]> {
  const raw = await llm.complete(buildDedupPrompt(incoming, candidates));
  return parseClassifications(raw, candidates);
}
