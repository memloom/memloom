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

/**
 * Neighbours per contradiction re-check. Four times the save path's CANDIDATE_LIMIT, because a
 * background pass has nobody waiting on it and can afford to look wider. Measured: of the real
 * contradictions a wider net finds, only 1 in 6 sits inside the top 5, and they run out to rank
 * 18, so half the width finds a third of them. See RECHECK_K in recheck.ts, which this must track.
 */
export const RECONCILE_K = 20;

/**
 * Per-run limits. A background job that surfaces 40 things a week gets turned off in week two,
 * so the caps are part of the design rather than a setting somebody remembers to lower. Findings
 * past a cap are still recorded (surfaced = false): held back, not lost.
 */
export const RECONCILE_CAPS = { retire: 10, question: 3, conflict: 5, integrity: 10 } as const;

/**
 * Classes where the store contradicts itself rather than where reconciliation has an opinion. SQL
 * proves each of these is wrong, so on a healthy store they are all empty and finding one means
 * a bug shipped. They keep their own cap and the backoff never touches it: quieting an opinion
 * nobody answered is right, quieting an alarm is not.
 */
export const INTEGRITY_CLASSES = new Set([
  "replaces_leak",
  "stale_without_edge",
  "entity_alias_orphan",
  "entity_alias_shadow",
  "entity_merge_incomplete",
  "entity_edge_stranded",
]);

export function isIntegrityFinding(finding: ReconcileFinding): boolean {
  return INTEGRITY_CLASSES.has(finding.class);
}

/**
 * Decide which findings a run shows, counting integrity findings against their own cap. Returns
 * one flag per finding, positionally, so the caller can keep the original order in the ledger:
 * held back is recorded, not lost.
 */
export function capBuckets(findings: ReconcileFinding[], cap: number, integrityCap: number): boolean[] {
  let normal = 0;
  let integrity = 0;
  return findings.map((finding) =>
    isIntegrityFinding(finding) ? integrity++ < integrityCap : normal++ < cap,
  );
}

/** Above this many pending conflicts, a run raises none: adding to an ignored backlog is noise. */
export const CONFLICT_QUEUE_CEILING = 20;

// When a run happens on its own. A cron at 3am on a laptop is a run that silently never
// happens, so idle comes first. But idle alone guarantees nothing on a machine that is never
// idle and whose daemon never restarts, which is what the ceiling is for: prefer idle, fall
// back to the clock.

/** Startup catch-up: the daemon started and it has been this long since a run. */
export const RECONCILE_CATCHUP_HOURS = 36;
/** Idle: quiet daemon, and it has been this long since a run. */
export const RECONCILE_IDLE_HOURS = 20;
/** Ceiling: this long since a run means run anyway, idle or not. */
export const RECONCILE_CEILING_HOURS = 48;
/** How long the daemon must have served nothing to count as idle. */
export const RECONCILE_IDLE_QUIET_MS = 10 * 60_000;
/** Startup settle: long enough that a catch-up never competes with the ingest queue's load. */
export const RECONCILE_STARTUP_SETTLE_MS = 2 * 60_000;
/** How often the daemon asks whether it is time. */
export const RECONCILE_TICK_MS = 5 * 60_000;

function hoursSince(now: number, then: number | null): number {
  return then === null ? Number.POSITIVE_INFINITY : (now - then) / 3_600_000;
}

/**
 * Is a startup catch-up due? A sleeping laptop means no daemon, which means no run, so the
 * startup path is what makes "nothing is missed, it is only late" true.
 */
export function startupCatchUpDue(opts: {
  now: number;
  lastRunAt: number | null;
  enabled: boolean;
}): boolean {
  return opts.enabled && hoursSince(opts.now, opts.lastRunAt) >= RECONCILE_CATCHUP_HOURS;
}

/**
 * Is an opportunistic run due? Null means not yet. Never while indexing: two background passes
 * over the same store is how a laptop gets loud.
 */
export function idleRunDue(opts: {
  now: number;
  lastRunAt: number | null;
  lastRequestAt: number;
  indexing: boolean;
}): boolean {
  if (opts.indexing) return false;
  const age = hoursSince(opts.now, opts.lastRunAt);
  if (age >= RECONCILE_CEILING_HOURS) return true;
  if (age < RECONCILE_IDLE_HOURS) return false;
  return opts.now - opts.lastRequestAt >= RECONCILE_IDLE_QUIET_MS;
}

/** Consecutive ignored runs after which a run stops surfacing anything at all. */
export const BACKOFF_SILENT_AFTER = 3;

export type ReconcileCaps = {
  retire: number;
  question: number;
  conflict: number;
  integrity: number;
};

/**
 * Back off when nobody is listening. Each consecutive run whose surfaced findings drew no
 * approve/reject halves the next run's caps, and after BACKOFF_SILENT_AFTER of them a run keeps
 * scanning and stops talking. Ignoring reconciliation makes it quieter, not louder.
 *
 * The integrity cap is deliberately outside the division. See INTEGRITY_CLASSES.
 */
export function effectiveCaps(unactionedRuns: number): ReconcileCaps {
  const integrity = RECONCILE_CAPS.integrity;
  if (unactionedRuns >= BACKOFF_SILENT_AFTER) {
    return { retire: 0, question: 0, conflict: 0, integrity };
  }
  const divisor = 2 ** unactionedRuns;
  return {
    retire: Math.floor(RECONCILE_CAPS.retire / divisor),
    question: Math.floor(RECONCILE_CAPS.question / divisor),
    conflict: Math.floor(RECONCILE_CAPS.conflict / divisor),
    integrity,
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

/**
 * One classification's JSON reply per candidate.
 *
 * Measured at 63, not the 24 this used to guess: the model explains every verdict and the reasons
 * run long. Output is also the expensive side at these models' prices, so the old constant made the
 * estimate about 5x low, which is the wrong direction for a number a user reads before deciding
 * whether to spend. The re-check prompt caps reasons at 12 words to pull this back down.
 */
const OUTPUT_TOKENS_PER_CANDIDATE = 63;

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
 * An active belief that an active `replaces` edge points at: the save or resolve path meant to
 * stale it and did not. SQL proves the store contradicts itself and the fix is forced (there is
 * exactly one thing "superseded but still current" can mean), so this retires without asking.
 *
 * 0 rows on a healthy store. A non-zero count is a bug in whatever wrote the edge.
 */
export async function findReplacesLeaks(
  storage: StorageAdapter,
  ownerId: string,
): Promise<ReconcileFinding[]> {
  const rows = await storage.query<{ id: string; by: string }>(
    `SELECT DISTINCT m.id AS id, e.from_id AS by
     FROM memory_objects m
     JOIN memory_edges e ON e.to_id = m.id AND e.relation = 'replaces' AND e.active
                        AND e.owner_id = m.owner_id
     WHERE m.owner_id = $1 AND m.status = 'active'
     ORDER BY m.id`,
    [ownerId],
  );
  return rows.map((row) => ({
    kind: "retire" as const,
    class: "replaces_leak",
    memoryId: row.id,
    reason: `${row.by} replaced this belief but it is still current, so both are being recalled`,
  }));
}

/**
 * The other direction: a stale belief with no `replaces` edge explaining it. There is nothing to
 * fix here. The row is already stale, and SQL cannot invent the missing edge or say who wrote
 * the status, so this is reported and never acted on. It is the loudest thing a run can print,
 * because it means something staled a memory without recording why.
 */
export async function findOrphanStale(
  storage: StorageAdapter,
  ownerId: string,
): Promise<ReconcileFinding[]> {
  const rows = await storage.query<{ id: string }>(
    `SELECT m.id FROM memory_objects m
     WHERE m.owner_id = $1 AND m.status = 'stale'
       AND NOT EXISTS (
         SELECT 1 FROM memory_edges e
         WHERE e.owner_id = m.owner_id AND e.to_id = m.id
           AND e.relation = 'replaces' AND e.active
       )
     ORDER BY m.stale_since DESC NULLS LAST, m.id`,
    [ownerId],
  );
  return rows.map((row) => ({
    kind: "question" as const,
    class: "stale_without_edge",
    memoryId: row.id,
    reason:
      "this belief is retired but nothing records what replaced it. " +
      "Something staled it without leaving a trail",
  }));
}

/**
 * Entity folding has its own invariants, and nothing checks them. Same character as the class
 * above: SQL proves the store is inconsistent, but the fix is not forced, so all four are
 * reported and none is repaired. A repair that guessed would be worse than a loud report, and a
 * non-zero count belongs to whoever owns entity resolution rather than in a reconciliation workaround.
 */
export async function findEntityInvariants(
  storage: StorageAdapter,
  ownerId: string,
): Promise<ReconcileFinding[]> {
  const findings: ReconcileFinding[] = [];

  // E1: the spelling resolves to a canonical row that is gone, so every future mention of it
  // mints a fresh entity instead. Folded-away canonicals are the likely cause, which is why the
  // reason names the chain when there is one.
  const orphans = await storage.query<{ name: string; chained: boolean }>(
    `SELECT a.name,
            EXISTS (SELECT 1 FROM memory_entity_merges m
                     WHERE m.owner_id = a.owner_id AND m.source_id = a.canonical_id
                       AND m.reverted_at IS NULL) AS chained
     FROM memory_entity_aliases a
     WHERE a.owner_id = $1
       AND NOT EXISTS (SELECT 1 FROM memory_entities e
                        WHERE e.id = a.canonical_id AND e.owner_id = a.owner_id)
     ORDER BY a.name`,
    [ownerId],
  );
  for (const row of orphans) {
    findings.push({
      kind: "question",
      class: "entity_alias_orphan",
      memoryId: null,
      reason: row.chained
        ? `"${row.name}" points at an entity that was itself folded away, so the chain is broken`
        : `"${row.name}" points at an entity that no longer exists`,
    });
  }

  // E2: the absorbed row was never removed, so one name resolves two ways depending on which
  // lookup runs first. #resolveEntity checks memory_entities before memory_entity_aliases.
  const shadows = await storage.query<{ name: string }>(
    `SELECT a.name FROM memory_entity_aliases a
     JOIN memory_entities e ON e.id = a.entity_id AND e.owner_id = a.owner_id
     WHERE a.owner_id = $1 AND a.entity_id IS NOT NULL
     ORDER BY a.name`,
    [ownerId],
  );
  for (const row of shadows) {
    findings.push({
      kind: "question",
      class: "entity_alias_shadow",
      memoryId: null,
      reason: `"${row.name}" is recorded as folded away but its own entity row is still live`,
    });
  }

  // E3: the fold record says absorbed, the entity table says otherwise.
  const incomplete = await storage.query<{ source_name: string }>(
    `SELECT m.source_name FROM memory_entity_merges m
     JOIN memory_entities e ON e.id = m.source_id AND e.owner_id = m.owner_id
     WHERE m.owner_id = $1 AND m.reverted_at IS NULL
     ORDER BY m.source_name`,
    [ownerId],
  );
  for (const row of incomplete) {
    findings.push({
      kind: "question",
      class: "entity_merge_incomplete",
      memoryId: null,
      reason: `the fold of "${row.source_name}" was recorded but the entity was never absorbed`,
    });
  }

  // E5: edges the fold should have repointed. They still name a row nothing can reach, so the
  // mentions they carry are invisible to recall.
  const stranded = await storage.query<{ source_name: string; edges: number }>(
    `SELECT m.source_name, count(DISTINCT e.id)::int AS edges
     FROM memory_entity_merges m
     JOIN memory_edges e ON e.owner_id = m.owner_id AND e.active
                        AND (e.from_id = m.source_id OR e.to_id = m.source_id)
     WHERE m.owner_id = $1 AND m.reverted_at IS NULL
     GROUP BY m.source_name
     ORDER BY m.source_name`,
    [ownerId],
  );
  for (const row of stranded) {
    findings.push({
      kind: "question",
      class: "entity_edge_stranded",
      memoryId: null,
      reason: `${row.edges} active edges still point at "${row.source_name}", which was folded away`,
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
): Promise<MultiHeadLineage[]> {
  const rows = await storage.query<{
    root_id: string;
    heads: number;
    versions: string;
    ids: string[];
  }>(
    `SELECT root_id,
            count(*)::int AS heads,
            string_agg(version::text, ', ' ORDER BY version, created_at) AS versions,
            array_agg(id ORDER BY version DESC, created_at DESC) AS ids
     FROM memory_objects
     WHERE owner_id = $1 AND status = 'active'
     GROUP BY root_id
     HAVING count(*) > 1
     ORDER BY count(*) DESC, root_id`,
    [ownerId],
  );
  return rows
    .map((row) => {
      const [head, ...rest] = row.ids;
      if (!head || rest.length === 0) return null;
      return {
        rootId: row.root_id,
        head,
        others: rest,
        reason:
          `${row.heads} versions of this belief are current at once (versions ${row.versions}). ` +
          "A belief should have one. Which one is still true?",
      };
    })
    .filter((row): row is MultiHeadLineage => row !== null);
}

/** A root with more than one live head: the newest, the rest, and how to say it. */
export interface MultiHeadLineage {
  rootId: string;
  /** The newest live row, which becomes the conflict's incoming side. */
  head: string;
  others: string[];
  reason: string;
}

/**
 * Roots reconciliation has already asked about. A lineage is identified by its root, not by its
 * newest row: the newest row changes the moment another version lands, so keying on it would
 * re-raise the same question forever. Resolved rows count too, because a question the user has
 * answered is settled whatever the answer was.
 */
export async function raisedLineages(
  storage: StorageAdapter,
  ownerId: string,
): Promise<Set<string>> {
  const rows = await storage.query<{ incoming_canonical: string | null }>(
    `SELECT incoming_canonical FROM memory_dedup_decisions
     WHERE owner_id = $1 AND action = 'conflict' AND incoming_canonical LIKE '${LINEAGE_KEY_PREFIX}%'`,
    [ownerId],
  );
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.incoming_canonical) seen.add(row.incoming_canonical.slice(LINEAGE_KEY_PREFIX.length));
  }
  return seen;
}

/**
 * Marks a conflict row as reconcile-raised and names the lineage it is about. `incoming_canonical`
 * carries the reconciled text on a save-time conflict and is unused on a raised one, which is
 * the same column the entity path repurposes as its pair key.
 */
export const LINEAGE_KEY_PREFIX = "reconcile:lineage:";

export function lineageKey(rootId: string): string {
  return `${LINEAGE_KEY_PREFIX}${rootId}`;
}

/** The re-check's outstanding debt: see countDueForRecheck in recheck.ts, which produces it. */
export interface RecheckWindow {
  /** Active beliefs never re-checked, plus any whose check is older than the quiet period. */
  count: number;
  chars: number;
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
 * What re-checking everything currently due would cost, from the real prompt template and the
 * actual content lengths. A dry run prints this instead of spending it.
 *
 * This prices the whole debt, which one run cannot work through: RECHECK_WINDOW_LIMIT caps a run
 * at 200 beliefs, so on a store with a backlog the figure here is what several runs will add up
 * to, not what the next one costs. The report says so rather than leaving it to be inferred.
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
 * Memories a run must not retire even when a detector names them: a pending conflict is already
 * deciding their fate, and reconciliation does not get to pre-empt an answer the user owes.
 *
 * This used to also block anything an active `replaces` edge points at, on the grounds that such
 * a row is stale already. That was true of a healthy store and wrong as a rule: when the row is
 * still active, it is a leak and retiring it is exactly the fix. findReplacesLeaks owns that set
 * now, and this one is only about the conflict queue.
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
  return blocked;
}
