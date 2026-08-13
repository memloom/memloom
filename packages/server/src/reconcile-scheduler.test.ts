import type { Memloom } from "@memloom/core";
import { SENTINEL_OWNER } from "@memloom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DaemonActivity, startReconcileScheduler } from "./index.js";

/**
 * The scheduler touches a handful of engine methods. Naming that slice keeps the fakes honest
 * without dragging the whole Memloom surface into a test that reads five of its methods.
 */
type SchedulerEngine = Pick<
  Memloom,
  "indexing" | "owners" | "lastReconcileFinishedAt" | "reconcileSettings" | "reconcile"
>;
const asEngine = (fake: unknown): Memloom => fake as SchedulerEngine as Memloom;

// The background half of memory-per-person. A reconcile pass reads one owner's memories and
// repairs one owner's graph, so a scheduler that only ever runs the default owner leaves every
// other tenant's memories saved and never maintained. That failure is invisible: nothing errors,
// nothing logs, the graph just quietly stops being true.

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

const HOUR = 3_600_000;

/**
 * The slice of the engine the scheduler touches. Real enough to answer the due checks, fake
 * enough to run in milliseconds and to let a test say "this owner reconciled two days ago".
 */
function engine(opts: {
  owners: string[];
  lastFinishedAt?: Record<string, string | null>;
  startupCatchUp?: boolean;
}) {
  const calls: { ownerId: string; trigger: string }[] = [];
  return {
    calls,
    memloom: asEngine({
      indexing: false,
      owners: async () => opts.owners,
      lastReconcileFinishedAt: async (ownerId: string = SENTINEL_OWNER) =>
        opts.lastFinishedAt?.[ownerId] ?? null,
      reconcileSettings: async () => ({ startupCatchUp: opts.startupCatchUp ?? true }),
      reconcile: async (o: { ownerId?: string; trigger?: string }) => {
        calls.push({ ownerId: o.ownerId ?? SENTINEL_OWNER, trigger: o.trigger ?? "manual" });
        return {};
      },
    }),
  };
}

/** A daemon nobody has touched for a long time, so the idle rule can fire. */
function quiet(): DaemonActivity {
  return { lastRequestAt: Date.now() - 24 * HOUR };
}

describe("reconcile scheduler across owners", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RECONCILE_ENABLED;
  });

  it("runs a startup catch-up for every owner, not just the default", async () => {
    vi.useFakeTimers();
    // Neither has ever reconciled, so both are overdue.
    const { memloom, calls } = engine({ owners: [OWNER_A, OWNER_B] });
    const stop = startReconcileScheduler(memloom, quiet());
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    stop();

    expect(calls.map((c) => c.ownerId).sort()).toEqual([OWNER_A, OWNER_B]);
    expect(calls.every((c) => c.trigger === "startup")).toBe(true);
  });

  it("skips an owner that reconciled recently and runs the one that did not", async () => {
    vi.useFakeTimers();
    const { memloom, calls } = engine({
      owners: [OWNER_A, OWNER_B],
      lastFinishedAt: {
        // Fresh: nothing to do for Anna.
        [OWNER_A]: new Date(Date.now() - HOUR).toISOString(),
        // Well past the catch-up threshold.
        [OWNER_B]: new Date(Date.now() - 100 * HOUR).toISOString(),
      },
    });
    const stop = startReconcileScheduler(memloom, quiet());
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    stop();

    // Asked per owner, not as one question about the daemon. Taking the oldest finish across
    // everyone would have swept Anna too, for no reason.
    expect(calls.map((c) => c.ownerId)).toEqual([OWNER_B]);
  });

  it("a fresh owner does not drag everyone into a sweep on every tick", async () => {
    vi.useFakeTimers();
    const { memloom, calls } = engine({
      owners: [OWNER_A, OWNER_B],
      lastFinishedAt: {
        [OWNER_A]: new Date(Date.now() - HOUR).toISOString(),
        [OWNER_B]: new Date(Date.now() - HOUR).toISOString(),
      },
      startupCatchUp: true,
    });
    const stop = startReconcileScheduler(memloom, quiet());
    // Several ticks: both owners are recent, so nothing is due and nothing should run.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    stop();

    expect(calls).toEqual([]);
  });

  it("RECONCILE_ENABLED=0 stops the scheduler for every owner", async () => {
    vi.useFakeTimers();
    process.env.RECONCILE_ENABLED = "0";
    const { memloom, calls } = engine({ owners: [OWNER_A, OWNER_B] });
    const stop = startReconcileScheduler(memloom, quiet());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    stop();

    expect(calls).toEqual([]);
  });

  it("one owner's failure does not strand the owners behind it", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const memloom = asEngine({
      indexing: false,
      owners: async () => [OWNER_A, OWNER_B],
      lastReconcileFinishedAt: async () => null,
      reconcileSettings: async () => ({ startupCatchUp: true }),
      reconcile: async (o: { ownerId?: string }) => {
        calls.push(o.ownerId ?? SENTINEL_OWNER);
        if (o.ownerId === OWNER_A) throw new Error("boom");
        return {};
      },
    });
    const stop = startReconcileScheduler(memloom, quiet());
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    stop();

    expect(calls).toEqual([OWNER_A, OWNER_B]);
  });

  it("an empty store still reconciles the sentinel, so a single-owner install is untouched", async () => {
    vi.useFakeTimers();
    const { memloom, calls } = engine({ owners: [] });
    const stop = startReconcileScheduler(memloom, quiet());
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    stop();

    expect(calls.map((c) => c.ownerId)).toEqual([SENTINEL_OWNER]);
  });
});
