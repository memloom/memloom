import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import {
  normalizeTags,
  parseScopePath,
  scopeSlug,
} from "./scopes.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";
import type { ScopeNode } from "./types.js";

// The scope dimension (PLAN-memory-scopes.md): the registry, the write path, and scoped
// recall. Hashing embeddings make keyword-ish queries deterministic, so scope filtering is
// observable through real recall rather than through the fuse's internals.

let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

async function make(llm: NullLLMProvider | ScriptedLLMProvider = new NullLLMProvider()): Promise<Memloom> {
  await truncateAll(storage);
  const m = new Memloom({ storage, embedding: new HashingEmbeddingProvider(1024), llm });
  await m.init();
  return m;
}

// Hashing embeddings score same-word contents as near, so multi-save fixtures pass the
// candidate gate; a scripted "complementary" verdict keeps every such save an "added".
const complementary = () =>
  new ScriptedLLMProvider(
    () => '[{"candidate": 1, "relation": "complementary", "reason": "both can be true"}]',
  );

function flatten(nodes: ScopeNode[]): ScopeNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

describe("scope helpers", () => {
  it("slugs names and parses paths case-insensitively", () => {
    expect(scopeSlug("  Personal Life ")).toBe("personal-life");
    expect(parseScopePath("Personal Life/People")).toEqual(["personal-life", "people"]);
    expect(() => parseScopePath("///")).toThrow(/empty scope path/);
    expect(() => parseScopePath("a/b/c/d/e/f/g")).toThrow(/deeper than/);
  });

  it("normalizes tags: trims, lowercases, dedupes, bounds", () => {
    expect(normalizeTags(["  AI ", "ai", "Twitch"])).toEqual(["ai", "twitch"]);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(() => normalizeTags(["x".repeat(65)])).toThrow(/longer than/);
    expect(() => normalizeTags(Array.from({ length: 17 }, (_, i) => `t${i}`))).toThrow(
      /more than/,
    );
  });
});

describe("scope registry", () => {
  it("creates folder paths, idempotently, and lists them as a tree", async () => {
    const m = await make();
    const created = await m.createScope("Projects/memloom", { description: "the engine" });
    expect(created.name).toBe("memloom");
    expect(created.description).toBe("the engine");
    const again = await m.createScope("projects/MEMLOOM");
    expect(again.id).toBe(created.id); // slug-matched, not duplicated

    const tree = await m.listScopes();
    const all = flatten(tree);
    // uncategorized + global seeded lazily, plus the two created
    expect(all.map((s) => s.path).sort()).toEqual([
      "global",
      "projects",
      "projects/memloom",
      "uncategorized",
    ]);
    const memloomNode = all.find((s) => s.path === "projects/memloom");
    expect(memloomNode?.kind).toBe("user");
    expect(all.find((s) => s.path === "global")?.kind).toBe("system");
  });

  it("refuses to rename or delete system folders, refuses cycles, deletes only empty", async () => {
    const m = await make();
    await m.createScope("a/b");
    const all = flatten(await m.listScopes());
    const a = all.find((s) => s.path === "a");
    const b = all.find((s) => s.path === "a/b");
    const uncat = all.find((s) => s.path === "uncategorized");
    if (!a || !b || !uncat) throw new Error("fixture folders missing");

    await expect(m.updateScope(uncat.id, { name: "junk" })).rejects.toThrow(/system folder/);
    await expect(m.deleteScope(uncat.id)).rejects.toThrow(/system folder/);
    await expect(m.moveScope(a.id, b.id)).rejects.toThrow(/own descendant/);
    await expect(m.deleteScope(a.id)).rejects.toThrow(/subfolders/);

    await m.save({ content: "belief in b", scope: "a/b" });
    await expect(m.deleteScope(b.id)).rejects.toThrow(/holds 1 memories/);
    const moved = await m.setMemoryScopes(
      (await m.memories()).map((x) => x.id),
      "uncategorized",
    );
    expect(moved).toBe(1);
    await m.deleteScope(b.id);
    await m.deleteScope(a.id);
  });
});

describe("scoped writes", () => {
  it("save with a scope lands there; without lands in uncategorized; unknown throws", async () => {
    const m = await make();
    await m.createScope("personal-life");
    const scoped = await m.save({ content: "sister lives in Krakow", scope: "personal-life" });
    const unscoped = await m.save({ content: "something else entirely" });
    await expect(m.save({ content: "x", scope: "no-such-folder" })).rejects.toThrow(
      /unknown scope/,
    );

    const rows = await m.memories();
    const bySid = new Map(rows.map((r) => [r.id, r]));
    expect(bySid.get(scoped.id)?.scopePath).toBe("personal-life");
    expect(bySid.get(unscoped.id)?.scopePath).toBe("uncategorized");
  });

  it("a restatement versions IN PLACE: the belief keeps its folder, tags union", async () => {
    const identical = new ScriptedLLMProvider(
      () => '[{"candidate": 1, "relation": "identical", "reason": "same fact"}]',
    );
    const m = await make(identical);
    await m.createScope("personal-life");
    await m.createScope("projects/memloom");
    const first = await m.save({
      content: "the dentist is on Karmelicka street",
      scope: "personal-life",
      tags: ["health"],
    });
    // Restated from a coding session with a different explicit scope: does NOT move.
    const second = await m.save({
      content: "dentist office address is Karmelicka street",
      scope: "projects/memloom",
      tags: ["address"],
    });
    expect(second.outcome).toBe("versioned");
    const history = await m.history(second.id);
    expect(history[0]?.scopePath).toBe("personal-life");
    expect(history[0]?.tags.sort()).toEqual(["address", "health"]);
    expect(history.map((h) => h.id)).toContain(first.id);
  });

  it("an exact duplicate merges and stays in the existing folder", async () => {
    const m = await make();
    await m.createScope("personal-life");
    await m.createScope("projects");
    const original = await m.save({ content: "the wifi password is hunter2", scope: "personal-life" });
    const dupe = await m.save({ content: "the wifi password is hunter2", scope: "projects" });
    expect(dupe.outcome).toBe("merged");
    expect(dupe.id).toBe(original.id);
    const [row] = await m.memories();
    expect(row?.scopePath).toBe("personal-life");
  });
});

describe("scoped recall", () => {
  async function seed(m: Memloom): Promise<void> {
    await m.createScope("personal-life");
    await m.createScope("projects/memloom");
    await m.save({ content: "alpha secret personal thing", scope: "personal-life" });
    await m.save({ content: "alpha secret project thing", scope: "projects/memloom" });
    await m.save({ content: "alpha secret unfiled thing" });
    await m.save({ content: "alpha secret universal preference", scope: "global" });
  }

  it("a scope subtree recalls itself + uncategorized + global, never other scopes", async () => {
    const m = await make(complementary());
    await seed(m);
    const hits = await m.recall("alpha secret", { scope: "personal-life" });
    const contents = hits.map((h) => h.content).sort();
    expect(contents).toEqual([
      "alpha secret personal thing",
      "alpha secret unfiled thing",
      "alpha secret universal preference",
    ]);
    // and the project scope sees its own + the same two widening folders
    const project = await m.recall("alpha secret", { scope: "projects" });
    expect(project.map((h) => h.content)).toContain("alpha secret project thing");
    expect(project.map((h) => h.content)).not.toContain("alpha secret personal thing");
  });

  it('"*" and omitted scope search everything; unknown scope throws', async () => {
    const m = await make(complementary());
    await seed(m);
    expect((await m.recall("alpha secret", { scope: "*" })).length).toBe(4);
    expect((await m.recall("alpha secret")).length).toBe(4);
    await expect(m.recall("alpha secret", { scope: "nope" })).rejects.toThrow(/unknown scope/);
  });

  it("tag filter is any-match and excludes untagged rows", async () => {
    const m = await make(complementary());
    await m.save({ content: "beta clip about streaming", tags: ["Twitch", "fun"] });
    await m.save({ content: "beta note about databases" });
    const hits = await m.recall("beta", { tags: ["twitch"] });
    expect(hits.map((h) => h.content)).toEqual(["beta clip about streaming"]);
    expect(hits[0]?.tags).toEqual(["twitch", "fun"]);
  });

  it("scoped memories() browses JUST the subtree, without recall's widening", async () => {
    const m = await make(complementary());
    await seed(m);
    const rows = await m.memories(undefined, { scope: "personal-life" });
    expect(rows.map((r) => r.content)).toEqual(["alpha secret personal thing"]);
  });
});

describe("scoped documents", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "memloom-scopes-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a document lands in its folder, chunks inherit, and recall filters by it", async () => {
    const m = await make();
    await m.createScope("projects/memloom");
    await m.createScope("personal-life");
    const file = join(dir, "notes.md");
    writeFileSync(file, "# Notes\n\ngamma detail about the fuse function\n");
    const added = await m.contextAdd({ path: file, scope: "projects/memloom" });
    expect(added.outcome).toBe("added");

    const inScope = await m.recall("gamma detail", { scope: "projects" });
    expect(inScope.some((h) => h.kind === "context")).toBe(true);
    const outOfScope = await m.recall("gamma detail", { scope: "personal-life" });
    expect(outOfScope.some((h) => h.kind === "context")).toBe(false);
  });

  it("re-scoping a document moves its chunks in the same transaction", async () => {
    const m = await make();
    await m.createScope("projects");
    await m.createScope("personal-life");
    const file = join(dir, "moveme.md");
    writeFileSync(file, "# Move\n\ndelta content that will change folders\n");
    const added = await m.contextAdd({ path: file, scope: "projects" });
    await m.setDocumentScope(added.documentId, "personal-life");

    const rows = await storage.query<{ scope_id: string | null }>(
      `SELECT cc.scope_id FROM context_chunks cc WHERE cc.document_id = $1`,
      [added.documentId],
    );
    expect(rows.length).toBeGreaterThan(0);
    const docScope = await storage.query<{ scope_id: string | null }>(
      "SELECT scope_id FROM context_documents WHERE id = $1",
      [added.documentId],
    );
    for (const row of rows) expect(row.scope_id).toBe(docScope[0]?.scope_id);
    const hits = await m.recall("delta content", { scope: "personal-life" });
    expect(hits.some((h) => h.kind === "context")).toBe(true);
  });

  it("re-adding an unchanged file with an explicit scope still moves it", async () => {
    const m = await make();
    await m.createScope("a");
    await m.createScope("b");
    const file = join(dir, "stable.md");
    writeFileSync(file, "# Stable\n\nepsilon content that never changes\n");
    await m.contextAdd({ path: file, scope: "a" });
    const second = await m.contextAdd({ path: file, scope: "b" });
    expect(second.outcome).toBe("unchanged");
    const hits = await m.recall("epsilon content", { scope: "b" });
    expect(hits.some((h) => h.kind === "context")).toBe(true);
  });

  it("a tag-filtered recall excludes chunks by construction", async () => {
    const m = await make();
    const file = join(dir, "tagless.md");
    writeFileSync(file, "# Tagless\n\nzeta words shared with the memory\n");
    await m.contextAdd({ path: file });
    await m.save({ content: "zeta words in a tagged memory", tags: ["zeta"] });
    const hits = await m.recall("zeta words", { tags: ["zeta"] });
    expect(hits.every((h) => h.kind === "memory")).toBe(true);
  });
});
