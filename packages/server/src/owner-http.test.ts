import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageAdapter } from "@memloom/core";
import {
  HashingEmbeddingProvider,
  HttpMemloomClient,
  Memloom,
  NullLLMProvider,
  OWNER_HEADER,
  PgliteAdapter,
  SENTINEL_OWNER,
  truncateAll,
} from "@memloom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./index.js";

// Owner isolation over the wire. The engine's own isolation is covered in core; what is under
// test here is the seam that used to lose it: the daemon accepted an owner on /memory/save and
// on nothing else, so a host could write per user and then read everyone's memories back. That
// is worse than not separating at all, because it looks separated.

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

let storage: StorageAdapter;
let previousHome: string | undefined;
let fakeHome: string;

beforeAll(async () => {
  storage = await PgliteAdapter.open();
  // The ingest queue persists under MEMLOOM_HOME; keep it out of the developer's real one.
  fakeHome = mkdtempSync(join(tmpdir(), "memloom-owner-http-"));
  previousHome = process.env.MEMLOOM_HOME;
  process.env.MEMLOOM_HOME = fakeHome;
});
afterAll(async () => {
  await storage.close();
  if (previousHome === undefined) delete process.env.MEMLOOM_HOME;
  else process.env.MEMLOOM_HOME = previousHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("owner isolation over HTTP", () => {
  async function daemon() {
    await truncateAll(storage);
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
    });
    await memloom.init();
    return { memloom, app: createServer(memloom) };
  }

  /** A client bound to one owner, talking to the app through Hono's request helper. */
  function clientFor(app: ReturnType<typeof createServer>, ownerId?: string) {
    return new HttpMemloomClient("", (url, init) => app.request(url, init) as never, ownerId);
  }

  it("reads are owner-scoped, not just writes", async () => {
    const { app } = await daemon();
    const anna = clientFor(app, OWNER_A);
    const boris = clientFor(app, OWNER_B);

    await anna.save({ content: "Anna was born on the 3rd of March" });
    await boris.save({ content: "Boris was born on the 9th of September" });

    // recall and list are the two that used to answer for the sentinel no matter who asked.
    expect((await anna.recall("when was this person born?")).map((m) => m.content)).toEqual([
      "Anna was born on the 3rd of March",
    ]);
    expect((await boris.memories()).map((m) => m.content)).toEqual([
      "Boris was born on the 9th of September",
    ]);

    // And a client that names no owner is a third tenant, not a view of everyone.
    expect(await clientFor(app).memories()).toEqual([]);
  });

  it("a memory cannot be read or deleted through another owner's connection", async () => {
    const { app } = await daemon();
    const anna = clientFor(app, OWNER_A);
    const boris = clientFor(app, OWNER_B);

    const { id } = await anna.save({ content: "Anna's cat is called Mruczek" });

    expect(await boris.passage(id)).toBeNull();
    await expect(boris.history(id)).rejects.toThrow();
    await expect(boris.deleteMemory(id)).rejects.toThrow();
    expect((await anna.memories()).length).toBe(1);

    await anna.deleteMemory(id);
    expect(await anna.memories()).toEqual([]);
  });

  it("one owner cannot resolve another's conflict", async () => {
    const { memloom, app } = await daemon();
    // Written directly: producing a real contradiction needs a classifier, and what is under
    // test is which owner the resolve route will act for, not how conflicts arise.
    const [row] = await storage.query<{ id: string }>(
      `INSERT INTO memory_dedup_decisions (owner_id, action, incoming_content, candidates)
       VALUES ($1, 'conflict', 'Anna is moving to Kraków', '[]'::jsonb) RETURNING id`,
      [OWNER_A],
    );
    const conflictId = row?.id;
    if (!conflictId) throw new Error("could not stage a conflict");

    const refused = await app.request(`/memory/conflicts/${conflictId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_HEADER]: OWNER_B },
      body: JSON.stringify({ action: "keep_new" }),
    });
    expect(refused.status).toBe(404);
    // Refused, not merely reported: the row is still Anna's to decide.
    expect((await memloom.conflicts(OWNER_A)).length).toBe(1);
  });

  it("refuses an owner header that is not a uuid instead of falling back to the sentinel", async () => {
    const { app } = await daemon();
    const res = await app.request("/memory/list", { headers: { [OWNER_HEADER]: "user_42" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/expected a uuid/);
  });

  it("refuses a body owner that disagrees with the header", async () => {
    const { app } = await daemon();
    const res = await app.request("/memory/save", {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_HEADER]: OWNER_A },
      body: JSON.stringify({ content: "whose is this?", ownerId: OWNER_B }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/owner mismatch/);
  });

  it("a client bound to one owner refuses to act for another", async () => {
    const { app } = await daemon();
    const anna = clientFor(app, OWNER_A);
    // The engine contract carries a per-call ownerId. Serving Anna's memories to a caller who
    // asked for Boris would be the silent version of exactly what this file tests.
    await expect(anna.memories(OWNER_B)).rejects.toThrow(/bound to owner/);
  });

  it("no header is the sentinel, so a single-owner install is untouched", async () => {
    const { memloom, app } = await daemon();
    const plain = clientFor(app);
    await plain.save({ content: "the only person here" });

    expect((await memloom.memories(SENTINEL_OWNER)).map((m) => m.content)).toEqual([
      "the only person here",
    ]);
    expect((await plain.memories()).length).toBe(1);
  });

  it("owners() reports every tenant holding anything, for the background passes", async () => {
    const { memloom, app } = await daemon();
    await clientFor(app, OWNER_A).save({ content: "Anna reads tarot on Sunday evenings" });
    await clientFor(app, OWNER_B).save({ content: "Boris asks about his career" });

    expect(await memloom.owners()).toEqual([OWNER_A, OWNER_B]);
  });

  // The Console is served BY the daemon and cannot send a header of its own. Without a daemon
  // default it would ask for nobody, get the sentinel, and show an empty store to someone whose
  // CLI and agent are saving memories under a real id, with no error to explain it.
  it("a headerless caller gets the daemon's default owner, which is what the Console is", async () => {
    await truncateAll(storage);
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
    });
    await memloom.init();
    const app = createServer(memloom, { defaultOwnerId: OWNER_A });

    // The agent, naming its owner explicitly, exactly as MCP does.
    await clientFor(app, OWNER_A).save({ content: "Anna prefers short readings" });

    // The Console, naming nobody.
    const res = await app.request("/memory/list");
    expect(res.status).toBe(200);
    const { memories } = (await res.json()) as { memories: { content: string }[] };
    expect(memories.map((m) => m.content)).toEqual(["Anna prefers short readings"]);

    // And it is inspectable rather than guessed at from an empty list.
    expect(((await (await app.request("/health")).json()) as { owner: string }).owner).toBe(
      OWNER_A,
    );
  });

  it("still defaults to the sentinel when no owner is configured", async () => {
    const { app } = await daemon();
    expect(((await (await app.request("/health")).json()) as { owner: string }).owner).toBe(
      SENTINEL_OWNER,
    );
  });
});
