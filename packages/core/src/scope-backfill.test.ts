import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodedProjectDirOf } from "./claude-sessions.js";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom, SENTINEL_OWNER } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";

// The mechanical backfill (PLAN-memory-scopes.md child 4): provenance-bearing memories
// file into projects/<name> deterministically. The pass must be idempotent, must never
// override a hand-filing, and a dry run must write nothing at all.

let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

async function make(): Promise<Memloom> {
  await truncateAll(storage);
  const m = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm: new NullLLMProvider(),
    dedup: false,
  });
  await m.init();
  return m;
}

/** Attach session-import-shaped provenance to a memory. */
async function provenance(memoryId: string, filePath: string): Promise<void> {
  await storage.query(
    `INSERT INTO import_provenance (memory_id, owner_id, source, session_id, file_path, start_line, end_line, excerpt)
     VALUES ($1, $2, 'claude-code', 'session-1', $3, 1, 5, 'excerpt')`,
    [memoryId, SENTINEL_OWNER, filePath],
  );
}

const TRANSCRIPT = "C:/Users/k/.claude/projects/D--Kostek-Projects-memloom/abc.jsonl";
const OTHER = "C:/Users/k/.claude/projects/D--Kostek-Projects-widget/def.jsonl";
const COPILOT = "C:/Users/k/AppData/globalStorage/github.copilot-chat/memories/note.md";

describe("encodedProjectDirOf", () => {
  it("finds the segment after .claude/projects at any depth, both separators", () => {
    expect(encodedProjectDirOf(TRANSCRIPT)).toBe("D--Kostek-Projects-memloom");
    expect(
      encodedProjectDirOf("C:\\Users\\k\\.claude\\projects\\D--x-app\\memory\\notes.md"),
    ).toBe("D--x-app");
    expect(encodedProjectDirOf(COPILOT)).toBe(null);
  });
});

describe("backfillScopes", () => {
  it("dry run reports the filing and writes nothing, not even folders", async () => {
    const m = await make();
    const a = await m.save({ content: "distilled fact one" });
    await provenance(a.id, TRANSCRIPT);

    const report = await m.backfillScopes({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.moved).toBe(1);
    expect(report.rows).toBe(0);
    expect(report.perFolder).toEqual({ "projects/memloom": 1 });
    // Nothing was created or moved: no projects folder, memory still uncategorized.
    const paths = (await m.listScopes()).map((s) => s.path).sort();
    expect(paths).toEqual(["global", "uncategorized"]);
    const [row] = await m.memories();
    expect(row?.scopePath).toBe("uncategorized");
  });

  it("files whole lineages, stamps them, and a second run moves nothing", async () => {
    const m = await make();
    const a = await m.save({ content: "distilled fact one" });
    const b = await m.save({ content: "distilled fact from widget" });
    await provenance(a.id, TRANSCRIPT);
    await provenance(b.id, OTHER);
    await m.save({ content: "manually saved, no provenance" });

    const report = await m.backfillScopes();
    expect(report.moved).toBe(2);
    expect(report.rows).toBe(2);
    expect(report.perFolder).toEqual({ "projects/memloom": 1, "projects/widget": 1 });
    expect(report.remaining).toBe(1); // the unprovenanced manual save

    const rows = await m.memories();
    const byContent = new Map(rows.map((r) => [r.content, r]));
    expect(byContent.get("distilled fact one")?.scopePath).toBe("projects > memloom");
    expect(byContent.get("distilled fact from widget")?.scopePath).toBe("projects > widget");
    expect(byContent.get("manually saved, no provenance")?.scopePath).toBe("uncategorized");

    // Stamped, so the classifier never re-reads what mechanics already filed.
    const [stamped] = await storage.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_objects
       WHERE owner_id = $1 AND scope_classified_at IS NOT NULL`,
      [SENTINEL_OWNER],
    );
    expect(Number(stamped?.n)).toBe(2);

    const again = await m.backfillScopes();
    expect(again.moved).toBe(0);
    expect(again.alreadyFiled).toBe(2);
  });

  it("never overrides a hand-filing", async () => {
    const m = await make();
    await m.createScope("personal-life");
    const a = await m.save({ content: "actually a life fact from a session" });
    await provenance(a.id, TRANSCRIPT);
    await m.setMemoryScopes([a.id], "personal-life");

    const report = await m.backfillScopes();
    expect(report.moved).toBe(0);
    expect(report.alreadyFiled).toBe(1);
    const [row] = await m.memories();
    expect(row?.scopePath).toBe("personal-life");
  });

  it("counts provenance without a project as unmappable and leaves it for the classifier", async () => {
    const m = await make();
    const a = await m.save({ content: "a copilot note" });
    await storage.query(
      `INSERT INTO import_provenance (memory_id, owner_id, source, session_id, file_path, start_line, end_line, excerpt)
       VALUES ($1, $2, 'agent-memory', 'copilot', $3, 1, 1, 'excerpt')`,
      [a.id, SENTINEL_OWNER, COPILOT],
    );
    const report = await m.backfillScopes();
    expect(report.moved).toBe(0);
    expect(report.unmappable).toBe(1);
    const [row] = await m.memories();
    expect(row?.scopePath).toBe("uncategorized");
  });
});
