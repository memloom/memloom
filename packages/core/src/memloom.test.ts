import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgAdapterFactory, PgliteFactory, type StorageFactory } from "./testkit.js";

// The Phase 1 gate: save -> embed -> vector recall, with identical behaviour on every storage
// adapter. PGLite runs always (in-memory, no Docker). The pg adapter runs too when
// MEMLOOM_TEST_PG_URL points at a Postgres with pgvector.

const factories: StorageFactory[] = [PgliteFactory];
if (process.env.MEMLOOM_TEST_PG_URL)
  factories.push(PgAdapterFactory(process.env.MEMLOOM_TEST_PG_URL));

for (const factory of factories) {
  describe(`spine [${factory.name}]`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()?.();
    });

    async function fresh(): Promise<Memloom> {
      const storage = await factory.open();
      cleanups.push(() => storage.close());
      const memloom = new Memloom({
        storage,
        embedding: new HashingEmbeddingProvider(1024),
        llm: new NullLLMProvider(),
      });
      await memloom.init();
      return memloom;
    }

    it("save returns a uuid id", async () => {
      const m = await fresh();
      const { id } = await m.save({ content: "the staging database is postgres on fly.io" });
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it("init is idempotent", async () => {
      const m = await fresh();
      await expect(m.init()).resolves.toBeUndefined();
    });

    it("recalls the most semantically relevant memory first", async () => {
      const m = await fresh();
      await m.save({ content: "the staging database is postgres running on fly.io" });
      await m.save({ content: "our team stand-up is at 9am every weekday" });
      await m.save({ content: "prefer tabs over spaces in the editor config" });

      const results = await m.recall("what database do we use for staging?");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.content).toContain("staging database");
      expect(results[0]?.similarity).toBeGreaterThan(results[1]?.similarity ?? -1);
    });

    it("returns similarity in [-1, 1]", async () => {
      const m = await fresh();
      await m.save({ content: "vector search uses cosine similarity" });
      const [top] = await m.recall("cosine similarity vector");
      expect(top?.similarity).toBeGreaterThan(0);
      expect(top?.similarity).toBeLessThanOrEqual(1);
    });

    it("respects the limit", async () => {
      const m = await fresh();
      for (let i = 0; i < 5; i++) await m.save({ content: `memory number ${i} about widgets` });
      const results = await m.recall("widgets", { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("excludes stale memories from recall", async () => {
      const m = await fresh();
      const { id } = await m.save({ content: "the api key rotates every 90 days" });
      await m.deps.storage.query("UPDATE memory_objects SET status = 'stale' WHERE id = $1", [id]);
      const results = await m.recall("api key rotation schedule");
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });
  });
}
