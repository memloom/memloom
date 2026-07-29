import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";

// End to end for the link path: URL -> fetch -> defuddle -> chunkMarkdown -> embed -> store
// -> hybrid recall, with the citation pointing back at the page. Same shape as
// context.test.ts, with global fetch stubbed so no test ever touches the network.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "pages");
const page = (name: string) => readFileSync(join(FIXTURES, `${name}.html`), "utf8");

describe("context connector: web links", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(256),
      llm: new NullLLMProvider(),
      dedup: false,
    });
    await memloom.init();
    return { memloom };
  }

  function serve(html: string) {
    vi.stubGlobal("fetch", async () => new Response(html, { headers: { "content-type": "text/html" } }));
  }

  it("ingests a page and recalls it with the URL as the source", async () => {
    const { memloom } = await fresh();
    serve(page("sqlite"));

    const added = await memloom.contextAddUrl({ url: "https://www.sqlite.org/wal.html" });
    expect(added.outcome).toBe("added");
    expect(added.chunks).toBeGreaterThan(1);

    const results = await memloom.recall("write ahead log checkpoint");
    const chunk = results.find((r) => r.kind === "context");
    expect(chunk).toBeDefined();
    expect(chunk?.source?.path).toBe("https://www.sqlite.org/wal.html");
    // The citation locator: heading breadcrumb, no new column, page stays null.
    expect(chunk?.source?.headingPath).toBeTruthy();
    expect(chunk?.source?.page).toBeNull();
  });

  it("lists the page as a document whose path is its URL", async () => {
    const { memloom } = await fresh();
    serve(page("sqlite"));
    await memloom.contextAddUrl({ url: "https://www.sqlite.org/wal.html" });

    const [doc] = await memloom.contextList();
    expect(doc?.kind).toBe("link");
    expect(doc?.path).toBe("https://www.sqlite.org/wal.html");
    expect(doc?.title.length).toBeGreaterThan(0);
  });

  it("re-adding an unchanged page is a no-op", async () => {
    const { memloom } = await fresh();
    serve(page("sqlite"));
    const first = await memloom.contextAddUrl({ url: "https://www.sqlite.org/wal.html" });
    const again = await memloom.contextAddUrl({ url: "https://www.sqlite.org/wal.html" });

    expect(again.outcome).toBe("unchanged");
    expect(again.documentId).toBe(first.documentId);
    expect(await memloom.contextList()).toHaveLength(1);
  });

  it("the same page saved with tracking junk updates the one document, not a second", async () => {
    const { memloom } = await fresh();
    serve(page("sqlite"));
    await memloom.contextAddUrl({ url: "https://www.sqlite.org/wal.html" });
    await memloom.contextAddUrl({
      url: "https://www.sqlite.org/wal.html?utm_source=newsletter#overview",
    });
    expect(await memloom.contextList()).toHaveLength(1);
  });

  it("an edited page replaces its chunks", async () => {
    const { memloom } = await fresh();
    serve(page("sqlite"));
    const first = await memloom.contextAddUrl({ url: "https://www.sqlite.org/wal.html" });

    serve(page("rustbook"));
    const second = await memloom.contextAddUrl({ url: "https://www.sqlite.org/wal.html" });
    expect(second.outcome).toBe("updated");
    expect(second.documentId).toBe(first.documentId);
    expect(await memloom.contextList()).toHaveLength(1);
  });

  // Guards the false-absorb this stream found while reading #ingestDocument: a URL's last
  // path segment is not a filename, so "https://example.com/wal.html" must not swallow an
  // uploaded file that happens to be called wal.html.
  it("does not absorb an unrelated upload that shares the URL's last path segment", async () => {
    const { memloom } = await fresh();
    const upload = await memloom.contextUpload({
      filename: "notes.md",
      bytes: new TextEncoder().encode("# Unrelated notes\n\nthese are my own notes about nothing"),
    });
    expect(upload.outcome).toBe("added");

    serve(page("sqlite"));
    const link = await memloom.contextAddUrl({ url: "https://example.com/docs/notes.md" });

    expect(link.outcome).toBe("added");
    expect(link.absorbed ?? 0).toBe(0);
    expect(await memloom.contextList()).toHaveLength(2);
  });

  it("saves a page from caller-supplied html without any fetch, for the extension path", async () => {
    const { memloom } = await fresh();
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch must not be called when html is supplied");
    });

    const added = await memloom.contextAddUrl({
      url: "https://app.example.com/private/doc",
      html: page("rustbook"),
    });
    expect(added.outcome).toBe("added");
    expect(added.chunks).toBeGreaterThan(1);

    const [doc] = await memloom.contextList();
    expect(doc?.path).toBe("https://app.example.com/private/doc");
  });

  it("surfaces an extraction failure instead of storing an empty document", async () => {
    const { memloom } = await fresh();
    serve("<html><body><div id=\"root\"></div></body></html>");

    await expect(memloom.contextAddUrl({ url: "https://app.example.com/spa" })).rejects.toThrow();
    expect(await memloom.contextList()).toHaveLength(0);
  });

  it("removing a link deletes it and its chunks", async () => {
    const { memloom } = await fresh();
    serve(page("sqlite"));
    const added = await memloom.contextAddUrl({ url: "https://www.sqlite.org/wal.html" });
    await memloom.contextRemove(added.documentId);
    expect(await memloom.contextList()).toHaveLength(0);
  });
});
