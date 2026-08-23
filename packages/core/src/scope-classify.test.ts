import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HashingEmbeddingProvider,
  NullLLMProvider,
  ScriptedLLMProvider,
} from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import { SCOPE_CLASSIFY_BATCH } from "./scope-classify.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";
import type { ScopeNode } from "./types.js";

// The scope classification pass inside index runs (PLAN-memory-scopes.md): uncategorized
// memories are filed into the owner's existing folders, batched, floor-gated, and stamped
// so no memory is ever shown to the model twice. The scripted model routes by prompt
// opener: graph extraction gets an empty graph, the dedup classifier gets its scripted
// relation, and the filing prompt consumes the replies the test queued.

let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

interface FilingScript {
  replies: unknown[];
  prompts: string[];
}

function filingLLM(script: FilingScript, dedupReply = "[]"): ScriptedLLMProvider {
  return new ScriptedLLMProvider((prompt) => {
    if (prompt.startsWith("You compare")) return dedupReply;
    if (prompt.startsWith("You file")) {
      script.prompts.push(prompt);
      const reply = script.replies.shift() ?? [];
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    }
    return '{"entities": [], "relationships": []}';
  });
}

async function make(
  llm: ScriptedLLMProvider | NullLLMProvider,
  opts: { dedup?: boolean } = {},
): Promise<Memloom> {
  await truncateAll(storage);
  const m = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm,
    autoIndexDelayMs: 999_999,
    ...(opts.dedup === undefined ? {} : { dedup: opts.dedup }),
  });
  await m.init();
  return m;
}

function flatten(nodes: ScopeNode[]): ScopeNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

async function scopeRows(): Promise<
  Array<{ content: string; status: string; scope_id: string | null; stamped: boolean }>
> {
  const rows = await storage.query<{
    content: string;
    status: string;
    scope_id: string | null;
    scope_classified_at: string | null;
  }>("SELECT content, status, scope_id, scope_classified_at FROM memory_objects ORDER BY version");
  return rows.map((r) => ({
    content: r.content,
    status: r.status,
    scope_id: r.scope_id,
    stamped: r.scope_classified_at !== null,
  }));
}

describe("scope classification pass", () => {
  it("files an above-floor verdict into an existing folder and moves the whole lineage", async () => {
    const script: FilingScript = {
      replies: [[{ index: 1, path: "projects/memloom", confidence: 0.9 }]],
      prompts: [],
    };
    const m = await make(
      filingLLM(script, '[{"candidate": 1, "relation": "identical", "reason": "same fact"}]'),
    );
    await m.createScope("projects/memloom", { description: "the memloom engine" });

    // Two versions of one belief: the restatement stales the first save, so the pass only
    // ever sees the active head, but the assignment must carry both rows.
    await m.save({ content: "the daemon listens on port 4319" });
    const second = await m.save({ content: "the daemon port number is 4319" });
    expect(second.outcome).toBe("versioned");

    await m.index();

    expect(script.prompts).toHaveLength(1);
    expect(script.prompts[0]).toContain("projects/memloom: the memloom engine");
    expect(script.prompts[0]).toContain("<<<");
    expect(script.prompts[0]).toContain("the daemon port number is 4319");

    const folder = flatten(await m.listScopes()).find((s) => s.path === "projects/memloom");
    const rows = await scopeRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.scope_id).toBe(folder?.id);
    // The stamp lands on what the pass judged: the active head.
    expect(rows.find((r) => r.status === "active")?.stamped).toBe(true);

    const [head] = await m.memories();
    expect(head?.scopePath).toBe("projects > memloom");
  });

  it("leaves a below-floor verdict in uncategorized and stamps it", async () => {
    const script: FilingScript = {
      replies: [[{ index: 1, path: "projects/memloom", confidence: 0.5 }]],
      prompts: [],
    };
    const m = await make(filingLLM(script));
    await m.createScope("projects/memloom");
    await m.save({ content: "the neighbor waters the plants on fridays" });

    await m.index();

    expect(script.prompts).toHaveLength(1);
    const [row] = await scopeRows();
    expect(row?.stamped).toBe(true);
    const [memory] = await m.memories();
    expect(memory?.scopePath).toBe("uncategorized");
  });

  it("ignores an invented path, stamps the memory, and never creates the folder", async () => {
    const script: FilingScript = {
      replies: [[{ index: 1, path: "projects/atlantis", confidence: 0.95 }]],
      prompts: [],
    };
    const m = await make(filingLLM(script));
    await m.createScope("projects/memloom");
    await m.save({ content: "the sunken city keeps its own records" });

    await m.index();

    const [row] = await scopeRows();
    expect(row?.stamped).toBe(true);
    const [memory] = await m.memories();
    expect(memory?.scopePath).toBe("uncategorized");
    expect(flatten(await m.listScopes()).some((s) => s.path === "projects/atlantis")).toBe(false);
  });

  it("never re-reads a stamped memory on the next run", async () => {
    const script: FilingScript = { replies: [[], []], prompts: [] };
    const m = await make(filingLLM(script));
    await m.createScope("projects/memloom");
    await m.save({ content: "the first note stays uncategorized" });
    await m.index();
    expect(script.prompts).toHaveLength(1);

    await m.save({ content: "a second note arrives later" });
    await m.index();
    expect(script.prompts).toHaveLength(2);
    expect(script.prompts[1]).toContain("a second note arrives later");
    expect(script.prompts[1]).not.toContain("the first note stays uncategorized");

    // Nothing new: no run at all, so no third call.
    await m.index();
    expect(script.prompts).toHaveLength(2);
  });

  it("batches at SCOPE_CLASSIFY_BATCH memories per call", async () => {
    const total = SCOPE_CLASSIFY_BATCH + 5;
    const script: FilingScript = { replies: [[], []], prompts: [] };
    const m = await make(filingLLM(script), { dedup: false });
    await m.createScope("projects/memloom");
    for (let i = 0; i < total; i++) {
      await m.save({ content: `note number ${i} about subject ${i}` });
    }

    await m.index();

    expect(script.prompts).toHaveLength(2);
    expect(script.prompts[0]).toContain(`${SCOPE_CLASSIFY_BATCH}. `);
    expect(script.prompts[0]).not.toContain(`${SCOPE_CLASSIFY_BATCH + 1}. `);
    expect(script.prompts[1]).toContain("5. ");
    const rows = await scopeRows();
    expect(rows).toHaveLength(total);
    expect(rows.every((r) => r.stamped)).toBe(true);
  });

  it("skips the pass when the owner has no user folders", async () => {
    const script: FilingScript = { replies: [[]], prompts: [] };
    const m = await make(filingLLM(script));
    await m.save({ content: "nowhere to file this yet" });

    await m.index();

    expect(script.prompts).toHaveLength(0);
    const [row] = await scopeRows();
    expect(row?.stamped).toBe(false);
  });

  it("skips the pass silently under NullLLMProvider", async () => {
    const m = await make(new NullLLMProvider());
    await m.createScope("projects/memloom");
    await m.save({ content: "no model to ask about this" });

    // Extraction fails per item under the null provider; the run must still finish
    // without the pass throwing or stamping anything.
    await m.index();

    const [row] = await scopeRows();
    expect(row?.stamped).toBe(false);
    const [memory] = await m.memories();
    expect(memory?.scopePath).toBe("uncategorized");
  });
});
