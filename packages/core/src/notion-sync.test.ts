import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteFactory } from "./testkit.js";

// notionSync end-to-end against a fake Notion API: selection, the last_edited_time
// watermark (fresh pages cost zero content fetches), the content-hash short-circuit,
// per-item error isolation, dry runs, and status. The fake serves search, block
// children, and data source queries from a mutable in-memory workspace.

interface FakePage {
  id: string;
  title: string;
  lastEdited: string;
  blocks: Array<Record<string, unknown>>;
  /** Raw Notion parent, e.g. { type: "page_id", id: "p1" }; absent = workspace. */
  parent?: { type: string; id: string };
}

class FakeNotion {
  pages = new Map<string, FakePage>();
  rows = new Map<
    string,
    {
      title: string;
      lastEdited: string;
      rows: Array<Record<string, unknown>>;
      /** The database container this data source belongs to (for parent resolution). */
      parentDatabaseId?: string;
    }
  >();
  /** Database containers: GET /databases/{id} resolves nesting for data sources and rows. */
  databases = new Map<string, { parentPageId: string | null; dataSourceIds: string[] }>();
  /** Children of non-page blocks (nested content, e.g. inside a day-section heading). */
  blockChildren = new Map<string, Array<Record<string, unknown>>>();
  /** Content fetches (block children + data source queries), NOT metadata or search. */
  contentFetches = 0;
  /** The block id of every children request, in order: what incremental sync fetched. */
  childrenFetchLog: string[] = [];
  failFor = new Set<string>();
  /**
   * When set, /search reports THIS last_edited_time for every item: models Notion's
   * eventually-consistent search index lagging behind a real edit.
   */
  staleSearchTime: string | null = null;

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.endsWith("/search")) {
      const results = [
        ...[...this.pages.values()].map((p) => ({
          object: "page",
          id: p.id,
          last_edited_time: this.staleSearchTime ?? p.lastEdited,
          url: `https://notion.so/${p.id}`,
          properties: { Name: { type: "title", title: [{ plain_text: p.title }] } },
          ...(p.parent ? { parent: { type: p.parent.type, [p.parent.type]: p.parent.id } } : {}),
        })),
        ...[...this.rows.entries()].map(([id, ds]) => ({
          object: "data_source",
          id,
          last_edited_time: this.staleSearchTime ?? ds.lastEdited,
          name: ds.title,
          ...(ds.parentDatabaseId
            ? { parent: { type: "database_id", database_id: ds.parentDatabaseId } }
            : {}),
        })),
      ];
      return json({ results, has_more: false, next_cursor: null });
    }

    const dbMeta = /\/databases\/([^/?]+)$/.exec(url);
    if (dbMeta?.[1]) {
      const db = this.databases.get(dbMeta[1]);
      if (!db) return json({ message: "not found" }, 404);
      return json({
        object: "database",
        id: dbMeta[1],
        parent: db.parentPageId
          ? { type: "page_id", page_id: db.parentPageId }
          : { type: "workspace", workspace: true },
        data_sources: db.dataSourceIds.map((id) => ({ id })),
      });
    }

    const children = /\/blocks\/([^/]+)\/children/.exec(url);
    if (children?.[1]) {
      const id = children[1];
      this.contentFetches++;
      this.childrenFetchLog.push(id);
      if (this.failFor.has(id)) return json({ message: "boom" }, 500);
      const blocks = this.pages.get(id)?.blocks ?? this.blockChildren.get(id) ?? [];
      return json({ results: blocks, has_more: false, next_cursor: null });
    }

    const query = /\/data_sources\/([^/]+)\/query/.exec(url);
    if (query?.[1]) {
      this.contentFetches++;
      const ds = this.rows.get(query[1]);
      return json({ results: ds?.rows ?? [], has_more: false, next_cursor: null });
    }

    // Item metadata: the authoritative last_edited_time sync's change detection uses.
    const pageMeta = /\/pages\/([^/?]+)$/.exec(url);
    if (pageMeta?.[1]) {
      const page = this.pages.get(pageMeta[1]);
      if (!page) return json({ message: "not found" }, 404);
      return json({
        object: "page",
        id: page.id,
        last_edited_time: page.lastEdited,
        properties: { Name: { type: "title", title: [{ plain_text: page.title }] } },
      });
    }
    const dsMeta = /\/data_sources\/([^/?]+)$/.exec(url);
    if (dsMeta?.[1]) {
      const ds = this.rows.get(dsMeta[1]);
      if (!ds) return json({ message: "not found" }, 404);
      return json({ object: "data_source", id: dsMeta[1], last_edited_time: ds.lastEdited, name: ds.title });
    }

    void init;
    return json({ message: `unexpected ${url}` }, 404);
  };
}

function paragraph(textContent: string): Record<string, unknown> {
  return {
    id: `b-${textContent.slice(0, 12)}`,
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [{ plain_text: textContent }] },
  };
}

/** A diary-style top-level section: a toggleable heading whose children hold the entries. */
function section(id: string, heading: string, edited: string): Record<string, unknown> {
  return {
    id,
    type: "heading_3",
    has_children: true,
    last_edited_time: edited,
    heading_3: { rich_text: [{ plain_text: heading }], is_toggleable: true },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

beforeEach(() => {
  process.env.NOTION_TOKEN = "ntn_test_token";
  cleanups.push(() => {
    delete process.env.NOTION_TOKEN;
  });
});

async function fresh(fake = new FakeNotion(), fetchImpl?: typeof globalThis.fetch) {
  const storage = await PgliteFactory.open();
  cleanups.push(() => storage.close());
  const memloom = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm: new NullLLMProvider(),
    notionFetch: fetchImpl ?? fake.fetch,
    autoIndexDelayMs: 999_999,
  });
  await memloom.init();
  return { memloom, storage, fake };
}

describe("notion scope", () => {
  it("round-trips and clears", async () => {
    const { memloom } = await fresh();
    expect(await memloom.notionScope()).toBeNull();
    const scope = { items: [{ id: "p1", object: "page" as const, title: "Diary" }] };
    await memloom.setNotionScope(scope);
    expect(await memloom.notionScope()).toEqual(scope);
    await memloom.setNotionScope(null);
    expect(await memloom.notionScope()).toBeNull();
  });
});

describe("notionSync", () => {
  it("refuses without a selection, and without a token", async () => {
    const { memloom } = await fresh();
    await expect(memloom.notionSync()).rejects.toThrow(/notion connect/);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });
    delete process.env.NOTION_TOKEN;
    await expect(memloom.notionSync()).rejects.toThrow(/NOTION_TOKEN/);
  });

  it("syncs a page into a notion:// document, then skips it while unedited", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Personal Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("Finished the UI, now updating the pricing page.")],
    });
    const { memloom, storage } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Personal Diary" }] });

    const first = await memloom.notionSync();
    expect(first).toMatchObject({ added: 1, updated: 0, fresh: 0, errors: 0 });

    const docs = await storage.query<{ path: string; title: string; kind: string }>(
      "SELECT path, title, kind FROM context_documents WHERE path LIKE 'notion://%'",
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ path: "notion://p1", title: "Personal Diary", kind: "notion" });

    const chunks = await storage.query<{ content: string }>(
      "SELECT content FROM context_chunks WHERE document_id = (SELECT id FROM context_documents WHERE path = 'notion://p1')",
    );
    expect(chunks.map((c) => c.content).join("\n")).toContain("pricing page");

    // Unedited: the watermark skips it with zero content fetches.
    const before = fake.contentFetches;
    const second = await memloom.notionSync();
    expect(second).toMatchObject({ fresh: 1, added: 0, updated: 0 });
    expect(fake.contentFetches).toBe(before);
  });

  it("picks up an edit and replaces the document content", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("old entry")],
    });
    const { memloom, storage } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });
    await memloom.notionSync();

    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-21T09:00:00.000Z",
      blocks: [paragraph("old entry"), paragraph("new entry about the launch")],
    });
    const result = await memloom.notionSync();
    expect(result).toMatchObject({ updated: 1, fresh: 0 });

    const chunks = await storage.query<{ content: string }>(
      "SELECT content FROM context_chunks WHERE document_id = (SELECT id FROM context_documents WHERE path = 'notion://p1')",
    );
    expect(chunks.map((c) => c.content).join("\n")).toContain("new entry about the launch");
  });

  it("a bumped last_edited_time with identical content is unchanged, not re-chunked", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("stable entry")],
    });
    const { memloom } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });
    await memloom.notionSync();

    const page = fake.pages.get("p1") as FakePage;
    fake.pages.set("p1", { ...page, lastEdited: "2026-07-21T09:00:00.000Z" });
    const result = await memloom.notionSync();
    expect(result).toMatchObject({ unchanged: 1, updated: 0, added: 0 });
  });

  it("dry run lists work without fetching content or writing", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("entry")],
    });
    const { memloom, storage } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });

    const events: string[] = [];
    const result = await memloom.notionSync({ dryRun: true }, (e) => events.push(e.outcome));
    expect(result.dryRun).toBe(true);
    expect(events).toEqual(["would-sync"]);
    expect(fake.contentFetches).toBe(0);
    const docs = await storage.query("SELECT 1 FROM context_documents");
    expect(docs).toHaveLength(0);
  });

  it("force refetches a fresh page", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("entry")],
    });
    const { memloom } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });
    await memloom.notionSync();
    const result = await memloom.notionSync({ force: true });
    expect(result).toMatchObject({ unchanged: 1, fresh: 0 });
  });

  it("one failing item does not stop the run", async () => {
    const fake = new FakeNotion();
    fake.pages.set("bad", {
      id: "bad",
      title: "Broken",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [],
    });
    fake.pages.set("good", {
      id: "good",
      title: "Fine",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("healthy entry")],
    });
    fake.failFor.add("bad");
    const { memloom } = await fresh(fake);
    await memloom.setNotionScope({
      items: [
        { id: "bad", object: "page", title: "Broken" },
        { id: "good", object: "page", title: "Fine" },
      ],
    });
    const events: string[] = [];
    const result = await memloom.notionSync({}, (e) => events.push(`${e.id}:${e.outcome}`));
    expect(result).toMatchObject({ added: 1, errors: 1 });
    expect(result.error).toContain("500");
    expect(events).toEqual(["bad:fetching", "bad:error", "good:fetching", "good:added"]);

    const status = await memloom.notionStatus();
    expect(status.lastSyncError).toContain("500");
    expect(status.documents).toBe(1);
  });

  it("reports truncation when a page exceeds the block cap, never silently", async () => {
    const fake = new FakeNotion();
    fake.pages.set("big", {
      id: "big",
      title: "Huge Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: Array.from({ length: 20_050 }, (_, i) => paragraph(`entry ${i}`)),
    });
    const { memloom } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "big", object: "page", title: "Huge Diary" }] });
    const events: Array<{ outcome: string; truncated?: boolean }> = [];
    const result = await memloom.notionSync({}, (e) =>
      events.push({ outcome: e.outcome, truncated: e.truncated }),
    );
    expect(result).toMatchObject({ added: 1, truncated: 1 });
    expect(events.find((e) => e.outcome === "added")?.truncated).toBe(true);
  }, 30_000);

  it("refuses a second sync while one is running", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("entry")],
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated: typeof globalThis.fetch = async (input, init) => {
      if (String(input).includes("/blocks/")) await gate;
      return fake.fetch(input, init);
    };
    const { memloom } = await fresh(fake, gated);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });

    const first = memloom.notionSync();
    await new Promise((r) => setTimeout(r, 25));
    await expect(memloom.notionSync()).rejects.toThrow(/already running/);
    release();
    await expect(first).resolves.toMatchObject({ added: 1 });
    // The lock releases: a follow-up sync runs normally.
    await expect(memloom.notionSync()).resolves.toMatchObject({ fresh: 1 });
  });

  it("detects an edit even when Notion's search index is stale", async () => {
    // The real-world miss: the user edits, but search (eventually consistent) still
    // reports the old last_edited_time. Change detection must not depend on search.
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-22T15:00:00.000Z",
      blocks: [paragraph("old entry")],
    });
    const { memloom, storage } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });
    await memloom.notionSync();

    // The edit lands on the page; the search index still shows the pre-edit time.
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-22T17:40:00.000Z",
      blocks: [paragraph("old entry"), paragraph("the new important context")],
    });
    fake.staleSearchTime = "2026-07-22T15:00:00.000Z";

    const result = await memloom.notionSync();
    expect(result).toMatchObject({ updated: 1, fresh: 0 });
    const chunks = await storage.query<{ content: string }>(
      "SELECT content FROM context_chunks WHERE document_id = (SELECT id FROM context_documents WHERE path = 'notion://p1')",
    );
    expect(chunks.map((c) => c.content).join("\n")).toContain("the new important context");
  });

  it("wait: true queues a manual sync behind the in-flight one instead of refusing", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("entry")],
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated: typeof globalThis.fetch = async (input, init) => {
      if (String(input).includes("/blocks/")) await gate;
      return fake.fetch(input, init);
    };
    const { memloom } = await fresh(fake, gated);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });

    const first = memloom.notionSync();
    await new Promise((r) => setTimeout(r, 25));
    const events: string[] = [];
    const queued = memloom.notionSync({ force: true, wait: true }, (e) => events.push(e.outcome));
    await new Promise((r) => setTimeout(r, 25));
    expect(events).toEqual(["waiting"]); // queued, not refused
    release();
    await expect(first).resolves.toMatchObject({ added: 1 });
    // The queued force run executes after: it refetches and finds the content unchanged.
    await expect(queued).resolves.toMatchObject({ unchanged: 1 });
    const status = await memloom.notionStatus();
    expect(status.syncing).toBe(false);
  });

  it("syncs a data source as one document of titled row sections", async () => {
    const fake = new FakeNotion();
    fake.rows.set("ds1", {
      title: "Reading list",
      lastEdited: "2026-07-20T10:00:00.000Z",
      rows: [
        {
          properties: {
            Name: { type: "title", title: [{ plain_text: "The Idea Factory" }] },
            Status: { type: "status", status: { name: "Reading" } },
          },
        },
      ],
    });
    const { memloom, storage } = await fresh(fake);
    await memloom.setNotionScope({
      items: [{ id: "ds1", object: "data_source", title: "Reading list" }],
    });
    const result = await memloom.notionSync();
    expect(result).toMatchObject({ added: 1 });
    const chunks = await storage.query<{ content: string }>(
      "SELECT content FROM context_chunks WHERE document_id = (SELECT id FROM context_documents WHERE path = 'notion://ds1')",
    );
    const all = chunks.map((c) => c.content).join("\n");
    expect(all).toContain("The Idea Factory");
    expect(all).toContain("Status: Reading");
  });

  it("status reports token, sync time, and totals", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", {
      id: "p1",
      title: "Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [paragraph("entry")],
    });
    const { memloom } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "p1", object: "page", title: "Diary" }] });
    await memloom.notionSync();
    const status = await memloom.notionStatus();
    expect(status.tokenPresent).toBe(true);
    expect(status.lastSyncAt).toBeTruthy();
    expect(status.lastSyncError).toBeNull();
    expect(status.documents).toBe(1);
    expect(status.chunks).toBeGreaterThan(0);
    expect(status.scope?.items).toHaveLength(1);
  });
});

// Incremental sync: after the first full fetch the block tree is cached; later syncs
// list only the page's top level and refetch just the sections whose last_edited_time
// moved (Notion bumps every ancestor when a nested block changes). A page-level edit
// that no section accounts for falls back to a full fetch.
describe("incremental sync", () => {
  function diaryFixture(): FakeNotion {
    const fake = new FakeNotion();
    fake.pages.set("diary", {
      id: "diary",
      title: "Personal Diary",
      lastEdited: "2026-07-20T10:00:00.000Z",
      blocks: [
        section("s1", "July 18, 2026", "2026-07-18T21:00:00.000Z"),
        section("s2", "July 19, 2026", "2026-07-19T22:00:00.000Z"),
        section("s3", "July 20, 2026", "2026-07-20T10:00:00.000Z"),
      ],
    });
    fake.blockChildren.set("s1", [paragraph("walked in the park")]);
    fake.blockChildren.set("s2", [paragraph("shipped the connector")]);
    fake.blockChildren.set("s3", [paragraph("wrote the changelog")]);
    return fake;
  }

  async function diaryContent(storage: Awaited<ReturnType<typeof PgliteFactory.open>>) {
    const chunks = await storage.query<{ content: string }>(
      "SELECT content FROM context_chunks WHERE document_id = (SELECT id FROM context_documents WHERE path = 'notion://diary')",
    );
    return chunks.map((c) => c.content).join("\n");
  }

  it("refetches only the sections whose timestamps moved", async () => {
    const fake = diaryFixture();
    const { memloom, storage } = await fresh(fake);
    await memloom.setNotionScope({
      items: [{ id: "diary", object: "page", title: "Personal Diary" }],
    });
    await memloom.notionSync(); // full fetch, builds the cache

    // An edit inside July 19: the section's own timestamp moves, the others' do not.
    fake.blockChildren.set("s2", [
      paragraph("shipped the connector"),
      paragraph("then fixed the sync race"),
    ]);
    const page = fake.pages.get("diary") as FakePage;
    page.blocks[1] = section("s2", "July 19, 2026", "2026-07-21T08:00:00.000Z");
    page.lastEdited = "2026-07-21T08:00:00.000Z";

    fake.childrenFetchLog = [];
    const events: Array<{ outcome: string; refetched?: number; sections?: number }> = [];
    const result = await memloom.notionSync({}, (e) =>
      events.push({ outcome: e.outcome, refetched: e.refetched, sections: e.sections }),
    );
    expect(result).toMatchObject({ updated: 1 });
    // One top-level listing plus the one changed section; unchanged sections untouched.
    expect(fake.childrenFetchLog).toEqual(["diary", "s2"]);
    const done = events.find((e) => e.outcome === "updated");
    expect(done?.refetched).toBe(1);
    expect(done?.sections).toBe(3);

    const all = await diaryContent(storage);
    expect(all).toContain("then fixed the sync race");
    expect(all).toContain("walked in the park"); // unchanged section served from cache
  });

  it("fetches a brand new section without touching the others", async () => {
    const fake = diaryFixture();
    const { memloom, storage } = await fresh(fake);
    await memloom.setNotionScope({
      items: [{ id: "diary", object: "page", title: "Personal Diary" }],
    });
    await memloom.notionSync();

    const page = fake.pages.get("diary") as FakePage;
    page.blocks.push(section("s4", "July 21, 2026", "2026-07-21T09:00:00.000Z"));
    fake.blockChildren.set("s4", [paragraph("started the incremental fetch")]);
    page.lastEdited = "2026-07-21T09:00:00.000Z";

    fake.childrenFetchLog = [];
    const result = await memloom.notionSync();
    expect(result).toMatchObject({ updated: 1 });
    expect(fake.childrenFetchLog).toEqual(["diary", "s4"]);
    const all = await diaryContent(storage);
    expect(all).toContain("started the incremental fetch");
    expect(all).toContain("shipped the connector");
  });

  it("a deleted section disappears via the full-fetch fallback", async () => {
    const fake = diaryFixture();
    const { memloom, storage } = await fresh(fake);
    await memloom.setNotionScope({
      items: [{ id: "diary", object: "page", title: "Personal Diary" }],
    });
    await memloom.notionSync();

    const page = fake.pages.get("diary") as FakePage;
    page.blocks = page.blocks.filter((b) => b.id !== "s3");
    page.lastEdited = "2026-07-21T10:00:00.000Z";

    const result = await memloom.notionSync();
    expect(result).toMatchObject({ updated: 1 });
    const all = await diaryContent(storage);
    expect(all).not.toContain("wrote the changelog");
    expect(all).toContain("walked in the park");
  });

  it("falls back to a full fetch when the page changed but no section did", async () => {
    const fake = diaryFixture();
    const { memloom } = await fresh(fake);
    await memloom.setNotionScope({
      items: [{ id: "diary", object: "page", title: "Personal Diary" }],
    });
    await memloom.notionSync();

    // A property-only edit: the page timestamp moves, no block does.
    (fake.pages.get("diary") as FakePage).lastEdited = "2026-07-21T11:00:00.000Z";

    fake.childrenFetchLog = [];
    const events: Array<{ outcome: string; refetched?: number }> = [];
    const result = await memloom.notionSync({}, (e) =>
      events.push({ outcome: e.outcome, refetched: e.refetched }),
    );
    expect(result).toMatchObject({ unchanged: 1 });
    // The top-level diff found nothing, so everything was refetched to be safe.
    expect(fake.childrenFetchLog).toContain("s1");
    expect(fake.childrenFetchLog).toContain("s3");
    expect(events.find((e) => e.outcome === "unchanged")?.refetched).toBeUndefined();
  });

  it("force bypasses the cache and refetches every section", async () => {
    const fake = diaryFixture();
    const { memloom } = await fresh(fake);
    await memloom.setNotionScope({
      items: [{ id: "diary", object: "page", title: "Personal Diary" }],
    });
    await memloom.notionSync();

    fake.childrenFetchLog = [];
    const result = await memloom.notionSync({ force: true });
    expect(result).toMatchObject({ unchanged: 1 });
    expect(fake.childrenFetchLog).toEqual(["diary", "s1", "s2", "s3"]);
  });
});

describe("notionListPages", () => {
  it("lists everything visible, marking the selection", async () => {
    const fake = new FakeNotion();
    fake.pages.set("p1", { id: "p1", title: "Diary", lastEdited: "2026-07-20T10:00:00.000Z", blocks: [] });
    fake.pages.set("p2", { id: "p2", title: "Work Notes", lastEdited: "2026-07-19T10:00:00.000Z", blocks: [] });
    const { memloom } = await fresh(fake);
    await memloom.setNotionScope({ items: [{ id: "p2", object: "page", title: "Work Notes" }] });
    const listing = await memloom.notionListPages();
    expect(listing).toHaveLength(2);
    expect(listing.find((i) => i.id === "p1")?.selected).toBe(false);
    expect(listing.find((i) => i.id === "p2")?.selected).toBe(true);
  });

  it("resolves the hierarchy: subpages, databases under their page, rows marked", async () => {
    // Rome trip page > Expenses database (rows r1, r2) plus a plain subpage.
    const fake = new FakeNotion();
    fake.pages.set("trip", { id: "trip", title: "Rome trip", lastEdited: "2026-07-23T09:00:00.000Z", blocks: [] });
    fake.pages.set("sub", {
      id: "sub",
      title: "Packing list",
      lastEdited: "2026-07-22T09:00:00.000Z",
      blocks: [],
      parent: { type: "page_id", id: "trip" },
    });
    fake.databases.set("db1", { parentPageId: "trip", dataSourceIds: ["expenses"] });
    fake.rows.set("expenses", {
      title: "Expenses",
      lastEdited: "2026-07-03T10:00:00.000Z",
      rows: [],
      parentDatabaseId: "db1",
    });
    fake.pages.set("r1", {
      id: "r1",
      title: "Train to Warsaw",
      lastEdited: "2026-07-03T10:00:00.000Z",
      blocks: [],
      parent: { type: "data_source_id", id: "expenses" },
    });
    fake.pages.set("r2", {
      id: "r2",
      title: "Hostel Rome",
      lastEdited: "2026-07-03T10:00:00.000Z",
      blocks: [],
      parent: { type: "database_id", id: "db1" },
    });
    const { memloom } = await fresh(fake);
    const listing = await memloom.notionListPages();

    const by = (id: string) => listing.find((i) => i.id === id);
    expect(by("trip")).toMatchObject({ parentId: null, parentType: null });
    expect(by("sub")).toMatchObject({ parentId: "trip", parentType: "page" });
    // The data source nests under the page holding its database container.
    expect(by("expenses")).toMatchObject({ parentId: "trip", parentType: "page" });
    // Rows point at the listed data source whether Notion reports the data source
    // directly or the database container.
    expect(by("r1")).toMatchObject({ parentId: "expenses", parentType: "data_source" });
    expect(by("r2")).toMatchObject({ parentId: "expenses", parentType: "data_source" });
  });
});
