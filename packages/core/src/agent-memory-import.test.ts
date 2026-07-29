import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  HashingEmbeddingProvider,
  NullLLMProvider,
  ScriptedLLMProvider,
} from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import type { EmbeddingProvider } from "./providers.js";
import { truncateAll } from "./test-store.js";
import { PgliteFactory } from "./testkit.js";

// End-to-end importAgentMemories against the in-memory store: folder discovery, the
// LLM-free parse path through the belief pipeline, per-memory ledger rows, provenance,
// and the dry-run and force contracts. Dedup classify prompts answer [] so distinct
// memories coexist.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

// One store for the whole file, emptied between tests. See test-store.ts: booting PGLite
// costs about six seconds and the tests themselves cost milliseconds, so a store per test
// spends effectively all of its wall clock on Postgres startup.
let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteFactory.open();
});
afterAll(async () => {
  await storage.close();
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memloom-agent-import-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeClaudeMemory(
  root: string,
  project: string,
  file: string,
  name: string,
  body: string,
  type = "project",
): string {
  const dir = join(root, project, "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `---\nname: ${name}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`);
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

async function fresh(
  llm: ScriptedLLMProvider | NullLLMProvider = new ScriptedLLMProvider(() => "[]"),
) {
  await truncateAll(storage);
  const embedding = new CountingEmbeddings();
  const memloom = new Memloom({ storage, embedding, llm, autoIndexDelayMs: 999_999 });
  await memloom.init();
  return { memloom, embedding, storage };
}

describe("importAgentMemories", () => {
  it("imports claude and copilot folders through the belief pipeline with provenance and ledger rows", async () => {
    const { memloom, embedding, storage } = await fresh();
    const claudeRoot = makeRoot();
    writeClaudeMemory(
      claudeRoot,
      "proj",
      "staging.md",
      "staging-db",
      "The staging database runs on Postgres 16.",
    );
    writeClaudeMemory(
      claudeRoot,
      "proj",
      "pnpm.md",
      "prefers-pnpm",
      "The user prefers pnpm.",
      "feedback",
    );
    const copilotRoot = makeRoot();
    writeFileSync(
      join(copilotRoot, "deploys.md"),
      "# Deploys\n\n## Tag from main\nReleases are tagged from main only.\n",
    );

    const events: string[] = [];
    const result = await memloom.importAgentMemories(
      { claudeRoot, copilotRoots: [copilotRoot] },
      (e) => events.push(`${e.agent}:${e.outcome}`),
    );

    expect(result.folders).toBe(2);
    expect(result.files).toBe(3);
    expect(result.memories).toBe(3);
    expect(result.saved).toBe(3);
    expect(result.calls.embedding).toBe(2);
    expect(embedding.calls).toBeGreaterThanOrEqual(2);
    expect(events).toEqual(["claude-code:imported", "copilot:imported"]);
    expect(result.error).toBeUndefined();

    const memories = await memloom.memories();
    expect(memories.map((m) => m.content).sort()).toEqual([
      "Releases are tagged from main only.",
      "The staging database runs on Postgres 16.",
      "The user prefers pnpm.",
    ]);
    const pref = memories.find((m) => m.content.includes("pnpm"));
    expect(pref?.memoryType).toBe("preference");

    const ledger = await storage.query<{ source: string; memories_saved: number }>(
      "SELECT source, memories_saved FROM import_ledger",
    );
    expect(ledger).toHaveLength(3);
    expect(ledger.every((row) => row.source === "agent-memory")).toBe(true);

    const provenance = await storage.query<{ file_path: string; excerpt: string }>(
      "SELECT file_path, excerpt FROM import_provenance WHERE source = 'agent-memory'",
    );
    expect(provenance).toHaveLength(3);
    expect(provenance.some((p) => p.file_path.endsWith("staging.md"))).toBe(true);
  });

  it("skips unchanged memories on a re-run with zero provider calls", async () => {
    const { memloom, embedding } = await fresh();
    const claudeRoot = makeRoot();
    writeClaudeMemory(claudeRoot, "proj", "a.md", "a", "alpha fact");

    await memloom.importAgentMemories({ claudeRoot, copilotRoots: [] });
    const before = embedding.calls;

    const events: string[] = [];
    const second = await memloom.importAgentMemories({ claudeRoot, copilotRoots: [] }, (e) =>
      events.push(e.outcome),
    );
    expect(second.unchanged).toBe(1);
    expect(second.saved).toBe(0);
    expect(second.calls.embedding).toBe(0);
    expect(embedding.calls).toBe(before);
    expect(events).toEqual(["up-to-date"]);
  });

  it("re-imports an edited memory and versions or conflicts it instead of duplicating", async () => {
    const { memloom } = await fresh();
    const claudeRoot = makeRoot();
    const path = writeClaudeMemory(claudeRoot, "proj", "a.md", "a", "the API port is 4319");
    await memloom.importAgentMemories({ claudeRoot, copilotRoots: [] });

    writeFileSync(path, "---\nname: a\n---\n\nthe API port is 4320\n");
    const second = await memloom.importAgentMemories({ claudeRoot, copilotRoots: [] });
    expect(second.unchanged).toBe(0);
    expect(second.saved + second.versioned + second.conflicts).toBe(1);
    expect(second.merged).toBe(0);
  });

  it("dry run counts what would be imported and writes nothing", async () => {
    const { memloom, embedding, storage } = await fresh();
    const claudeRoot = makeRoot();
    writeClaudeMemory(claudeRoot, "proj", "a.md", "a", "alpha fact");

    const result = await memloom.importAgentMemories({
      claudeRoot,
      copilotRoots: [],
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.memories).toBe(1);
    expect(result.saved).toBe(0);
    expect(embedding.calls).toBe(0);
    expect(await memloom.memories()).toHaveLength(0);
    expect(await storage.query("SELECT 1 FROM import_ledger")).toHaveLength(0);
  });

  it("force reprocesses unchanged files; exact duplicates merge instead of duplicating", async () => {
    const { memloom } = await fresh();
    const claudeRoot = makeRoot();
    writeClaudeMemory(claudeRoot, "proj", "a.md", "a", "alpha fact");
    await memloom.importAgentMemories({ claudeRoot, copilotRoots: [] });

    const forced = await memloom.importAgentMemories({ claudeRoot, copilotRoots: [], force: true });
    expect(forced.unchanged).toBe(0);
    expect(forced.merged).toBe(1);
    expect(await memloom.memories()).toHaveLength(1);
  });

  it("works without an LLM: parsing needs no distillation", async () => {
    const { memloom } = await fresh(new NullLLMProvider());
    const claudeRoot = makeRoot();
    writeClaudeMemory(claudeRoot, "proj", "a.md", "a", "alpha fact");
    const result = await memloom.importAgentMemories({ claudeRoot, copilotRoots: [] });
    expect(result.saved).toBe(1);
  });

  it("redacts secrets before anything reaches the store", async () => {
    const { memloom, storage } = await fresh();
    const claudeRoot = makeRoot();
    // Assembled at runtime so no key-shaped literal exists in this file (GitHub push
    // protection scans source; redact() only sees the joined string).
    const fakeKey = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;
    writeClaudeMemory(claudeRoot, "proj", "leak.md", "leak", `the deploy key is ${fakeKey}`);
    const result = await memloom.importAgentMemories({ claudeRoot, copilotRoots: [] });
    expect(result.redactions).toBeGreaterThan(0);
    const memories = await memloom.memories();
    expect(memories[0]?.content).not.toContain("sk-or-v1");
    const provenance = await storage.query<{ excerpt: string }>(
      "SELECT excerpt FROM import_provenance WHERE source = 'agent-memory'",
    );
    expect(provenance[0]?.excerpt).not.toContain("sk-or-v1");
  });

  it("rejects unknown agent names", async () => {
    const { memloom } = await fresh();
    await expect(memloom.importAgentMemories({ agents: ["cursor"] })).rejects.toThrow(
      /unknown agent/,
    );
  });

  it("respects the project filter", async () => {
    const { memloom } = await fresh();
    const claudeRoot = makeRoot();
    writeClaudeMemory(claudeRoot, "proj-one", "a.md", "a", "alpha fact");
    writeClaudeMemory(claudeRoot, "proj-two", "b.md", "b", "beta fact");
    const result = await memloom.importAgentMemories({
      claudeRoot,
      copilotRoots: [],
      project: "proj-one",
    });
    expect(result.folders).toBe(1);
    expect(result.saved).toBe(1);
  });
});
