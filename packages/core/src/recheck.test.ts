import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom, SENTINEL_OWNER } from "./memloom.js";
import {
  buildRecheckPrompt,
  countDueForRecheck,
  findRecheckSubjects,
  MIN_QUOTE_CHARS,
  parseRecheckVerdicts,
  quoteOccursIn,
  verifiedFindings,
} from "./recheck.js";
import type { StorageAdapter } from "./storage.js";
import { PgliteFactory } from "./testkit.js";

// The contradiction re-check. The pure parts first (the parser and the quote check, which is the
// only thing standing between a model's claim and a row in the store), then the pass end to end.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const PAIR = [{ candidateId: "cand-1", content: "the deploy target is fly.io", similarity: 0.7 }];

describe("quote verification", () => {
  it("accepts a span that only differs by whitespace and case", () => {
    const source = "The deploy target\n  is fly.io, decided in March.";
    expect(quoteOccursIn("the deploy target is fly.io", source)).toBe(true);
  });

  it("rejects a paraphrase, which is the whole point", () => {
    const source = "The deploy target is fly.io, decided in March.";
    expect(quoteOccursIn("the deployment target is fly.io", source)).toBe(false);
  });

  it("rejects a quote too short to mean anything", () => {
    expect("no".length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(quoteOccursIn("no", "no Docker is required here")).toBe(false);
  });

  it("rejects an empty quote, which is how the model declines", () => {
    expect(quoteOccursIn("", "anything at all goes here")).toBe(false);
  });
});

describe("parseRecheckVerdicts", () => {
  it("reads a well-formed array", () => {
    const raw = `[{"candidate":1,"relation":"contradictory","reason":"moved to railway",
      "new_quote":"we run on railway now","old_quote":"the deploy target is fly.io"}]`;
    const [v] = parseRecheckVerdicts(raw, PAIR);
    expect(v).toMatchObject({
      candidateId: "cand-1",
      contradictory: true,
      newQuote: "we run on railway now",
    });
  });

  // Fail-open in the quiet direction: garbage must never manufacture a finding. Same choice the
  // save path makes, for the same reason.
  it("treats anything unrecognisable as complementary rather than a contradiction", () => {
    expect(parseRecheckVerdicts("I could not say", PAIR)).toEqual([]);
    expect(parseRecheckVerdicts("[{not json", PAIR)).toEqual([]);
    const [v] = parseRecheckVerdicts('[{"candidate":1,"relation":"who knows"}]', PAIR);
    expect(v?.contradictory).toBe(false);
  });

  it("drops a candidate number that does not exist", () => {
    expect(parseRecheckVerdicts('[{"candidate":9,"relation":"contradictory"}]', PAIR)).toEqual([]);
  });
});

describe("verifiedFindings", () => {
  const subject = { id: "new-1", content: "We run on railway now, as of August." };

  it("keeps a finding whose quotes are in both memories", () => {
    const findings = verifiedFindings(subject, PAIR, [
      {
        candidateId: "cand-1",
        contradictory: true,
        reason: "moved to railway",
        newQuote: "We run on railway now",
        oldQuote: "the deploy target is fly.io",
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ memoryId: "new-1", candidateId: "cand-1" });
  });

  // What rejection looks like in practice: a model that cannot find the span leaves the fields
  // empty rather than inventing one.
  it("drops a contradiction with no quotes at all", () => {
    const findings = verifiedFindings(subject, PAIR, [
      {
        candidateId: "cand-1",
        contradictory: true,
        reason: "these seem to disagree",
        newQuote: "",
        oldQuote: "",
      },
    ]);
    expect(findings).toEqual([]);
  });

  it("drops a contradiction whose quote is invented", () => {
    const findings = verifiedFindings(subject, PAIR, [
      {
        candidateId: "cand-1",
        contradictory: true,
        reason: "moved to railway",
        newQuote: "we have abandoned railway entirely",
        oldQuote: "the deploy target is fly.io",
      },
    ]);
    expect(findings).toEqual([]);
  });
});

describe("buildRecheckPrompt", () => {
  // Supersession is the class this pass exists for, so the prompt has to name it as a
  // contradiction out loud. Excluding "true then, changed now" removes the findings worth having.
  it("names a reversed decision as a contradiction that matters", () => {
    const prompt = buildRecheckPrompt({ content: "x" }, PAIR);
    expect(prompt).toContain("These ARE contradictions");
    expect(prompt).toContain("later reversed");
    expect(prompt).toMatch(/quote the two assertions/i);
  });

  it("warns that the candidates are mostly unrelated, which 20 neighbours at 0.5 are", () => {
    expect(buildRecheckPrompt({ content: "x" }, PAIR)).toContain("only loosely related");
  });
});

// One LLM whose contradiction verdict quotes both sides verbatim, so the pass has something to
// verify and record.
function arbiter(newQuote: string, oldQuote: string) {
  return new ScriptedLLMProvider((prompt) => {
    if (!prompt.startsWith("You compare a NEW memory")) return "[]";
    if (!prompt.includes("These ARE contradictions")) {
      // The save path's dedup prompt, not the re-check's: keep saves quiet.
      return JSON.stringify([{ candidate: 1, relation: "complementary", reason: "unrelated" }]);
    }
    return JSON.stringify([
      {
        candidate: 1,
        relation: "contradictory",
        reason: "deploy target changed",
        new_quote: newQuote,
        old_quote: oldQuote,
      },
    ]);
  });
}

async function openStore(llm: ScriptedLLMProvider) {
  const storage = await PgliteFactory.open();
  cleanups.push(() => storage.close());
  const memloom = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm,
    autoIndexDelayMs: 999_999,
  });
  await memloom.init();
  return { memloom, storage };
}

async function idsByContent(storage: StorageAdapter): Promise<Map<string, string>> {
  const rows = await storage.query<{ id: string; content: string }>(
    "SELECT id, content FROM memory_objects WHERE owner_id = $1",
    [SENTINEL_OWNER],
  );
  return new Map(rows.map((r) => [r.content, r.id]));
}

/**
 * Make two saved beliefs each other's nearest neighbour.
 *
 * The hashing embedding provider is deliberately not semantic, so two sentences about the same
 * thing land nowhere near each other and the pass's 0.5 floor finds nothing. Copying one vector
 * onto the other is how a test says "these are about the same subject" to code that only sees
 * cosine. Done after both saves, so the save path judged them on their original vectors, which is
 * exactly the situation the re-check exists for.
 */
async function makeNeighbours(storage: StorageAdapter, a: string, b: string): Promise<void> {
  await storage.query(
    `UPDATE memory_objects SET embedding = (
       SELECT embedding FROM memory_objects WHERE owner_id = $1 AND content = $2 LIMIT 1
     ) WHERE owner_id = $1 AND content = $3`,
    [SENTINEL_OWNER, a, b],
  );
}

describe("the re-check pass", () => {
  const OLD = "the deploy target is fly.io";
  const NEW = "we run on railway now";

  it("records a verified finding as possible, never as a conflict", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    await memloom.save({ content: OLD });
    await memloom.save({ content: NEW });
    await makeNeighbours(storage, OLD, NEW);
    // The save path was scripted to see nothing, which is the situation this pass exists for.
    expect(await memloom.conflicts()).toHaveLength(0);

    const report = await memloom.reconcile({
      mode: "apply",
      passes: ["llm_recheck"],
    });

    // Both beliefs are swept, so the pair is judged from both directions and the model claims
    // twice. Only one survives: this scripted model returns the same two quotes whichever way it
    // is asked, so on the reversed pair its "new" quote is not in the subject and the check drops
    // it. Accidental, and the clearest possible demonstration of what verification is for.
    expect(report.recheck).toMatchObject({ claimed: 2, verified: 1 });
    expect(report.run.possible).toBe(1);
    // The queue is untouched: 40 percent precision must not reach the badge or the gate.
    expect(await memloom.conflicts()).toHaveLength(0);

    const possible = await memloom.possibleContradictions();
    expect(possible.length).toBeGreaterThan(0);
    const finding = possible.find((p) => p.newMemory.content === NEW);
    expect(finding?.oldMemory.content).toBe(OLD);
    expect(finding?.newQuote).toBe(NEW);
    expect(finding?.reason).toContain("deploy target changed");
  });

  it("promotes an approved finding into a real conflict, and never asks again", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    await memloom.save({ content: OLD });
    await memloom.save({ content: NEW });
    await makeNeighbours(storage, OLD, NEW);
    await memloom.reconcile({ mode: "apply", passes: ["llm_recheck"] });

    const [first] = await memloom.possibleContradictions();
    if (!first) throw new Error("nothing to approve");
    const answered = await memloom.answerPossible(first.id, "approved");
    expect(answered.conflictId).toBeTruthy();

    // It is a conflict now, with the four resolution choices behind it.
    const conflicts = await memloom.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.candidates[0]?.content).toBeTruthy();

    // Answered means answered: a second run must not raise the same pair again.
    const second = await memloom.reconcile({ mode: "apply", passes: ["llm_recheck"] });
    const stillPossible = await memloom.possibleContradictions();
    expect(stillPossible.map((p) => p.id)).not.toContain(first.id);
    expect(second.recheck?.verified ?? 0).toBeLessThan(2);
  });

  it("a rejection is recorded and the pair is never raised again", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    await memloom.save({ content: OLD });
    await memloom.save({ content: NEW });
    await makeNeighbours(storage, OLD, NEW);
    await memloom.reconcile({ mode: "apply", passes: ["llm_recheck"] });

    const before = await memloom.possibleContradictions();
    for (const p of before) await memloom.answerPossible(p.id, "rejected");
    expect(await memloom.possibleContradictions()).toHaveLength(0);
    expect(await memloom.conflicts()).toHaveLength(0);

    const second = await memloom.reconcile({ mode: "apply", passes: ["llm_recheck"] });
    expect(second.recheck?.calls ?? 0).toBeGreaterThanOrEqual(0);
    expect(await memloom.possibleContradictions()).toHaveLength(0);
  });

  it("drops a claim the model cannot quote", async () => {
    // Both quotes are paraphrases, so nothing survives verification.
    const { memloom, storage } = await openStore(
      arbiter("we moved to railway", "deploy target: fly.io"),
    );
    await memloom.save({ content: OLD });
    await memloom.save({ content: NEW });
    await makeNeighbours(storage, OLD, NEW);

    const report = await memloom.reconcile({ mode: "apply", passes: ["llm_recheck"] });
    expect(report.recheck?.claimed).toBeGreaterThan(0);
    expect(report.recheck?.verified).toBe(0);
    expect(await memloom.possibleContradictions()).toHaveLength(0);
  });

  it("never calls a model on a dry run, however the settings are set", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    await memloom.save({ content: OLD });
    await memloom.save({ content: NEW });
    await makeNeighbours(storage, OLD, NEW);
    await memloom.setReconcileSettings({ llm_recheck: true });

    const report = await memloom.reconcile(); // dry run is the default
    expect(report.recheck).toBeUndefined();
    expect(report.run.llmCalls).toBe(0);
    expect(await memloom.possibleContradictions()).toHaveLength(0);
  });

  it("is off out of the box, and a free trigger cannot turn it on", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    expect((await memloom.reconcileSettings()).llm_recheck).toBe(false);

    await memloom.save({ content: OLD });
    await memloom.save({ content: NEW });
    await makeNeighbours(storage, OLD, NEW);
    await memloom.setReconcileSettings({ llm_recheck: true });
    // What startReconcileScheduler passes: the user's toggle is deliberately not consulted.
    const report = await memloom.reconcile({
      mode: "apply",
      trigger: "idle",
      passes: ["invariants", "entities"],
    });
    expect(report.recheck).toBeUndefined();
    expect(report.run.llmCalls).toBe(0);
  });

  // The invariant a capped sweep lives or dies on: a store larger than one run's ceiling must
  // drain across runs, and a belief must never be passed over for good.
  it("drains the backlog oldest first and skips nothing", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    for (let i = 0; i < 5; i++) await memloom.save({ content: `belief number ${i}` });

    const order = await storage.query<{ id: string; content: string }>(
      "SELECT id, content FROM memory_objects WHERE owner_id = $1 ORDER BY created_at ASC",
      [SENTINEL_OWNER],
    );
    const oldestTwo = order.slice(0, 2).map((r) => r.content);

    // A ceiling of 2 takes the two oldest, and only those two get stamped.
    const first = await findRecheckSubjects(storage, SENTINEL_OWNER, 2);
    expect(first.map((s) => s.content)).toEqual(oldestTwo);
    for (const s of first) {
      await storage.query("UPDATE memory_objects SET last_rechecked_at = now() WHERE id = $1", [
        s.id,
      ]);
    }

    // The next call resumes where that one stopped rather than starting over.
    const second = await findRecheckSubjects(storage, SENTINEL_OWNER, 2);
    expect(second.map((s) => s.content)).toEqual(order.slice(2, 4).map((r) => r.content));

    // Stamp the rest, and nothing is due until the quiet period lapses.
    await storage.query("UPDATE memory_objects SET last_rechecked_at = now()");
    expect(await findRecheckSubjects(storage, SENTINEL_OWNER, 10)).toEqual([]);
    expect((await countDueForRecheck(storage, SENTINEL_OWNER)).count).toBe(0);

    // A belief checked longer ago than the quiet period is due again: this is how an old belief
    // gets a second look once the store has moved on around it.
    await storage.query(
      "UPDATE memory_objects SET last_rechecked_at = now() - interval '31 days' WHERE id = $1",
      [order[0]?.id],
    );
    expect((await countDueForRecheck(storage, SENTINEL_OWNER)).count).toBe(1);
    const due = await findRecheckSubjects(storage, SENTINEL_OWNER, 10);
    expect(due.map((s) => s.content)).toEqual([order[0]?.content]);
  });

  it("stamps only the beliefs a run actually checked", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    await memloom.save({ content: OLD });
    await memloom.save({ content: NEW });
    await makeNeighbours(storage, OLD, NEW);
    expect((await countDueForRecheck(storage, SENTINEL_OWNER)).count).toBe(2);

    await memloom.reconcile({ mode: "apply", passes: ["llm_recheck"] });
    expect((await countDueForRecheck(storage, SENTINEL_OWNER)).count).toBe(0);

    // A dry run must not stamp: it spends nothing, so it still owes the work it did not do.
    await storage.query("UPDATE memory_objects SET last_rechecked_at = NULL");
    await memloom.setReconcileSettings({ llm_recheck: true });
    await memloom.reconcile();
    expect((await countDueForRecheck(storage, SENTINEL_OWNER)).count).toBe(2);
  });

  // A sweep takes minutes, so a second click looks like the first did nothing. Two runs would
  // sweep the same beliefs and bill twice.
  it("refuses a second applying run while one is live, and writes off a dead one", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    await memloom.save({ content: OLD });

    await storage.query(
      `INSERT INTO memory_reconcile_runs (owner_id, mode, trigger, status)
       VALUES ($1, 'apply', 'manual', 'running')`,
      [SENTINEL_OWNER],
    );
    await expect(memloom.reconcile({ mode: "apply" })).rejects.toThrow(/already going/);

    // A preview spends nothing, so it is never blocked.
    await expect(memloom.reconcile()).resolves.toBeTruthy();

    // A run old enough to be dead is written off rather than blocking every future run.
    await storage.query(
      "UPDATE memory_reconcile_runs SET started_at = now() - interval '31 minutes' WHERE status = 'running'",
    );
    await expect(memloom.reconcile({ mode: "apply" })).resolves.toBeTruthy();
    const [dead] = await storage.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_reconcile_runs WHERE status = 'aborted'",
    );
    expect(Number(dead?.n)).toBe(1);
  });

  it("moves its counters while it runs, not only at the end", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    await memloom.save({ content: OLD });
    await memloom.save({ content: NEW });
    await makeNeighbours(storage, OLD, NEW);

    const report = await memloom.reconcile({ mode: "apply", passes: ["llm_recheck"] });
    // scanned is written before the slow pass starts, so a watcher never sees a run claiming 0.
    expect(report.run.scanned).toBeGreaterThan(0);
    expect(report.run.llmCalls).toBeGreaterThan(0);
  });

  it("skips two versions of one belief, since supersession is not contradiction", async () => {
    const { memloom, storage } = await openStore(arbiter(NEW, OLD));
    await memloom.save({ content: OLD });
    const ids = await idsByContent(storage);
    const oldId = ids.get(OLD);
    if (!oldId) throw new Error("seed failed");
    // A second version of the same lineage, the shape a resolved conflict leaves behind.
    await storage.query(
      `INSERT INTO memory_objects
         (owner_id, root_id, version, memory_type, content, content_hash, embedding)
       SELECT owner_id, root_id, version + 1, memory_type, $2, $3, embedding
         FROM memory_objects WHERE id = $1`,
      [oldId, NEW, "hash-for-second-version"],
    );

    const subjects = await findRecheckSubjects(storage, SENTINEL_OWNER, 50);
    for (const s of subjects) {
      expect(s.candidates.map((c) => c.content)).not.toContain(OLD);
    }
  });
});
