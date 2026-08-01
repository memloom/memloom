import type { StorageAdapter } from "./storage.js";

// The contradiction re-check: the pass that looks for beliefs that did not contradict anything
// when they were saved and contradict each other now.
//
// Save-time detection is pairwise against the 5 nearest candidates that existed at that moment
// (CANDIDATE_LIMIT, floor 0.5 in memloom.ts). A pair that sat at rank 6 was never judged by
// anything, and never will be: nothing looks again. Measured on a real 3026-memory store, 12.4
// pairs per memory had never been compared with each other, and 98 percent of memories had at
// least one such pair.
//
// Everything in this file was chosen by measurement rather than argument. The numbers are in

/** How many neighbours the re-check looks at, against 5 at save time. */
export const RECHECK_K = 20;

/**
 * The similarity floor, deliberately the same as save time's.
 *
 * Lowering it to 0.35 was measured and rejected: it added 266 pairs to the candidate set and
 * produced zero contradictions among them. All of the real findings cleared 0.5 and were lost to
 * K, not to the floor.
 */
export const RECHECK_FLOOR = 0.5;

/**
 * A quote shorter than this is not a quote. Guards against "no" or "yes" satisfying the check.
 */
export const MIN_QUOTE_CHARS = 15;

/** One unjudged pair: a newer belief and an older one nothing has compared it against. */
export interface RecheckPair {
  candidateId: string;
  content: string;
  similarity: number;
}

export interface RecheckSubject {
  id: string;
  content: string;
  candidates: RecheckPair[];
}

/** What the model said about one pair, before the quotes are checked. */
export interface RecheckVerdict {
  candidateId: string;
  contradictory: boolean;
  reason: string;
  newQuote: string;
  oldQuote: string;
}

/** A finding whose quotes were verified against the two memories. */
export interface RecheckFinding {
  memoryId: string;
  candidateId: string;
  reason: string;
  newQuote: string;
  oldQuote: string;
  similarity: number;
}

/**
 * Pairs this run should ask about: for every belief in the window, its current nearest
 * neighbours, minus anything already settled.
 *
 * Three exclusions, and each of them is what stops the pass asking a question that has an answer:
 * a pair a human already answered here, a pair already sitting in the conflict queue, and a pair
 * whose two rows share a lineage (a superseded version is not a contradiction, it is history).
 *
 * Note what is NOT excluded: pairs the save path judged complementary. Reconstructing what save
 * time saw would mean a second ranking pass per belief for a guess, and re-asking about a pair the
 * classifier once called complementary is exactly what a re-check is for.
 */
export async function findRecheckSubjects(
  storage: StorageAdapter,
  ownerId: string,
  since: string | null,
  limit: number,
  k: number = RECHECK_K,
  floor: number = RECHECK_FLOOR,
): Promise<RecheckSubject[]> {
  const window = await storage.query<{ id: string; content: string; root_id: string }>(
    `SELECT id, content, root_id FROM memory_objects
     WHERE owner_id = $1 AND status = 'active' AND embedding IS NOT NULL
       AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
     ORDER BY created_at DESC
     LIMIT $3`,
    [ownerId, since, limit],
  );

  const subjects: RecheckSubject[] = [];
  for (const row of window) {
    const candidates = await storage.query<{ id: string; content: string; sim: number }>(
      `SELECT c.id, c.content, 1 - (c.embedding <=> s.embedding) AS sim
         FROM memory_objects s, memory_objects c
        WHERE s.id = $2
          AND c.owner_id = $1 AND c.status = 'active' AND c.embedding IS NOT NULL
          AND c.id <> s.id
          AND c.content_hash <> s.content_hash
          -- Same belief, different version. Supersession is not contradiction.
          AND c.root_id <> $3
          -- Already answered here, in either direction.
          AND NOT EXISTS (
            SELECT 1 FROM memory_reconcile_actions a
             WHERE a.owner_id = $1 AND a.kind = 'possible'
               AND ((a.memory_id = s.id AND a.candidate_id = c.id)
                 OR (a.memory_id = c.id AND a.candidate_id = s.id))
          )
          -- Already a conflict the user owns.
          AND NOT EXISTS (
            SELECT 1 FROM memory_dedup_decisions d
             WHERE d.owner_id = $1 AND d.action = 'conflict'
               AND ((d.incoming_id = s.id AND d.candidates::text LIKE '%' || c.id::text || '%')
                 OR (d.incoming_id = c.id AND d.candidates::text LIKE '%' || s.id::text || '%'))
          )
          AND 1 - (c.embedding <=> s.embedding) >= $4
        ORDER BY c.embedding <=> s.embedding
        LIMIT $5`,
      [ownerId, row.id, row.root_id, floor, k],
    );
    if (candidates.length === 0) continue;
    subjects.push({
      id: row.id,
      content: row.content,
      candidates: candidates.map((c) => ({
        candidateId: c.id,
        content: c.content,
        similarity: Number(c.sim),
      })),
    });
  }
  return subjects;
}

/**
 * The re-check's own prompt, deliberately not the save path's.
 *
 * It differs in three ways, each earned. It says the candidates are loosely related, because 20
 * neighbours at floor 0.5 mostly are not about the same thing. It lists what is not a
 * contradiction, because the first four false positives measured were all "a how-to is not a
 * requirement" and "two things called a queue are not the same queue". And it lists what IS one,
 * because a stricter prompt without that list silenced the only findings worth having: an earlier
 * draft told the model that "true then, changed now" is not a contradiction, which is precisely
 * the supersession class this pass exists to surface, and it lost every real finding.
 */
export function buildRecheckPrompt(subject: { content: string }, candidates: RecheckPair[]): string {
  const list = candidates.map((c, i) => `${i + 1}. ${c.content}`).join("\n");
  return [
    "You compare a NEW memory against EXISTING memories and classify how each existing one",
    "relates to the new one. These existing memories were picked by similarity alone, so most of",
    "them are only loosely related to the new one.",
    "",
    `NEW: ${subject.content}`,
    "",
    "EXISTING:",
    list,
    "",
    'Answer "contradictory" only when the two memories are about the same subject and cannot both',
    'be true. Otherwise answer "complementary", which includes memories that are simply unrelated.',
    "",
    "These are NOT contradictions:",
    "- one memory gives instructions, steps, or a how-to and the other says something is not",
    "  required. A procedure for doing something optionally is not a claim that it is necessary.",
    "- one memory describes an option, a capability, or an alternative that exists, and the other",
    "  describes what is used by default.",
    "- the two memories are about different components, layers, or mechanisms that happen to share",
    "  vocabulary. Two things both called a queue are not the same queue.",
    "- the two memories are about different cases of one mechanism, and each is true of its own",
    "  case.",
    "- one memory restates or elaborates the other in more detail, or they agree while emphasising",
    "  different parts.",
    "",
    "These ARE contradictions and matter most of all:",
    "- a decision, plan, or priority that was later reversed. Deferred then scheduled, chosen then",
    "  abandoned, required then dropped.",
    "- a fact about the same subject that later changed, where the older statement is now wrong.",
    "",
    'When and only when you answer "contradictory", quote the two assertions that clash, copied',
    "WORD FOR WORD:",
    '- "new_quote": the exact sentence or clause from the NEW memory making its claim',
    '- "old_quote": the exact sentence or clause from THAT existing memory making the opposing claim',
    "",
    "Both quotes are checked against the originals character by character. Do not paraphrase, do",
    "not summarise, do not stitch fragments together, do not correct anything. Copy the span. If",
    "you cannot find a single span on each side stating the opposing claims, the memories do not",
    'contradict each other: answer "complementary" instead.',
    "",
    "Return ONLY a JSON array, one object per existing memory:",
    '[{"candidate": <number>, "relation": "complementary|contradictory",',
    '  "reason": "<at most 12 words>", "new_quote": "<verbatim>", "old_quote": "<verbatim>"}]',
  ].join("\n");
}

/**
 * Read the model's array. Anything not recognisably a contradiction is complementary, so a
 * garbled answer goes quiet rather than inventing a finding. Same fail-open direction the save
 * path takes, for the same reason: a missed contradiction costs nothing today, a false one costs
 * a person's attention.
 */
export function parseRecheckVerdicts(raw: string, candidates: RecheckPair[]): RecheckVerdict[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let items: unknown;
  try {
    items = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const out: RecheckVerdict[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const n = Number(rec.candidate);
    const cand = Number.isInteger(n) ? candidates[n - 1] : undefined;
    if (!cand) continue;
    out.push({
      candidateId: cand.candidateId,
      contradictory: String(rec.relation ?? "")
        .toLowerCase()
        .includes("contra"),
      reason: String(rec.reason ?? ""),
      newQuote: rec.new_quote ? String(rec.new_quote) : "",
      oldQuote: rec.old_quote ? String(rec.old_quote) : "",
    });
  }
  return out;
}

/**
 * Forgiving about formatting, unforgiving about invention: whitespace collapses and case is
 * ignored, so a model that reflows a line still passes, but one that rewords it does not.
 */
function canon(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function quoteOccursIn(quote: string, source: string): boolean {
  const q = canon(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return canon(source).includes(q);
}

/**
 * Keep the verdicts whose quotes are real. Measured: the model never fabricates a span, it omits
 * the fields when it cannot find one, so this drops the findings it will not stand behind (3 of
 * 13 in the sweep). It is not a precision filter and must not be sold as one: a verbatim quote
 * can carry a wrong conclusion, and the clearest measured example is "matching chunks are
 * retained" against "the old row is deleted", where both spans are real and both statements are
 * true of different cases.
 */
export function verifiedFindings(
  subject: { id: string; content: string },
  candidates: RecheckPair[],
  verdicts: RecheckVerdict[],
): RecheckFinding[] {
  const out: RecheckFinding[] = [];
  for (const v of verdicts) {
    if (!v.contradictory) continue;
    const cand = candidates.find((c) => c.candidateId === v.candidateId);
    if (!cand) continue;
    if (!quoteOccursIn(v.newQuote, subject.content)) continue;
    if (!quoteOccursIn(v.oldQuote, cand.content)) continue;
    out.push({
      memoryId: subject.id,
      candidateId: cand.candidateId,
      reason: v.reason,
      newQuote: v.newQuote,
      oldQuote: v.oldQuote,
      similarity: cand.similarity,
    });
  }
  return out;
}
