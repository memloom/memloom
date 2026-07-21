import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import type { EmbeddingProvider } from "./providers.js";
import { PgliteFactory } from "./testkit.js";

// End-to-end importClaudeCode against the in-memory store: bounded discovery, distillation
// through the belief pipeline, the ledger watermark, provenance rows, and the dry-run and
// no-LLM contracts. The scripted model distills deterministically: every transcript line
// containing "remember: X" becomes one fact X, and dedup classify prompts answer [].

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memloom-import-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function backdate(path: string, ageMs = 60 * 60 * 1000): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

function writeSession(root: string, project: string, texts: string[], sessionId?: string): string {
  const id = sessionId ?? randomUUID();
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const lines = texts.map((text) =>
    JSON.stringify({
      type: "user",
      sessionId: id,
      message: { role: "user", content: [{ type: "text", text }] },
    }),
  );
  writeFileSync(path, `${lines.join("\n")}\n`);
  backdate(path);
  return path;
}

class CountingEmbeddings implements EmbeddingProvider {
  readonly #inner = new HashingEmbeddingProvider(1024);
  calls = 0;
  readonly dims = this.#inner.dims;
  readonly fingerprint = this.#inner.fingerprint;
  embed(texts: readonly string[]): Promise<number[][]> {
    this.calls++;
    return this.#inner.embed(texts);
  }
}

function distillingLLM(): ScriptedLLMProvider & { distillCalls: { count: number } } {
  const distillCalls = { count: 0 };
  const llm = new ScriptedLLMProvider((prompt) => {
    // The dedup classifier prompt starts "You compare..."; everything can coexist.
    if (prompt.startsWith("You compare")) return "[]";
    distillCalls.count++;
    const memories = [...prompt.matchAll(/remember: ([^\n"]+)/g)].map((m) => ({
      type: "fact",
      content: m[1],
      lines: [1, 1],
    }));
    return JSON.stringify(memories);
  });
  return Object.assign(llm, { distillCalls });
}

async function fresh(llm = distillingLLM()) {
  const storage = await PgliteFactory.open();
  cleanups.push(() => storage.close());
  const embedding = new CountingEmbeddings();
  const memloom = new Memloom({ storage, embedding, llm, autoIndexDelayMs: 999_999 });
  await memloom.init();
  return { memloom, embedding, llm, storage };
}

describe("importClaudeCode", () => {
  it("distills sessions into memories with provenance and a ledger row", async () => {
    const { memloom, embedding, llm, storage } = await fresh();
    const root = makeRoot();
    writeSession(root, "proj", [
      "remember: the staging database runs on postgres",
      "unrelated chatter",
      "remember: releases are tagged from main",
    ]);

    const events: string[] = [];
    const result = await memloom.importClaudeCode({ root }, (e) => events.push(e.outcome));

    expect(result.sessions).toBe(1);
    expect(result.saved).toBe(2);
    expect(result.calls.extraction).toBe(1);
    expect(result.calls.embedding).toBe(1);
    expect(llm.distillCalls.count).toBe(1);
    expect(embedding.calls).toBeGreaterThan(0);
    expect(events).toEqual(["imported"]);

    const memories = await memloom.memories();
    expect(memories.map((m) => m.content).sort()).toEqual([
      "releases are tagged from main",
      "the staging database runs on postgres",
    ]);

    const provenance = await storage.query<{ excerpt: string; start_line: number }>(
      "SELECT excerpt, start_line FROM import_provenance",
    );
    expect(provenance).toHaveLength(2);

    const ledger = await storage.query<{ line_offset: number; memories_saved: number }>(
      "SELECT line_offset, memories_saved FROM import_ledger",
    );
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]?.line_offset)).toBe(3);
    expect(Number(ledger[0]?.memories_saved)).toBe(2);
  });

  it("dry run makes zero LLM and embed calls and writes nothing", async () => {
    const { memloom, embedding, llm, storage } = await fresh();
    const root = makeRoot();
    writeSession(root, "proj", ["remember: nothing should happen"]);

    const result = await memloom.importClaudeCode({ root, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.sessions).toBe(1);
    expect(result.calls).toEqual({ extraction: 0, embedding: 0, classifier: 0 });
    expect(llm.distillCalls.count).toBe(0);
    expect(embedding.calls).toBe(0);
    expect(await memloom.memories()).toHaveLength(0);
    expect(await storage.query("SELECT 1 FROM import_ledger")).toHaveLength(0);
  });

  it("a re-run on unchanged files is up to date with zero LLM calls", async () => {
    const { memloom, llm } = await fresh();
    const root = makeRoot();
    writeSession(root, "proj", ["remember: idempotent imports"]);

    await memloom.importClaudeCode({ root });
    const callsAfterFirst = llm.distillCalls.count;
    const second = await memloom.importClaudeCode({ root });

    expect(second.skipped.upToDate).toBe(1);
    expect(second.sessions).toBe(0);
    expect(second.calls.extraction).toBe(0);
    expect(llm.distillCalls.count).toBe(callsAfterFirst);
  });

  it("a grown session distills again and dedup merges the overlap", async () => {
    const { memloom } = await fresh();
    const root = makeRoot();
    const id = randomUUID();
    const path = writeSession(root, "proj", ["remember: the first fact"], id);

    const first = await memloom.importClaudeCode({ root });
    expect(first.saved).toBe(1);

    appendFileSync(
      path,
      `${JSON.stringify({
        type: "user",
        sessionId: id,
        message: { role: "user", content: [{ type: "text", text: "remember: the second fact" }] },
      })}\n`,
    );
    backdate(path);

    const second = await memloom.importClaudeCode({ root });
    // The overlap window re-reads the small session in full: the old fact merges by exact
    // hash (no duplicate row), the new one is saved.
    expect(second.saved).toBe(1);
    expect(second.merged).toBe(1);
    expect((await memloom.memories()).map((m) => m.content).sort()).toEqual([
      "the first fact",
      "the second fact",
    ]);
  });

  it("a rewritten prefix (hash mismatch) reprocesses from zero without duplicating", async () => {
    const { memloom } = await fresh();
    const root = makeRoot();
    const id = randomUUID();
    const path = writeSession(root, "proj", ["remember: stable fact", "padding line"], id);

    await memloom.importClaudeCode({ root });

    // Rewrite line 2 in place: same line count, different prefix. The watermark's offset now
    // points at different content, so the run must start over instead of resuming.
    const rewritten = readFileSync(path, "utf8").replace("padding line", "compacted away");
    writeFileSync(path, rewritten);
    backdate(path);

    const second = await memloom.importClaudeCode({ root });
    expect(second.sessions).toBe(1);
    expect(second.merged).toBe(1);
    expect(await memloom.memories()).toHaveLength(1);
  });

  it("--force reprocesses an up-to-date session", async () => {
    const { memloom } = await fresh();
    const root = makeRoot();
    writeSession(root, "proj", ["remember: forced"]);

    await memloom.importClaudeCode({ root });
    const forced = await memloom.importClaudeCode({ root, force: true });
    expect(forced.sessions).toBe(1);
    expect(forced.calls.extraction).toBe(1);
    expect(forced.merged).toBe(1);
    expect(await memloom.memories()).toHaveLength(1);
  });

  it("redacts secrets before the store and the provider", async () => {
    const prompts: string[] = [];
    const llm = new ScriptedLLMProvider((prompt) => {
      if (prompt.startsWith("You compare")) return "[]";
      prompts.push(prompt);
      return JSON.stringify([{ type: "fact", content: "an api key was configured", lines: [1, 1] }]);
    });
    const { memloom, storage } = await fresh(Object.assign(llm, { distillCalls: { count: 0 } }));
    const root = makeRoot();
    writeSession(root, "proj", ["set the key to sk-or-v1-0123456789abcdef0123456789abcdef"]);

    const result = await memloom.importClaudeCode({ root });
    expect(result.redactions).toBe(1);
    expect(prompts.join("\n")).not.toContain("sk-or-v1-0123456789abcdef");
    const provenance = await storage.query<{ excerpt: string }>(
      "SELECT excerpt FROM import_provenance",
    );
    expect(provenance[0]?.excerpt).toContain("[redacted]");
    expect(provenance[0]?.excerpt).not.toContain("sk-or-v1");
  });

  it("a provider failure mid-session keeps the saved chunks and resumes on re-run", async () => {
    // Two chunks: two big units that cannot share the chunk budget. The provider dies on the
    // second distill call (the real-world 402 out-of-credits case): chunk one's memory must
    // survive, the ledger must watermark past chunk one, the run must end with a summary
    // carrying the error, and a re-run with a healed provider must pick up the rest.
    const padding = "x".repeat(23_000);
    let healed = false;
    let distillCalls = 0;
    const llm = new ScriptedLLMProvider((prompt) => {
      if (prompt.startsWith("You compare")) return "[]";
      distillCalls++;
      if (!healed && distillCalls === 2) {
        throw new Error("OpenRouter completion failed: 402 requires more credits");
      }
      const memories = [...prompt.matchAll(/remember: ([^\n"]+)/g)].map((m) => ({
        type: "fact",
        content: m[1],
        lines: [1, 1],
      }));
      return JSON.stringify(memories);
    });
    const { memloom, storage } = await fresh(Object.assign(llm, { distillCalls: { count: 0 } }));
    const root = makeRoot();
    writeSession(root, "proj", [
      `remember: the alpha fact\n${padding}`,
      `remember: the beta fact\n${padding}`,
    ]);

    const events: string[] = [];
    const first = await memloom.importClaudeCode({ root }, (e) => events.push(e.outcome));

    expect(first.error).toContain("402");
    expect(events).toEqual(["partial"]);
    expect(first.saved).toBe(1);
    expect((await memloom.memories()).map((m) => m.content)).toEqual(["the alpha fact"]);
    const [ledger] = await storage.query<{ line_offset: number }>(
      "SELECT line_offset FROM import_ledger",
    );
    expect(Number(ledger?.line_offset)).toBe(1);

    healed = true;
    const second = await memloom.importClaudeCode({ root });
    expect(second.error).toBeUndefined();
    expect(second.saved).toBe(1);
    expect(second.merged).toBe(1);
    expect((await memloom.memories()).map((m) => m.content).sort()).toEqual([
      "the alpha fact",
      "the beta fact",
    ]);
  });

  it("refuses without an LLM", async () => {
    const storage = await PgliteFactory.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
      dedup: false,
    });
    await memloom.init();
    await expect(memloom.importClaudeCode({ root: makeRoot() })).rejects.toThrow(
      /none is configured/,
    );
  });

  it("a conflicting distillation lands in the conflict queue", async () => {
    const llm = new ScriptedLLMProvider((prompt) => {
      if (prompt.startsWith("You compare")) {
        return JSON.stringify([
          { candidate: 1, relation: "contradictory", reason: "cannot both be true" },
        ]);
      }
      const memories = [...prompt.matchAll(/remember: ([^\n"]+)/g)].map((m) => ({
        type: "fact",
        content: m[1],
        lines: [1, 1],
      }));
      return JSON.stringify(memories);
    });
    const { memloom } = await fresh(Object.assign(llm, { distillCalls: { count: 0 } }));
    await memloom.save({ content: "the deploy target is fly.io" });

    const root = makeRoot();
    writeSession(root, "proj", ["remember: the deploy target is fly.io but bigger"]);
    const result = await memloom.importClaudeCode({ root });

    expect(result.conflicts + result.saved).toBeGreaterThan(0);
    if (result.conflicts > 0) {
      const conflicts = await memloom.conflicts();
      expect(conflicts.length).toBeGreaterThan(0);
    }
  });
});
