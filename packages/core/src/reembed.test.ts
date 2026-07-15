import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, ScriptedLLMProvider } from "./hashing-provider.js";
import { EmbeddingFingerprintError, Memloom, SENTINEL_OWNER } from "./memloom.js";
import { migrate, storedEmbeddingDims } from "./migrate.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { EmbeddingProvider } from "./providers.js";
import type { StorageAdapter } from "./storage.js";
import { toVectorLiteral } from "./vector.js";

// reembed(): the provider-switch migration. A store embedded under one config gets every
// vector recomputed under another, resumably (embedding IS NULL is the cursor, a meta marker
// blocks serving mid-migration), then the fingerprint is restamped.

// Same dims as the hashing provider, provably different vectors: what switching offline to
// cloud looks like, without a network.
function providerB(dims = 1024): EmbeddingProvider {
  const base = new HashingEmbeddingProvider(dims);
  return {
    dims,
    fingerprint: `hashing-b:${dims}`,
    embed: async (texts) => (await base.embed(texts)).map((v) => v.map((x) => -x)),
  };
}

const EMBEDDED_TABLES = [
  "memory_objects",
  "memory_entities",
  "context_chunks",
  "assistant_messages",
] as const;

const extractor = new ScriptedLLMProvider((prompt) => {
  const entities = prompt.slice(prompt.indexOf("TEXT:")).includes("Postgres")
    ? [{ name: "Postgres", type: "technology" }]
    : [];
  return JSON.stringify({ entities, relationships: [] });
});

describe("reembed", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  function engine(storage: StorageAdapter, embedding: EmbeddingProvider, llm = extractor) {
    return new Memloom({ storage, embedding, llm, dedup: false });
  }

  /** A store under provider A with rows in all four embedded tables. */
  async function seeded(): Promise<{ storage: StorageAdapter; a: EmbeddingProvider }> {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const a = new HashingEmbeddingProvider(1024);
    const m = engine(storage, a);
    await m.init();

    await m.save({ content: "the staging database runs on Postgres" });
    await m.save({ content: "the deploy window is friday afternoon" });
    await m.index(); // extracts the Postgres entity

    const dir = mkdtempSync(join(tmpdir(), "memloom-reembed-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "setup.md");
    writeFileSync(file, "# Guide\n## Database\nthe staging database needs pgvector");
    await m.contextAdd({ path: file });

    // The chat path needs a ChatProvider; insert an embedded message row directly.
    const [session] = await storage.query<{ id: string }>(
      "INSERT INTO assistant_sessions (owner_id) VALUES ($1) RETURNING id",
      [SENTINEL_OWNER],
    );
    const [vec] = await a.embed(["what runs the staging database?"]);
    await storage.query(
      `INSERT INTO assistant_messages (owner_id, session_id, role, content, embedding)
       VALUES ($1, $2, 'user', 'what runs the staging database?', $3::vector)`,
      [SENTINEL_OWNER, session?.id, toVectorLiteral(vec ?? [])],
    );
    return { storage, a };
  }

  async function nullCount(storage: StorageAdapter, table: string): Promise<number> {
    const [row] = await storage.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE embedding IS NULL`,
    );
    return row?.n ?? 0;
  }

  it("init({fingerprint:'tolerate'}) opens a mismatched store without restamping it", async () => {
    const { storage } = await seeded();
    await engine(storage, providerB()).init({ fingerprint: "tolerate" });
    const [meta] = await storage.query<{ value: string }>(
      "SELECT value FROM _memloom_meta WHERE key = 'embedding_fingerprint'",
    );
    expect(meta?.value).toBe("hashing:1024");
  });

  it("migrates a store to a new provider: all vectors replaced, fingerprint restamped", async () => {
    const { storage } = await seeded();
    const [before] = await storage.query<{ e: string }>(
      "SELECT embedding::text AS e FROM memory_objects ORDER BY created_at LIMIT 1",
    );

    const b = providerB();
    const m = engine(storage, b);
    await m.init({ fingerprint: "tolerate" });
    const events: Array<{ table: string; done: number; total: number }> = [];
    const result = await m.reembed({ onProgress: (e) => events.push(e) });

    expect(result.outcome).toBe("reembedded");
    expect(result.previousFingerprint).toBe("hashing:1024");
    expect(result.fingerprint).toBe("hashing-b:1024");
    expect(result.counts.memories).toBeGreaterThanOrEqual(2);
    expect(result.counts.entities).toBeGreaterThanOrEqual(1);
    expect(result.counts.chunks).toBeGreaterThanOrEqual(1);
    expect(result.counts.messages).toBe(1);
    for (const table of EMBEDDED_TABLES) expect(await nullCount(storage, table)).toBe(0);
    expect(events.length).toBeGreaterThan(0);

    const [after] = await storage.query<{ e: string }>(
      "SELECT embedding::text AS e FROM memory_objects ORDER BY created_at LIMIT 1",
    );
    expect(after?.e).not.toBe(before?.e);

    // The store now opens under B and refuses A: the migration actually moved it.
    await engine(storage, providerB()).init();
    await expect(engine(storage, new HashingEmbeddingProvider(1024)).init()).rejects.toThrow(
      EmbeddingFingerprintError,
    );
  });

  it("is a no-op when already up to date, unless forced", async () => {
    const { storage, a } = await seeded();
    const m = engine(storage, a);
    await m.init();

    const same = await m.reembed();
    expect(same.outcome).toBe("up-to-date");

    const forced = await m.reembed({ force: true });
    expect(forced.outcome).toBe("reembedded");
    expect(forced.counts.memories).toBeGreaterThanOrEqual(2);
    for (const table of EMBEDDED_TABLES) expect(await nullCount(storage, table)).toBe(0);
  });

  it("resumes after a mid-run provider failure and clears the marker on completion", async () => {
    const { storage } = await seeded();
    const b = providerB();
    let calls = 0;
    const flaky: EmbeddingProvider = {
      dims: b.dims,
      fingerprint: b.fingerprint,
      embed: async (texts) => {
        // First call (the memories page) succeeds, then the provider dies.
        if (calls++ >= 1) throw new Error("provider exploded");
        return b.embed(texts);
      },
    };

    const first = engine(storage, flaky);
    await first.init({ fingerprint: "tolerate" });
    await expect(first.reembed()).rejects.toThrow("provider exploded");

    // Mid-migration: marker set, some vectors still NULL, and a normal init() refuses even
    // under the OLD provider (whose fingerprint still matches the stamp).
    const [marker] = await storage.query<{ value: string }>(
      "SELECT value FROM _memloom_meta WHERE key = 'embedding_migration_target'",
    );
    expect(marker?.value).toBe("hashing-b:1024");
    expect(await nullCount(storage, "memory_entities")).toBeGreaterThan(0);
    await expect(engine(storage, new HashingEmbeddingProvider(1024)).init()).rejects.toThrow(
      /started but not finished/,
    );

    // Rerun with a healthy provider: finishes the remainder without re-wiping what's done.
    const second = engine(storage, b);
    await second.init({ fingerprint: "tolerate" });
    const result = await second.reembed();
    expect(result.outcome).toBe("reembedded");
    expect(result.counts.memories).toBe(0); // the finished page stayed finished
    for (const table of EMBEDDED_TABLES) expect(await nullCount(storage, table)).toBe(0);
    const markers = await storage.query(
      "SELECT value FROM _memloom_meta WHERE key = 'embedding_migration_target'",
    );
    expect(markers).toHaveLength(0);
    await engine(storage, providerB()).init(); // serves again
  });

  it("refuses a provider whose dims don't match the store's columns", async () => {
    const { storage } = await seeded();
    expect(await storedEmbeddingDims(storage)).toBe(1024);

    const m = engine(storage, providerB(512));
    await m.init({ fingerprint: "tolerate" });
    await expect(m.reembed()).rejects.toThrow(/vector\(1024\).*512 dims/s);
  });

  it("storedEmbeddingDims is null on an uninitialized store and set after migrate", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    expect(await storedEmbeddingDims(storage)).toBeNull();
    await migrate(storage, 256);
    expect(await storedEmbeddingDims(storage)).toBe(256);
  });

  it("guard message points at reembed on a plain fingerprint mismatch", async () => {
    const { storage } = await seeded();
    const err = await engine(storage, providerB())
      .init()
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(EmbeddingFingerprintError);
    expect((err as EmbeddingFingerprintError).reembedInProgress).toBe(false);
    expect((err as Error).message).toContain("memloom reembed");
  });
});
