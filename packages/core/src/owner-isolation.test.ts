import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HashingEmbeddingProvider,
  NullLLMProvider,
  ScriptedLLMProvider,
} from "./hashing-provider.js";
import { Memloom, SENTINEL_OWNER } from "./memloom.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";
import { PgAdapterFactory, PgliteFactory, type StorageFactory } from "./testkit.js";

// Multi-tenant isolation: one store, many owners. The embedded tier has a single sentinel
// owner, so nothing there ever proves that owner_id actually gates reads and writes — but a
// host app that hands each of its users an owner id (a chatbot, a team server) is betting
// its users' privacy on exactly that. These tests are that bet, written down.
//
// dedup is ON with a NullLLMProvider on purpose: the classifier throws the moment it is
// called, so a candidate query that reaches across owners fails loudly here instead of
// quietly merging one user's belief into another's.

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

const factories: StorageFactory[] = [PgliteFactory];
if (process.env.MEMLOOM_TEST_PG_URL)
  factories.push(PgAdapterFactory(process.env.MEMLOOM_TEST_PG_URL));

for (const factory of factories) {
  describe(`owner isolation [${factory.name}]`, () => {
    let storage: StorageAdapter;
    let fixtureDoc: string;
    let fixtureDir: string;

    beforeAll(async () => {
      storage = await factory.open();
      fixtureDir = mkdtempSync(join(tmpdir(), "memloom-owner-"));
      fixtureDoc = join(fixtureDir, "reading-notes.md");
      writeFileSync(fixtureDoc, "The Tower reversed reads as an upheaval already survived.");
    });
    afterAll(async () => {
      await storage.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    async function fresh(): Promise<Memloom> {
      await truncateAll(storage);
      const memloom = new Memloom({
        storage,
        embedding: new HashingEmbeddingProvider(1024),
        llm: new NullLLMProvider(),
      });
      await memloom.init();
      return memloom;
    }

    it("recall never crosses owners, and the sentinel owner sees neither", async () => {
      const m = await fresh();
      await m.save({ content: "Anna was born on the 3rd of March", ownerId: OWNER_A });
      await m.save({ content: "Boris was born on the 9th of September", ownerId: OWNER_B });

      const a = await m.recall("when was this person born?", { ownerId: OWNER_A });
      const b = await m.recall("when was this person born?", { ownerId: OWNER_B });
      const sentinel = await m.recall("when was this person born?");

      expect(a.map((r) => r.content)).toEqual(["Anna was born on the 3rd of March"]);
      expect(b.map((r) => r.content)).toEqual(["Boris was born on the 9th of September"]);
      // The default owner is a third tenant, not a superuser view.
      expect(sentinel).toEqual([]);
    });

    it("listing memories is owner-scoped", async () => {
      const m = await fresh();
      await m.save({ content: "Anna prefers short readings", ownerId: OWNER_A });
      await m.save({ content: "Boris prefers long readings", ownerId: OWNER_B });

      expect((await m.memories(OWNER_A)).map((x) => x.content)).toEqual([
        "Anna prefers short readings",
      ]);
      expect((await m.memories(OWNER_B)).map((x) => x.content)).toEqual([
        "Boris prefers long readings",
      ]);
      expect(await m.memories()).toEqual([]);
    });

    it("the belief pipeline does not dedup, version, or conflict across owners", async () => {
      const m = await fresh();
      const same = "the querent is changing jobs this spring";

      const first = await m.save({ content: same, ownerId: OWNER_A });
      // Byte-identical content under a different owner: the content-hash short-circuit must
      // not fire, and the vector candidate query must return nothing (NullLLM would throw).
      const second = await m.save({ content: same, ownerId: OWNER_B });

      expect(first.outcome).toBe("added");
      expect(second.outcome).toBe("added");
      expect(second.id).not.toBe(first.id);
      expect((await m.memories(OWNER_A)).length).toBe(1);
      expect((await m.memories(OWNER_B)).length).toBe(1);
    });

    it("a memory cannot be read, versioned, or deleted through the wrong owner", async () => {
      const m = await fresh();
      const { id } = await m.save({ content: "Anna's cat is called Mruczek", ownerId: OWNER_A });

      expect(await m.passage(id, OWNER_B)).toBeNull();
      // Same error the id would raise if it did not exist at all: no existence leak either.
      await expect(m.history(id, OWNER_B)).rejects.toThrow(/no memory/);
      await expect(m.deleteMemory(id, OWNER_B)).rejects.toThrow(/no memory/);
      expect((await m.memories(OWNER_A)).length).toBe(1);

      // The rightful owner still can.
      await m.deleteMemory(id, OWNER_A);
      expect(await m.memories(OWNER_A)).toEqual([]);
    });

    describe("deleteOwner", () => {
      // Discovered, not listed: the same rule deleteOwner itself follows. If someone adds a
      // table with an owner_id and forgets the purge, this test finds the surviving rows.
      async function rowsFor(owner: string): Promise<Record<string, number>> {
        const tables = await storage.query<{ name: string }>(
          `SELECT c.relname AS name
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'owner_id'
                                AND NOT a.attisdropped
            WHERE c.relkind = 'r'`,
        );
        const out: Record<string, number> = {};
        for (const { name } of tables) {
          const rows = await storage.query<{ n: string }>(
            `SELECT count(*) AS n FROM "${name}" WHERE owner_id = $1`,
            [owner],
          );
          const n = Number(rows[0]?.n ?? 0);
          if (n > 0) out[name] = n;
        }
        return out;
      }

      it("erases every table for one owner and leaves the other untouched", async () => {
        const m = await fresh();
        for (const content of [
          "Anna reads tarot on Sunday evenings",
          "Anna is moving to Kraków in the autumn",
        ]) {
          await m.save({ content, ownerId: OWNER_A });
        }
        await m.save({ content: "Boris asks about his career", ownerId: OWNER_B });

        // Something in more than one table, so the purge has more than memory_objects to find.
        await m.contextAdd({ path: fixtureDoc, ownerId: OWNER_A });
        await m.contextAdd({ path: fixtureDoc, ownerId: OWNER_B });

        const before = await rowsFor(OWNER_A);
        expect(Object.keys(before).length).toBeGreaterThan(1);
        const borisBefore = await rowsFor(OWNER_B);

        const result = await m.deleteOwner(OWNER_A);

        expect(result.rows).toBeGreaterThan(0);
        expect(await rowsFor(OWNER_A)).toEqual({});
        expect(await rowsFor(OWNER_B)).toEqual(borisBefore);
        expect((await m.memories(OWNER_B)).length).toBe(1);
        expect((await m.contextList(OWNER_B)).length).toBe(1);
      });

      it("is a no-op for an owner that holds nothing", async () => {
        const m = await fresh();
        await m.save({ content: "Boris asks about his career", ownerId: OWNER_B });
        expect(await m.deleteOwner(OWNER_A)).toEqual({ rows: 0, tables: {} });
        expect((await m.memories(OWNER_B)).length).toBe(1);
      });

      it("refuses anything that is not a uuid", async () => {
        const m = await fresh();
        await expect(m.deleteOwner("")).rejects.toThrow(/uuid owner id/);
        await expect(m.deleteOwner("anna@example.com")).rejects.toThrow(/uuid owner id/);
      });
    });

    describe("forOwner", () => {
      it("binds the owner so no call site can forget it", async () => {
        const m = await fresh();
        const anna = m.forOwner(OWNER_A);
        const boris = m.forOwner(OWNER_B);

        await anna.save({ content: "Anna was born on the 3rd of March" });
        await boris.save({ content: "Boris was born on the 9th of September" });

        expect((await anna.recall("birthday")).map((r) => r.content)).toEqual([
          "Anna was born on the 3rd of March",
        ]);
        expect((await boris.memories()).map((r) => r.content)).toEqual([
          "Boris was born on the 9th of September",
        ]);
        // And nothing leaked to the shared default owner.
        expect(await m.memories()).toEqual([]);
      });

      it("erase() removes only its own tenant", async () => {
        const m = await fresh();
        const anna = m.forOwner(OWNER_A);
        const boris = m.forOwner(OWNER_B);
        await anna.save({ content: "Anna reads tarot on Sunday evenings" });
        await boris.save({ content: "Boris asks about his career" });

        const result = await anna.erase();

        expect(result.rows).toBeGreaterThan(0);
        expect(await anna.memories()).toEqual([]);
        expect((await boris.memories()).length).toBe(1);
      });

      it("rejects the sentinel owner, which is what a missing user id looks like", async () => {
        const m = await fresh();
        expect(() => m.forOwner(SENTINEL_OWNER)).toThrow(/sentinel owner/);
        expect(() => m.forOwner("")).toThrow(/uuid owner id/);
        expect(() => m.forOwner("user_42")).toThrow(/uuid owner id/);
        // The literal missing user id, from a host without types. It has to reach the same
        // message, not a TypeError about toLowerCase from inside the guard meant to catch it.
        expect(() => m.forOwner(undefined as unknown as string)).toThrow(/uuid owner id/);
        await expect(m.deleteOwner(undefined as unknown as string)).rejects.toThrow(
          /uuid owner id/,
        );
      });

      // resolveConflict is the one engine method that takes no ownerId — it reads the owner
      // off the conflict row and acts on whoever that turns out to be. Fine for one person
      // and their own store; a cross-owner write for anybody else. The handle has to check.
      it("one owner cannot resolve another's conflict, and can resolve their own", async () => {
        await truncateAll(storage);
        const m = new Memloom({
          storage,
          embedding: new HashingEmbeddingProvider(1024),
          // Force the contradiction that a real classifier would find here.
          llm: new ScriptedLLMProvider(() =>
            JSON.stringify([{ candidate: 1, relation: "contradictory", reason: "same subject" }]),
          ),
        });
        await m.init();

        const anna = m.forOwner(OWNER_A);
        const boris = m.forOwner(OWNER_B);

        await anna.save({ content: "Anna is moving to Kraków in the autumn" });
        const clash = await anna.save({ content: "Anna is moving to Gdańsk in the autumn" });

        expect(clash.outcome).toBe("conflict");
        const conflictId = clash.conflictId;
        if (!conflictId) throw new Error("expected a pending conflict to resolve");

        await expect(boris.resolveConflict(conflictId, { action: "keep_new" })).rejects.toThrow(
          /no conflict/,
        );
        expect((await anna.conflicts()).length).toBe(1);

        await anna.resolveConflict(conflictId, { action: "keep_new" });
        expect(await anna.conflicts()).toEqual([]);
      });

      // resolveConflict() serves two queues: an id whose action is entity_merge is
      // re-dispatched to the entity fold path. A guard that consults only the memory queue
      // therefore refuses an owner their OWN entity conflicts — it reads as ownership
      // enforcement while quietly removing a feature. The row is written directly because
      // producing a real fold needs the indexer and an arbiter; what is under test is which
      // queues the guard looks in, not how folds arise.
      it("the ownership guard covers entity folds, not just memory conflicts", async () => {
        await truncateAll(storage);
        const m = new Memloom({
          storage,
          embedding: new HashingEmbeddingProvider(1024),
          llm: new NullLLMProvider(),
        });
        await m.init();

        const [row] = await storage.query<{ id: string }>(
          `INSERT INTO memory_dedup_decisions (owner_id, action, incoming_content, candidates)
           VALUES ($1, 'entity_merge', 'Kraków', '[]'::jsonb) RETURNING id`,
          [OWNER_A],
        );
        const foldId = row?.id;
        if (!foldId) throw new Error("could not stage an entity decision");

        // Anna can find the fold through the handle, before anything resolves it. The guard
        // accepts entity ids, so without a listing the only way to be holding one is to have
        // gone around the handle in the first place.
        expect((await m.forOwner(OWNER_A).entityConflicts()).map((c) => c.id)).toContain(foldId);
        expect(await m.forOwner(OWNER_B).entityConflicts()).toEqual([]);

        // Anna's, so Boris is refused.
        await expect(
          m.forOwner(OWNER_B).resolveConflict(foldId, { action: "keep_both" }),
        ).rejects.toThrow(/no conflict/);

        // Anna gets past the guard and into the entity path. It fails further in on a fold
        // with no real entities behind it — any error EXCEPT "no conflict" proves the guard
        // recognised the id, which is the thing this test is about.
        await m
          .forOwner(OWNER_A)
          .resolveConflict(foldId, { action: "keep_both" })
          .then(
            () => undefined,
            (err: unknown) => {
              expect(String(err)).not.toMatch(/no conflict/);
            },
          );
      });
    });

    // Auto-index is debounced on one engine-wide timer. With a single owner that is just a
    // burst collapsing into one run; with two, the newer write cancelled the older owner's
    // run and nothing rescheduled it, so that owner's memories were never indexed at all —
    // no entities, no graph, weaker recall, and nothing anywhere saying so.
    describe("auto-index across owners", () => {
      it("indexes every owner that wrote, not just the last one", async () => {
        await truncateAll(storage);
        const m = new Memloom({
          storage,
          embedding: new HashingEmbeddingProvider(1024),
          llm: new ScriptedLLMProvider(() => JSON.stringify([])),
          autoIndex: true,
          autoIndexDelayMs: 20,
        });
        await m.init();

        await m.save({ content: "Anna reads tarot on Sunday evenings", ownerId: OWNER_A });
        await m.save({ content: "Boris asks about his career", ownerId: OWNER_B });

        await vi.waitFor(
          async () => {
            expect((await m.listIndexRuns(OWNER_A)).length).toBeGreaterThan(0);
            expect((await m.listIndexRuns(OWNER_B)).length).toBeGreaterThan(0);
          },
          { timeout: 10_000, interval: 50 },
        );
      });

      it("drops a queued run for an owner that was erased", async () => {
        await truncateAll(storage);
        const m = new Memloom({
          storage,
          embedding: new HashingEmbeddingProvider(1024),
          llm: new ScriptedLLMProvider(() => JSON.stringify([])),
          // Long enough that the queued run is still waiting when the erase lands.
          autoIndexDelayMs: 10_000,
          autoIndex: true,
        });
        await m.init();

        await m.save({ content: "Anna reads tarot on Sunday evenings", ownerId: OWNER_A });
        await m.deleteOwner(OWNER_A);

        // Nothing queued brings the tenant back after they asked to be gone.
        expect(await m.listIndexRuns(OWNER_A)).toEqual([]);
        expect(await m.memories(OWNER_A)).toEqual([]);
      });
    });
  });
}
