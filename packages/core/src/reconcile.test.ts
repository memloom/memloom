import { afterEach, describe, expect, it } from "vitest";
import { effectiveCaps, PROMPT_OVERHEAD_TOKENS } from "./reconcile.js";
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
function quietLlm() {
  return new ScriptedLLMProvider((prompt) =>
    prompt.startsWith("You compare")
      ? JSON.stringify([{ candidate: 1, relation: "complementary", reason: "unrelated" }])
      : "[]",
  );
}

async function openStore() {
  const storage = await PgliteFactory.open();
  cleanups.push(() => storage.close());
  const memloom = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm: quietLlm(),
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
    expect(effectiveCaps(0)).toEqual({ retire: 10, question: 3, conflict: 5 });
    expect(effectiveCaps(1)).toEqual({ retire: 5, question: 1, conflict: 2 });
    expect(effectiveCaps(2)).toEqual({ retire: 2, question: 0, conflict: 1 });
    expect(effectiveCaps(3)).toEqual({ retire: 0, question: 0, conflict: 0 });

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
