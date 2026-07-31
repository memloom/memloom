import { afterEach, describe, expect, it } from "vitest";
import {
  RECONCILE_IDLE_QUIET_MS,
  effectiveCaps,
  idleRunDue,
  PROMPT_OVERHEAD_TOKENS,
  startupCatchUpDue,
} from "./reconcile.js";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom, SENTINEL_OWNER } from "./memloom.js";
import type { StorageAdapter } from "./storage.js";
import { PgliteFactory } from "./testkit.js";

// Reconciliation end to end: a dry run reports without touching a single belief, the apply path
// retires only what SQL proved, and the undo is exact (it restores what the run staled and
// refuses to touch what somebody staled afterwards).

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

// Everything is complementary: saves land as separate beliefs, no conflicts, no versioning.
// Reconciliation's detectors are pure SQL, so the classifier only has to stay out of the way.
function quietLlm(arbiter?: (prompt: string) => string) {
  return new ScriptedLLMProvider((prompt) => {
    if (prompt.startsWith("You decide whether two names")) return arbiter?.(prompt) ?? "";
    return prompt.startsWith("You compare")
      ? JSON.stringify([{ candidate: 1, relation: "complementary", reason: "unrelated" }])
      : "[]";
  });
}

async function openStore(arbiter?: (prompt: string) => string) {
  const storage = await PgliteFactory.open();
  cleanups.push(() => storage.close());
  const memloom = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm: quietLlm(arbiter),
    autoIndexDelayMs: 999_999,
  });
  await memloom.init();
  return { memloom, storage };
}

/** A second active row with the same content_hash: what a revert or an import race leaves. */
async function seedDuplicate(storage: StorageAdapter, id: string): Promise<string> {
  const [row] = await storage.query<{ id: string }>(
    `INSERT INTO memory_objects
       (owner_id, root_id, memory_type, content, content_hash, embedding, created_at)
     SELECT owner_id, gen_random_uuid(), memory_type, content, content_hash, embedding,
            created_at + interval '1 minute'
     FROM memory_objects WHERE id = $1
     RETURNING id`,
    [id],
  );
  if (!row) throw new Error("seed failed");
  return row.id;
}

/** Two current versions of one belief: the shape resolveConflict's reparent path can produce. */
async function seedSecondHead(storage: StorageAdapter, id: string): Promise<string> {
  const [row] = await storage.query<{ id: string }>(
    `INSERT INTO memory_objects
       (owner_id, root_id, version, memory_type, content, content_hash, embedding)
     SELECT owner_id, root_id, version + 1, memory_type, content || ' (second head)',
            content_hash || '-2', embedding
     FROM memory_objects WHERE id = $1
     RETURNING id`,
    [id],
  );
  if (!row) throw new Error("seed failed");
  return row.id;
}

/** Two spellings of one name, which judgePair calls certain: what pass 2 exists to fold. */
async function seedNameVariants(storage: StorageAdapter, a: string, b: string): Promise<void> {
  for (const name of [a, b]) {
    await storage.query(
      "INSERT INTO memory_entities (owner_id, name, entity_type) VALUES ($1, $2, 'product')",
      [SENTINEL_OWNER, name],
    );
  }
}

async function entityNames(storage: StorageAdapter): Promise<string[]> {
  const rows = await storage.query<{ name: string }>(
    "SELECT name FROM memory_entities ORDER BY name",
  );
  return rows.map((r) => r.name);
}

async function statusOf(storage: StorageAdapter, id: string): Promise<string> {
  const [row] = await storage.query<{ status: string }>(
    "SELECT status FROM memory_objects WHERE id = $1",
    [id],
  );
  return row?.status ?? "missing";
}

describe("reconcile", () => {
  it("a dry run reports findings and changes no beliefs", async () => {
    const { memloom, storage } = await openStore();
    const kept = await memloom.save({ content: "the deploy target is fly.io" });
    const duplicate = await seedDuplicate(storage, kept.id);

    const before = await storage.query(
      "SELECT id, status, stale_since FROM memory_objects ORDER BY id",
    );
    const edgesBefore = await storage.query("SELECT count(*)::int AS n FROM memory_edges");

    const report = await memloom.reconcile();

    expect(report.run.mode).toBe("dry_run");
    expect(report.run.retired).toBe(0);
    expect(report.run.llmCalls).toBe(0);
    const retire = report.actions.filter((a) => a.kind === "retire");
    expect(retire).toHaveLength(1);
    expect(retire[0]?.memoryId).toBe(duplicate);
    expect(retire[0]?.applied).toBe(false);
    expect(retire[0]?.class).toBe("duplicate_content");

    // The whole point of a dry run: the store it describes is the store it leaves behind.
    expect(
      await storage.query("SELECT id, status, stale_since FROM memory_objects ORDER BY id"),
    ).toEqual(before);
    expect(await storage.query("SELECT count(*)::int AS n FROM memory_edges")).toEqual(edgesBefore);
    expect(await memloom.conflicts()).toHaveLength(0);
    expect(await statusOf(storage, duplicate)).toBe("active");
  });

  it("prices the contradiction pass without making a call", async () => {
    const { memloom } = await openStore();
    await memloom.save({ content: "the deploy target is fly.io" });
    await memloom.save({ content: "the release ritual is bump, tag, push" });

    const { estimate } = await memloom.reconcile();

    // No prior run, so the window is everything active.
    expect(estimate.window).toBe(2);
    expect(estimate.llmCalls).toBe(2);
    expect(estimate.inputTokens).toBeGreaterThan(2 * PROMPT_OVERHEAD_TOKENS);
    expect(estimate.outputTokens).toBeGreaterThan(0);
    // The test provider is not a priced model, so the report shows tokens and no dollar figure.
    expect(estimate.usd).toBeNull();
  });

  it("does not let a preview consume the re-check window", async () => {
    const { memloom } = await openStore();
    await memloom.save({ content: "the deploy target is fly.io" });

    // Nothing has ever re-checked anything (the contradiction pass is not built), so every dry
    // run must report the same outstanding work. A second preview saying 0 would be claiming
    // work that was never done.
    expect((await memloom.reconcile()).estimate.window).toBe(1);
    expect((await memloom.reconcile()).estimate.window).toBe(1);

    await memloom.save({ content: "the release ritual is bump, tag, push" });
    expect((await memloom.reconcile()).estimate.window).toBe(2);
  });

  it("applies a retirement and reverses it exactly", async () => {
    const { memloom, storage } = await openStore();
    const kept = await memloom.save({ content: "the deploy target is fly.io" });
    const duplicate = await seedDuplicate(storage, kept.id);

    const report = await memloom.reconcile({ mode: "apply" });
    expect(report.run.retired).toBe(1);
    expect(await statusOf(storage, duplicate)).toBe("stale");
    expect(await statusOf(storage, kept.id)).toBe("active");
    // Retiring is invisible to recall and visible in history: the two invariants that make it
    // safe to do unattended.
    expect((await memloom.memories()).map((m) => m.id)).toEqual([kept.id]);
    expect((await memloom.history(duplicate)).map((m) => m.status)).toEqual(["stale"]);

    const reverted = await memloom.revertReconcile(report.run.id);
    expect(reverted).toMatchObject({ restored: 1, skipped: 0 });
    expect(await statusOf(storage, duplicate)).toBe("active");
    const [row] = await storage.query<{ stale_since: string | null }>(
      "SELECT stale_since FROM memory_objects WHERE id = $1",
      [duplicate],
    );
    expect(row?.stale_since).toBeNull();
  });

  it("refuses to reverse a retirement someone else has since changed", async () => {
    const { memloom, storage } = await openStore();
    const kept = await memloom.save({ content: "the deploy target is fly.io" });
    const duplicate = await seedDuplicate(storage, kept.id);
    const report = await memloom.reconcile({ mode: "apply" });

    // A human (or a conflict resolution) stales it again: stale_since moves, so the run's undo
    // is no longer describing the state it created.
    await storage.query(
      "UPDATE memory_objects SET stale_since = now() + interval '1 hour' WHERE id = $1",
      [duplicate],
    );

    const reverted = await memloom.revertReconcile(report.run.id);
    expect(reverted).toMatchObject({ restored: 0, skipped: 1 });
    expect(await statusOf(storage, duplicate)).toBe("stale");
  });

  it("asks about a lineage with two current versions instead of retiring one", async () => {
    const { memloom, storage } = await openStore();
    const first = await memloom.save({ content: "entity extraction runs on the flash model" });
    const second = await seedSecondHead(storage, first.id);

    const report = await memloom.reconcile({ mode: "apply" });

    const questions = report.actions.filter((a) => a.kind === "question");
    expect(questions).toHaveLength(1);
    expect(questions[0]?.class).toBe("multi_head");
    expect(questions[0]?.applied).toBe(false);
    // Judgment calls never change state, even in apply mode.
    expect(await statusOf(storage, first.id)).toBe("active");
    expect(await statusOf(storage, second)).toBe("active");
    expect(report.run.retired).toBe(0);
  });

  it("never retires a memory a pending conflict is already about", async () => {
    const { memloom, storage } = await openStore();
    const kept = await memloom.save({ content: "the deploy target is fly.io" });
    const duplicate = await seedDuplicate(storage, kept.id);
    await storage.query(
      `INSERT INTO memory_dedup_decisions (owner_id, action, incoming_id, incoming_content, candidates)
       VALUES ($1, 'conflict', $2, 'the deploy target is railway', '[]'::jsonb)`,
      [SENTINEL_OWNER, duplicate],
    );

    const report = await memloom.reconcile({ mode: "apply" });

    expect(report.actions.filter((a) => a.kind === "retire")).toHaveLength(0);
    expect(await statusOf(storage, duplicate)).toBe("active");
  });

  it("records findings past the per-run cap without showing them", async () => {
    const { memloom, storage } = await openStore();
    // Five lineages with two current versions each, against a question cap of 3.
    for (let i = 0; i < 5; i++) {
      const saved = await memloom.save({ content: `belief number ${i} about the build` });
      await seedSecondHead(storage, saved.id);
    }

    const report = await memloom.reconcile();

    const questions = report.actions.filter((a) => a.kind === "question");
    expect(questions).toHaveLength(5);
    expect(questions.filter((q) => q.surfaced)).toHaveLength(3);
    expect(report.heldBack.question).toBe(2);
  });

  it("gets quieter the longer its findings are ignored", async () => {
    // The integrity cap never moves: quieting an opinion nobody answered is right, quieting an
    // alarm that says the store contradicts itself is not.
    expect(effectiveCaps(0)).toEqual({ retire: 10, question: 3, conflict: 5, integrity: 10 });
    expect(effectiveCaps(1)).toEqual({ retire: 5, question: 1, conflict: 2, integrity: 10 });
    expect(effectiveCaps(2)).toEqual({ retire: 2, question: 0, conflict: 1, integrity: 10 });
    expect(effectiveCaps(3)).toEqual({ retire: 0, question: 0, conflict: 0, integrity: 10 });

    const { memloom, storage } = await openStore();
    for (let i = 0; i < 5; i++) {
      const saved = await memloom.save({ content: `belief number ${i} about the build` });
      await seedSecondHead(storage, saved.id);
    }

    const first = await memloom.reconcile({ mode: "apply" });
    expect(first.actions.filter((a) => a.surfaced)).toHaveLength(3);
    // Nobody approved or rejected anything, so the next run says less, then nothing.
    const second = await memloom.reconcile({ mode: "apply" });
    expect(second.actions.filter((a) => a.surfaced)).toHaveLength(1);
    const third = await memloom.reconcile({ mode: "apply" });
    expect(third.actions.filter((a) => a.surfaced)).toHaveLength(0);
  });

  it("never backs off because of dry runs", async () => {
    const { memloom, storage } = await openStore();
    for (let i = 0; i < 5; i++) {
      const saved = await memloom.save({ content: `belief number ${i} about the build` });
      await seedSecondHead(storage, saved.id);
    }

    // Nothing can be approved yet, so a preview that says less every time it is run would be
    // punishing the user for looking. Dry runs do not count as being ignored.
    for (let run = 0; run < 4; run++) {
      const report = await memloom.reconcile();
      expect(report.actions.filter((a) => a.surfaced)).toHaveLength(3);
    }
  });

  it("stales a memory something already replaced but left current", async () => {
    const { memloom, storage } = await openStore();
    const superseded = await memloom.save({ content: "the deploy target is fly.io" });
    const winner = await memloom.save({ content: "the release ritual is bump, tag, push" });
    // The shape a bug in the save or resolve path leaves: the edge says replaced, the status
    // says current, and recall returns both.
    await storage.query(
      `INSERT INTO memory_edges (owner_id, from_id, to_id, relation, active)
       VALUES ($1, $2, $3, 'replaces', true)`,
      [SENTINEL_OWNER, winner.id, superseded.id],
    );

    const report = await memloom.reconcile({ mode: "apply" });

    const retire = report.actions.filter((a) => a.kind === "retire");
    expect(retire).toHaveLength(1);
    expect(retire[0]?.class).toBe("replaces_leak");
    expect(await statusOf(storage, superseded.id)).toBe("stale");
    expect(await statusOf(storage, winner.id)).toBe("active");

    // Reversible like every other thing a run does.
    await memloom.revertReconcile(report.run.id);
    expect(await statusOf(storage, superseded.id)).toBe("active");
  });

  it("reports a stale memory with no trail and never acts on it", async () => {
    const { memloom, storage } = await openStore();
    const saved = await memloom.save({ content: "the deploy target is fly.io" });
    // Staled by something that recorded no reason. There is nothing to fix: SQL cannot invent
    // the missing edge, so the only honest output is to say so.
    await storage.query(
      "UPDATE memory_objects SET status = 'stale', stale_since = now() WHERE id = $1",
      [saved.id],
    );

    const report = await memloom.reconcile({ mode: "apply" });

    const orphan = report.actions.filter((a) => a.class === "stale_without_edge");
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.kind).toBe("question");
    expect(orphan[0]?.applied).toBe(false);
    expect(report.run.retired).toBe(0);
  });

  it("folds a name variant and unfolds it on revert", async () => {
    const { memloom, storage } = await openStore();
    await seedNameVariants(storage, "Claude Code", "claude-code");

    const report = await memloom.reconcile({ mode: "apply" });

    expect(report.entities?.merged).toBe(1);
    expect(report.run.folded).toBe(1);
    expect(await entityNames(storage)).toEqual(["Claude Code"]);
    const fold = report.actions.find((a) => a.kind === "fold");
    expect(fold?.mergeId).toBeTruthy();
    expect(fold?.reason).toContain('folded "claude-code" into "Claude Code"');

    // The fold is undone through revertEntityMerge, which restores the absorbed row verbatim.
    const reverted = await memloom.revertReconcile(report.run.id);
    expect(reverted).toMatchObject({ unfolded: 1, skipped: 0 });
    expect(await entityNames(storage)).toEqual(["Claude Code", "claude-code"]);
  });

  it("leaves entities alone on a dry run and says what it would have done", async () => {
    const { memloom, storage } = await openStore();
    await seedNameVariants(storage, "Claude Code", "claude-code");

    const report = await memloom.reconcile();

    expect(report.entities?.merged).toBe(1);
    expect(report.run.folded).toBe(0);
    expect(report.actions.filter((a) => a.kind === "fold")).toHaveLength(0);
    expect(await entityNames(storage)).toEqual(["Claude Code", "claude-code"]);
  });

  it("runs only the passes it was given", async () => {
    const { memloom, storage } = await openStore();
    await seedNameVariants(storage, "Claude Code", "claude-code");

    const report = await memloom.reconcile({ mode: "apply", passes: ["invariants"] });

    expect(report.passes).toEqual(["invariants"]);
    expect(report.entities).toBeUndefined();
    expect(await entityNames(storage)).toEqual(["Claude Code", "claude-code"]);
  });

  it("keeps saying the store contradicts itself however long it is ignored", async () => {
    const { memloom, storage } = await openStore();
    // Enough opinions to exhaust the ordinary caps, plus one alarm.
    for (let i = 0; i < 5; i++) {
      const saved = await memloom.save({ content: `belief number ${i} about the build` });
      await seedSecondHead(storage, saved.id);
    }
    const orphaned = await memloom.save({ content: "the deploy target is fly.io" });
    await storage.query(
      "UPDATE memory_objects SET status = 'stale', stale_since = now() WHERE id = $1",
      [orphaned.id],
    );

    let last = await memloom.reconcile({ mode: "apply" });
    for (let run = 0; run < 3; run++) last = await memloom.reconcile({ mode: "apply" });

    // The backoff has silenced the multi-head questions by now.
    const surfaced = last.actions.filter((a) => a.surfaced);
    expect(surfaced.filter((a) => a.class === "multi_head")).toHaveLength(0);
    expect(surfaced.filter((a) => a.class === "stale_without_edge")).toHaveLength(1);
  });

  it("settings decide which passes run, and survive a read back", async () => {
    const { memloom, storage } = await openStore();
    await seedNameVariants(storage, "Claude Code", "claude-code");

    // The two that cost money are off out of the box; the two that cannot are on.
    expect(await memloom.reconcileSettings()).toMatchObject({
      invariants: true,
      entities: true,
      llm_entities: false,
      llm_conflicts: false,
    });

    await memloom.setReconcileSettings({ entities: false });
    expect((await memloom.reconcileSettings()).entities).toBe(false);

    const report = await memloom.reconcile({ mode: "apply" });
    expect(report.passes).toEqual(["invariants"]);
    expect(await entityNames(storage)).toEqual(["Claude Code", "claude-code"]);
  });

  it("prefers idle but falls back to the clock", () => {
    const now = Date.parse("2026-07-31T12:00:00Z");
    const hours = (n: number) => now - n * 3_600_000;
    const quiet = now - RECONCILE_IDLE_QUIET_MS - 1;
    const base = { now, lastRequestAt: quiet, indexing: false };

    // Too soon after the last run, however quiet the machine is.
    expect(idleRunDue({ ...base, lastRunAt: hours(19) })).toBe(false);
    expect(idleRunDue({ ...base, lastRunAt: hours(21) })).toBe(true);
    // Old enough, but the daemon is still serving: wait for a gap.
    expect(idleRunDue({ ...base, lastRunAt: hours(21), lastRequestAt: now })).toBe(false);
    // Past the ceiling, run anyway. Without this an always-busy machine whose daemon never
    // restarts would never reconcile at all.
    expect(idleRunDue({ ...base, lastRunAt: hours(49), lastRequestAt: now })).toBe(true);
    // Never against a live index pass.
    expect(idleRunDue({ ...base, lastRunAt: hours(49), indexing: true })).toBe(false);
    // Never run means overdue, not "start counting now".
    expect(idleRunDue({ ...base, lastRunAt: null })).toBe(true);

    expect(startupCatchUpDue({ now, lastRunAt: hours(37), enabled: true })).toBe(true);
    expect(startupCatchUpDue({ now, lastRunAt: hours(35), enabled: true })).toBe(false);
    expect(startupCatchUpDue({ now, lastRunAt: null, enabled: false })).toBe(false);
  });

  it("lets a model settle the pairs the rules could not, and undoes it", async () => {
    // A typo pair: one edit apart, so the rules say review rather than auto. This is the case
    // no score can separate, which is the whole argument for the pass.
    const verdict = JSON.stringify({
      verdict: "same",
      confidence: 0.9,
      reason: "one is a misspelling of the other",
    });
    const { memloom, storage } = await openStore(() => verdict);
    await seedNameVariants(storage, "Phasmophobia", "Phasmaphobia");
    await memloom.setReconcileSettings({ llm_entities: true });

    const report = await memloom.reconcile({ mode: "apply" });

    expect(report.entities?.queued).toBe(1);
    expect(report.arbitration).toMatchObject({ calls: 1, folded: 1, rejected: 0, unsure: 0 });
    // One survives; which spelling wins is pickCanonical's call, not the model's.
    expect(await entityNames(storage)).toHaveLength(1);
    // The fold says a model made it, and which one, so it is not mistaken for the user's.
    const [merge] = await memloom.entityMerges();
    expect(merge).toMatchObject({ decidedBy: "llm", score: 0.9 });
    expect(merge?.reason).toContain("misspelling");
    // Undo puts back the entity AND the question, so nothing claims a resolution that is gone.
    const reverted = await memloom.revertReconcile(report.run.id);
    expect(reverted.unfolded).toBe(1);
    expect(await entityNames(storage)).toEqual(["Phasmaphobia", "Phasmophobia"]);
    expect(await memloom.entityConflicts()).toHaveLength(1);
  });

  it("records a rejection so the same pair is never asked about again", async () => {
    const verdict = JSON.stringify({
      verdict: "distinct",
      confidence: 0.8,
      reason: "a website and a project are different things",
    });
    const { memloom, storage } = await openStore(() => verdict);
    await seedNameVariants(storage, "memloom.ai", "memloom ui");
    await memloom.setReconcileSettings({ llm_entities: true });

    const first = await memloom.reconcile({ mode: "apply" });
    expect(first.arbitration).toMatchObject({ folded: 0, rejected: 1 });
    expect(await entityNames(storage)).toEqual(["memloom ui", "memloom.ai"]);
    expect(await memloom.entityConflicts()).toHaveLength(0);

    // Second run: settled means settled. Asking the model again every night is how a cheap
    // pass turns into a standing bill.
    const second = await memloom.reconcile({ mode: "apply" });
    expect(second.arbitration).toBeUndefined();
    expect(second.run.llmCalls).toBe(0);
  });

  it("leaves a pair pending when the model will not commit", async () => {
    const { memloom, storage } = await openStore(() => "I could not say, sorry");
    await seedNameVariants(storage, "Phasmophobia", "Phasmaphobia");
    await memloom.setReconcileSettings({ llm_entities: true });

    const report = await memloom.reconcile({ mode: "apply" });

    // An unparseable answer is not a verdict. Defaulting to a fold would be the one mistake
    // this pass can make that feels irreversible to a user.
    expect(report.arbitration).toMatchObject({ calls: 1, folded: 0, rejected: 0, unsure: 1 });
    expect(await entityNames(storage)).toEqual(["Phasmaphobia", "Phasmophobia"]);
    expect(await memloom.entityConflicts()).toHaveLength(1);
  });

  it("does not let a paid pass claim the contradiction window", async () => {
    const verdict = JSON.stringify({ verdict: "same", confidence: 0.9, reason: "a misspelling" });
    const { memloom, storage } = await openStore(() => verdict);
    await memloom.save({ content: "the deploy target is fly.io" });
    await seedNameVariants(storage, "Phasmophobia", "Phasmaphobia");
    await memloom.setReconcileSettings({ llm_entities: true });

    // This run spends money, on entities. The contradiction re-check is a different pass and
    // has still never run, so the window must not narrow: llm_calls > 0 is not evidence that
    // contradictions were looked at.
    const paid = await memloom.reconcile({ mode: "apply" });
    expect(paid.run.llmCalls).toBeGreaterThan(0);
    expect((await memloom.reconcile()).estimate.window).toBe(1);
  });

  it("never calls a model on a dry run, however it is configured", async () => {
    let calls = 0;
    const { memloom, storage } = await openStore(() => {
      calls++;
      return JSON.stringify({ verdict: "same", confidence: 1, reason: "same" });
    });
    await seedNameVariants(storage, "Phasmophobia", "Phasmaphobia");
    await memloom.setReconcileSettings({ llm_entities: true, llm_conflicts: true });

    const report = await memloom.reconcile();

    // A preview that spent money would be charging for a report.
    expect(calls).toBe(0);
    expect(report.arbitration).toBeUndefined();
    expect(report.autoResolved).toBeUndefined();
    expect(report.run.llmCalls).toBe(0);
  });

  it("keeps runs in the log, newest first", async () => {
    const { memloom } = await openStore();
    await memloom.save({ content: "the deploy target is fly.io" });
    const first = await memloom.reconcile();
    const second = await memloom.reconcile();

    const runs = await memloom.reconcileRuns();
    expect(runs.map((r) => r.id)).toEqual([second.run.id, first.run.id]);
    expect(runs[0]?.status).toBe("success");
  });
});
