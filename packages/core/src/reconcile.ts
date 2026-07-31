import { buildDedupPrompt } from "./dedup.js";
import type { StorageAdapter } from "./storage.js";
import type { ReconcileActionKind, ReconcileEstimate } from "./types.js";

// Reconciliation: the detectors and the cost arithmetic. No state changes live here; memloom.ts owns
// the run, the ledger, and the apply/revert pair.
//
// The rule the whole feature rests on: a run may retire only what SQL can prove obsolete, with
// no model in the loop. Anything that would need a judgment call becomes a question. So every
// detector below is a query, and the one expensive class (contradictions that only emerged once
// both beliefs existed) is counted and priced but never judged during a dry run.

/** One thing a run found. Only `retire` ever changes state, and only in apply mode. */
export interface ReconcileFinding {
  kind: ReconcileActionKind;
  class: string;
  memoryId: string | null;
  reason: string;
}

/** Neighbors per contradiction re-check. Matches CANDIDATE_LIMIT in the save path. */
export const RECONCILE_K = 5;

/**
 * Per-run limits. A background job that surfaces 40 things a week gets turned off in week two,
 * so the caps are part of the design rather than a setting somebody remembers to lower. Findings
 * past a cap are still recorded (surfaced = false): held back, not lost.
 */
export const RECONCILE_CAPS = { retire: 10, question: 3, conflict: 5 } as const;

/** Above this many pending conflicts, a run raises none: adding to an ignored backlog is noise. */
export const CONFLICT_QUEUE_CEILING = 20;

/** Consecutive ignored runs after which a run stops surfacing anything at all. */
export const BACKOFF_SILENT_AFTER = 3;

export type ReconcileCaps = { retire: number; question: number; conflict: number };

/**
 * Back off when nobody is listening. Each consecutive run whose surfaced findings drew no
 * approve/reject halves the next run's caps, and after BACKOFF_SILENT_AFTER of them a run keeps
 * scanning and stops talking. Ignoring reconciliation makes it quieter, not louder.
 */
export function effectiveCaps(unactionedRuns: number): ReconcileCaps {
  if (unactionedRuns >= BACKOFF_SILENT_AFTER) return { retire: 0, question: 0, conflict: 0 };
  const divisor = 2 ** unactionedRuns;
  return {
    retire: Math.floor(RECONCILE_CAPS.retire / divisor),
    question: Math.floor(RECONCILE_CAPS.question / divisor),
    conflict: Math.floor(RECONCILE_CAPS.conflict / divisor),
  };
}

/**
 * Hand-maintained, and the only place currency appears. Nothing else in the repo tracks model
 * prices, so this WILL go stale: an unknown model prints tokens and no dollar figure rather than
 * a confident wrong number. USD per million tokens.
 */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
};

/** ~4 chars per token. Good enough for an order-of-magnitude spend warning, and free. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** The dedup prompt's fixed cost, measured from the real template rather than guessed. */
export const PROMPT_OVERHEAD_TOKENS = estimateTokens(buildDedupPrompt({ content: "" }, []).length);

/** One classification's JSON reply: a relation and a short reason per candidate. */
const OUTPUT_TOKENS_PER_CANDIDATE = 24;

export function estimateUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Duplicate active content: two active rows with the same content_hash. The save path treats an
 * identical hash as a merge, so a duplicate can only be an artifact of a revert or an import
 * race. The oldest row is kept and the rest retired, which is the one class safe to act on
 * without asking.
 */
export async function findDuplicateContent(
  storage: StorageAdapter,
  ownerId: string,
): Promise<ReconcileFinding[]> {
  const rows = await storage.query<{ id: string; content_hash: string }>(
    `SELECT id, content_hash FROM memory_objects
     WHERE owner_id = $1 AND status = 'active' AND content_hash IS NOT NULL
       AND content_hash IN (
         SELECT content_hash FROM memory_objects
         WHERE owner_id = $1 AND status = 'active' AND content_hash IS NOT NULL
         GROUP BY content_hash HAVING count(*) > 1
       )
     ORDER BY content_hash, created_at, id`,
    [ownerId],
  );
  const findings: ReconcileFinding[] = [];
  const keeper = new Map<string, string>();
  for (const row of rows) {
    const kept = keeper.get(row.content_hash);
    if (!kept) {
      keeper.set(row.content_hash, row.id);
      continue;
    }
    findings.push({
      kind: "retire",
      class: "duplicate_content",
      memoryId: row.id,
      reason: `identical content to ${kept}, which is older and stays active`,
    });
  }
  return findings;
}

/**
 * A belief lineage with more than one current version. Detected purely from root_id/version, but
 * NOT retired: the cause is a version collision in resolveConflict's reparent path (see
 * is a question, and the human decides which head survives.
 */
export async function findMultiHeadLineages(
  storage: StorageAdapter,
  ownerId: string,
): Promise<ReconcileFinding[]> {
  const rows = await storage.query<{
    root_id: string;
    heads: number;
    versions: string;
    head: string;
  }>(
    `SELECT root_id,
            count(*)::int AS heads,
            string_agg(version::text, ', ' ORDER BY version, created_at) AS versions,
            (array_agg(id ORDER BY version DESC, created_at DESC))[1] AS head
     FROM memory_objects
     WHERE owner_id = $1 AND status = 'active'
     GROUP BY root_id
     HAVING count(*) > 1
     ORDER BY count(*) DESC, root_id`,
    [ownerId],
  );
  return rows.map((row) => ({
    kind: "question" as const,
    class: "multi_head",
    memoryId: row.head,
    reason:
      `${row.heads} versions of this belief are current at once (versions ${row.versions}). ` +
      "A belief should have one. Which one is still true?",
  }));
}

export interface RecheckWindow {
  /** Active memories saved since the cutoff: what a real run would re-check. */
  count: number;
  chars: number;
}

/**
 * The contradiction re-check window. Classification at save time is pairwise against the
 * candidates that existed THEN, so a belief saved today can start contradicting one saved last
 * week without either save seeing it. Re-checking everything would cost O(store) per run and
 * would re-raise resolved conflicts; re-checking what arrived since the last run costs
 * O(new writes), which is why the bill does not grow with the store.
 */
export async function recheckWindow(
  storage: StorageAdapter,
  ownerId: string,
  since: string | null,
): Promise<RecheckWindow> {
  const [row] = await storage.query<{ n: number; chars: number }>(
    `SELECT count(*)::int AS n, coalesce(sum(length(content)), 0)::int AS chars
     FROM memory_objects
     WHERE owner_id = $1 AND status = 'active' AND embedding IS NOT NULL
       AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)`,
    [ownerId, since],
  );
  return { count: Number(row?.n ?? 0), chars: Number(row?.chars ?? 0) };
}

/** Mean active content length, standing in for the K neighbors each prompt would carry. */
export async function meanActiveContentChars(
  storage: StorageAdapter,
  ownerId: string,
): Promise<number> {
  const [row] = await storage.query<{ avg: string | null }>(
    `SELECT avg(length(content))::float8 AS avg FROM memory_objects
     WHERE owner_id = $1 AND status = 'active'`,
    [ownerId],
  );
  return Math.round(Number(row?.avg ?? 0));
}

/**
 * What the contradiction pass would cost, from the real prompt template and the actual content
 * lengths in the window. A dry run prints this instead of spending it, so the preview is a
 * strict subset of a real run and says so.
 */
export function estimateRecheck(
  window: RecheckWindow,
  meanCandidateChars: number,
  model: string,
): ReconcileEstimate {
  const perPromptCandidates = estimateTokens(meanCandidateChars) * RECONCILE_K;
  const inputTokens =
    window.count * (PROMPT_OVERHEAD_TOKENS + perPromptCandidates) + estimateTokens(window.chars);
  const outputTokens = window.count * RECONCILE_K * OUTPUT_TOKENS_PER_CANDIDATE;
  return {
    window: window.count,
    llmCalls: window.count,
    inputTokens,
    outputTokens,
    model,
    usd: estimateUsd(model, inputTokens, outputTokens),
  };
}

/**
 * Memories a run must not retire even when a detector names them: something else is already
 * deciding their fate. A pending conflict names them, or an active 'replaces' edge points at
 * them (in which case they are stale already and the retirement is a no-op at best).
 */
export async function retirementBlocklist(
  storage: StorageAdapter,
  ownerId: string,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const conflicted = await storage.query<{ id: string }>(
    `SELECT incoming_id AS id FROM memory_dedup_decisions
     WHERE owner_id = $1 AND action = 'conflict' AND resolution_action IS NULL
       AND incoming_id IS NOT NULL`,
    [ownerId],
  );
  for (const row of conflicted) blocked.add(row.id);
  const candidates = await storage.query<{ candidates: Array<{ id?: string }> | string }>(
    `SELECT candidates FROM memory_dedup_decisions
     WHERE owner_id = $1 AND action = 'conflict' AND resolution_action IS NULL`,
    [ownerId],
  );
  for (const row of candidates) {
    const list = typeof row.candidates === "string" ? JSON.parse(row.candidates) : row.candidates;
    for (const candidate of list ?? []) if (candidate?.id) blocked.add(candidate.id);
  }
  const superseded = await storage.query<{ to_id: string }>(
    `SELECT DISTINCT to_id FROM memory_edges
     WHERE owner_id = $1 AND relation = 'replaces' AND active`,
    [ownerId],
  );
  for (const row of superseded) blocked.add(row.to_id);
  return blocked;
}
