import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
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
      });
    });
  });
}
