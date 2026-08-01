import type { ReconcileReport } from "@memloom/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatReconcileReport, run } from "./index.js";

// The CLI is now a thin router over the daemon (data commands auto-start `memloom serve` and
// talk to it over HTTP). Here we cover the router itself; save/recall behaviour is tested at
// the engine, server (HttpMemloomClient), and MCP-tools layers.

describe("cli router", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("help prints usage", async () => {
    await run(["help"]);
    expect(logs.join("\n")).toContain("Usage: memloom");
  });

  it("no command prints usage", async () => {
    await run([]);
    expect(logs.join("\n")).toContain("Usage: memloom");
  });

  it("unknown command sets a nonzero exit code", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await run(["frobnicate"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errSpy.mockRestore();
  });

  it("save --type validates against the taxonomy before touching the daemon", async () => {
    await expect(run(["save", "--type", "how-to", "some text"])).rejects.toThrow(
      /--type must be one of: fact, preference, episode, procedure/,
    );
    await expect(run(["save", "--type=diary", "some text"])).rejects.toThrow(/--type must be one/);
    // Flag with no text left over: usage error, not a save of the flag itself.
    await expect(run(["save", "--type", "fact"])).rejects.toThrow(/usage: memloom save/);
  });

  it("reconcile undo without a run id explains itself and never runs", async () => {
    await run(["reconcile", "undo"]);
    expect(logs.join("\n")).toContain("usage: memloom reconcile undo <run id>");
  });

  it("the reconcile report says what was found and that nothing changed", () => {
    const report: ReconcileReport = {
      run: {
        id: "run-1",
        mode: "dry_run",
        trigger: "manual",
        status: "success",
        scanned: 2262,
        retired: 0,
        folded: 0,
        questions: 40,
        conflictsRaised: 0,
        possible: 0,
        llmCalls: 0,
        startedAt: "2026-07-27T10:00:00.000Z",
        finishedAt: "2026-07-27T10:00:01.000Z",
        revertedAt: null,
      },
      actions: [
        {
          id: "a1",
          runId: "run-1",
          kind: "retire",
          class: "duplicate_content",
          memoryId: "aaaaaaaa-1111-2222-3333-444444444444",
          reason: "identical content to bbbbbbbb, which is older and stays active",
          applied: false,
          staledAt: null,
          surfaced: true,
          decision: null,
          mergeId: null,
          conflictId: null,
          candidateId: null,
          createdAt: "2026-07-27T10:00:00.000Z",
        },
        {
          id: "a2",
          runId: "run-1",
          kind: "question",
          class: "multi_head",
          memoryId: "cccccccc-1111-2222-3333-444444444444",
          reason: "4 versions of this belief are current at once (versions 6, 7, 7, 7).",
          applied: false,
          staledAt: null,
          surfaced: true,
          decision: null,
          mergeId: null,
          conflictId: null,
          candidateId: null,
          createdAt: "2026-07-27T10:00:00.000Z",
        },
      ],
      estimate: {
        window: 203,
        llmCalls: 203,
        inputTokens: 152_000,
        outputTokens: 24_000,
        model: "google/gemini-2.5-flash",
        usd: 0.214,
      },
      heldBack: { retire: 0, question: 37, conflict: 0 },
      passes: ["invariants", "entities"],
      entities: {
        examined: 1789,
        pairs: 42,
        merged: 6,
        queued: 4,
        deferred: 0,
        skipped: 32,
        mergeIds: [],
      },
    };

    const out = formatReconcileReport(report);
    expect(out).toContain("would retire 1:");
    expect(out).toContain("aaaaaaaa  identical content to bbbbbbbb");
    expect(out).toContain("...and 37 more");
    expect(out).toContain("would fold 6 name variants");
    expect(out).toContain("4 uncertain pairs would go to the conflicts tab");
    expect(out).toContain("203 memories in the contradiction re-check window");
    expect(out).toContain("152k in / 24k out with google/gemini-2.5-flash, about $0.21");
    // The reader must never have to infer this from the absence of bad news.
    expect(out).toContain("no memory was changed");
  });

  // A run whose whole output is questions used to print none of them: the report knew about
  // retirements, folds and ledger notes, and said nothing about the rows it put in the queue.
  it("the reconcile report names the conflicts it raised, and the ones it held back", () => {
    const report: ReconcileReport = {
      run: {
        id: "run-2",
        mode: "apply",
        trigger: "manual",
        status: "success",
        scanned: 2963,
        retired: 0,
        folded: 0,
        questions: 0,
        conflictsRaised: 2,
        possible: 0,
        llmCalls: 1,
        startedAt: "2026-08-01T10:00:00.000Z",
        finishedAt: "2026-08-01T10:00:01.000Z",
        revertedAt: null,
      },
      actions: [
        {
          id: "b1",
          runId: "run-2",
          kind: "conflict",
          class: "multi_head",
          memoryId: "dddddddd-1111-2222-3333-444444444444",
          reason: "2 versions of this belief are current at once (versions 3, 4).",
          applied: true,
          staledAt: null,
          surfaced: true,
          decision: null,
          mergeId: null,
          conflictId: "cf-1",
          candidateId: null,
          createdAt: "2026-08-01T10:00:00.000Z",
        },
        {
          id: "b2",
          runId: "run-2",
          kind: "conflict",
          class: "llm_entity_distinct",
          memoryId: null,
          reason: "a model kept two names apart",
          applied: true,
          staledAt: null,
          surfaced: true,
          decision: null,
          mergeId: null,
          conflictId: "cf-2",
          candidateId: null,
          createdAt: "2026-08-01T10:00:00.000Z",
        },
      ],
      estimate: {
        window: 0,
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: "google/gemini-2.5-flash",
        usd: null,
      },
      heldBack: { retire: 0, question: 0, conflict: 6 },
      passes: ["invariants", "llm_entities"],
      arbitration: {
        calls: 1,
        folded: 0,
        rejected: 1,
        unsure: 0,
        settled: [{ conflictId: "cf-2", class: "llm_entity_distinct", reason: "kept apart" }],
      },
    };

    const out = formatReconcileReport(report);
    expect(out).toContain("asked in the conflicts tab (1):");
    expect(out).toContain("dddddddd  2 versions of this belief are current at once");
    expect(out).toContain("...and 6 more, left for a later run");
    // A pair the model settled is already named under arbitration; listing it here as well
    // would read as two separate questions waiting on the user.
    expect(out).not.toContain("a model kept two names apart");
  });

  it("<command> --help prints that command's help without touching the daemon", async () => {
    // These must never call connect(); a daemon-less environment is the whole point.
    await run(["index", "--help"]);
    expect(logs.join("\n")).toContain("memloom index [--rebuild]");

    logs = [];
    await run(["save", "-h"]);
    expect(logs.join("\n")).toContain("memloom save [--type <type>] <text...>");

    logs = [];
    await run(["auto-index", "--help"]);
    expect(logs.join("\n")).toContain("memloom auto-index [on|off]");

    logs = [];
    await run(["reembed", "--help"]);
    expect(logs.join("\n")).toContain("memloom reembed [--force]");

    // help <command> is the same output; an unknown topic falls back to the main help.
    logs = [];
    await run(["help", "conflicts"]);
    expect(logs.join("\n")).toContain("memloom conflicts");

    logs = [];
    await run(["help", "frobnicate"]);
    expect(logs.join("\n")).toContain("Usage: memloom");
  });
});
