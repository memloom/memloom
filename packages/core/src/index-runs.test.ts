import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom, SENTINEL_OWNER } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";

// Index sessions: every index()/reindex() pass records a memory_index_runs row plus one
// event per item, so the Console's log is persistent (survives tab switches, page reloads,
// daemon restarts) and CLI runs surface in the viewer too.

// Match only the TEXT section: the prompt's KNOWN ENTITIES list would otherwise trip
// the matcher with names extracted from earlier items.
const textOf = (prompt: string) => prompt.slice(prompt.indexOf("TEXT:"));

const extractor = new ScriptedLLMProvider((prompt) => {
  const text = textOf(prompt);
  const entities: Array<{ name: string; type: string }> = [];
  if (text.includes("Postgres")) entities.push({ name: "Postgres", type: "technology" });
  if (text.includes("Redis")) entities.push({ name: "Redis", type: "technology" });
  return JSON.stringify({ entities, relationships: [] });
});

describe("index run sessions", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh(llm = extractor): Promise<{ m: Memloom; storage: StorageAdapter }> {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm,
      dedup: false,
    });
    await m.init();
    return { m, storage };
  }

  it("records a run row with totals and one event per item", async () => {
    const { m } = await fresh();
    await m.save({ content: "the staging database runs on Postgres" });
    await m.save({ content: "we cache queries in Redis" });
    await m.index();

    const runs = await m.listIndexRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run).toMatchObject({
      trigger: "index",
      status: "success",
      batchSize: 2,
      memoriesIndexed: 2,
      chunksIndexed: 0,
      itemsFailed: 0,
      entitiesLinked: 2,
    });
    expect(run?.finishedAt).not.toBeNull();

    const events = await m.indexRunEvents(run?.id ?? "");
    expect(events).toHaveLength(2);
    expect(events[0]?.level).toBe("success");
    expect(events[0]?.message).toContain("[1/2] memory");
    expect(events[0]?.message).toContain("Postgres");
    expect(events[0]?.metadata.entities).toEqual(["Postgres"]);
  });

  it("a run with nothing pending leaves no session row", async () => {
    const { m } = await fresh();
    await m.index();
    expect(await m.listIndexRuns()).toHaveLength(0);
  });

  it("a failing item is logged, left unindexed for retry, and the run finishes 'warning'", async () => {
    const failing = new ScriptedLLMProvider((prompt) => {
      const text = textOf(prompt);
      if (text.includes("Redis")) throw new Error("provider exploded");
      return JSON.stringify({
        entities: text.includes("Postgres") ? [{ name: "Postgres", type: "technology" }] : [],
        relationships: [],
      });
    });
    const { m } = await fresh(failing);
    await m.save({ content: "the staging database runs on Postgres" });
    await m.save({ content: "we cache queries in Redis" });

    const events: Array<{ error?: string }> = [];
    const result = await m.index(undefined, (e) => events.push(e));
    expect(result.indexed).toBe(1); // the failed item does not count as indexed
    expect(events.some((e) => e.error === "provider exploded")).toBe(true);

    const [run] = await m.listIndexRuns();
    expect(run).toMatchObject({ status: "warning", memoriesIndexed: 1, itemsFailed: 1 });
    const logged = await m.indexRunEvents(run?.id ?? "");
    const failure = logged.find((e) => e.level === "error");
    expect(failure?.message).toContain("failed: provider exploded");
    expect(failure?.metadata.error).toBe("provider exploded");

    // The failed memory stayed unindexed: the next run retries exactly it.
    const retry = await m.index();
    expect(retry.indexed).toBe(0); // still fails, still unindexed
    const runsAfter = await m.listIndexRuns();
    expect(runsAfter).toHaveLength(2);
    expect(runsAfter[0]?.status).toBe("error"); // nothing succeeded in the retry run
    expect(runsAfter[0]?.batchSize).toBe(1);
  });

  it("auto-index: a save triggers a background run; a burst debounces into one", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: extractor,
      dedup: false,
      autoIndex: true,
      // Wide enough that three sequential PGLite saves always land inside one window.
      autoIndexDelayMs: 200,
    });
    await m.init();

    // Three quick writes: the debounce must collapse them into ONE run.
    await m.save({ content: "the staging database runs on Postgres" });
    await m.save({ content: "we cache queries in Redis" });
    await m.save({ content: "the daily standup is at 9am" });

    // Poll until the background run lands (bounded; the run itself is fast).
    const deadline = Date.now() + 5000;
    let runs = await m.listIndexRuns();
    while ((runs.length === 0 || runs[0]?.status === "running") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      runs = await m.listIndexRuns();
    }
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "index", status: "success", batchSize: 3 });
    expect((await m.graph()).entities.map((e) => e.name).sort()).toEqual(["Postgres", "Redis"]);

    // Nothing left pending: a manual index right after is a no-op (no second run row).
    expect(await m.index()).toEqual({ indexed: 0, chunksIndexed: 0 });
    expect(await m.listIndexRuns()).toHaveLength(1);
  });

  it("auto-index off (the default): a save leaves rows unindexed and no runs", async () => {
    const { m } = await fresh();
    await m.save({ content: "the staging database runs on Postgres" });
    await new Promise((r) => setTimeout(r, 100));
    expect(await m.listIndexRuns()).toHaveLength(0);
    expect((await m.graph()).entities).toHaveLength(0);
  });

  it("auto-index failures never reject the save that scheduled them", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const exploding = new ScriptedLLMProvider(() => {
      throw new Error("provider exploded");
    });
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: exploding,
      dedup: false,
      autoIndex: true,
      autoIndexDelayMs: 25,
    });
    await m.init();

    await expect(
      m.save({ content: "the staging database runs on Postgres" }),
    ).resolves.toBeTruthy();
    const deadline = Date.now() + 5000;
    let runs = await m.listIndexRuns();
    while ((runs.length === 0 || runs[0]?.status === "running") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      runs = await m.listIndexRuns();
    }
    // The run happened, failed per-item, and the memory stays unindexed for a retry.
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.itemsFailed).toBe(1);
  });

  it("reindex records a 'rebuild' session", async () => {
    const { m } = await fresh();
    await m.save({ content: "the staging database runs on Postgres" });
    await m.index();
    await m.reindex();

    const runs = await m.listIndexRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.trigger).toBe("rebuild"); // newest first
    expect(runs[1]?.trigger).toBe("index");
  });

  it("a run left 'running' by a dead process is reconciled to 'interrupted' on read", async () => {
    const { m, storage } = await fresh();
    // Simulate a daemon killed mid-run: a running row this process isn't executing.
    await storage.query(
      `INSERT INTO memory_index_runs (owner_id, trigger, status, batch_size)
       VALUES ($1, 'index', 'running', 5)`,
      [SENTINEL_OWNER],
    );

    const runs = await m.listIndexRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("interrupted");
    expect(runs[0]?.finishedAt).not.toBeNull();
  });

  it("deleting a session cascades to its events; clear wipes the history", async () => {
    const { m, storage } = await fresh();
    await m.save({ content: "the staging database runs on Postgres" });
    await m.index();
    await m.save({ content: "we cache queries in Redis" });
    await m.index();

    const runs = await m.listIndexRuns();
    expect(runs).toHaveLength(2);
    await m.deleteIndexRun(runs[0]?.id ?? "");
    expect(await m.listIndexRuns()).toHaveLength(1);
    const orphaned = await storage.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_index_events WHERE run_id = $1",
      [runs[0]?.id ?? ""],
    );
    expect(Number(orphaned[0]?.n)).toBe(0);

    await m.clearIndexRuns();
    expect(await m.listIndexRuns()).toHaveLength(0);
    const remaining = await storage.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_index_events",
    );
    expect(Number(remaining[0]?.n)).toBe(0);
  });
});
