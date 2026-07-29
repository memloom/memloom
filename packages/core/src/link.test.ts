import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractHtml,
  extractUrl,
  LinkExtractionError,
  MAX_PAGE_BYTES,
  normalizeUrl,
} from "./link.js";

// Fixtures are real pages saved on 2026-07-27, not synthetic markup: the whole point of the
// link path is surviving what sites actually serve. Kept small on purpose (the biggest is
// 55 KB); the thin-extraction case is synthesized instead of shipping a 1 MB page.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "pages");
const page = (name: string) => readFileSync(join(FIXTURES, `${name}.html`), "utf8");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A fetch that answers every request with one canned HTML response. */
function stubFetch(html: string, init: { contentType?: string; status?: number } = {}) {
  return (async () =>
    new Response(html, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
}

describe("normalizeUrl", () => {
  it("strips tracking parameters and the fragment, and lowercases the host", () => {
    expect(normalizeUrl("https://Example.COM/post?utm_source=x&id=7&fbclid=abc#section")).toBe(
      "https://example.com/post?id=7",
    );
  });

  it("keeps a URL that carries no junk untouched", () => {
    expect(normalizeUrl("https://example.com/a/b?q=1")).toBe("https://example.com/a/b?q=1");
  });

  it("drops a trailing question mark left behind by stripping", () => {
    expect(normalizeUrl("https://example.com/post?utm_campaign=spring")).toBe(
      "https://example.com/post",
    );
  });
});

describe("extractHtml", () => {
  it("pulls the article out of a real blog post as markdown with headings", async () => {
    const result = await extractHtml(page("simonwillison"), "https://simonwillison.net/x/");
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.markdown.length).toBeGreaterThan(5_000);
    expect(result.markdown).toMatch(/^#{1,6}\s/m);
  });

  it("keeps the heading structure of a docs page, which is what chunkMarkdown sections on", async () => {
    const result = await extractHtml(page("sqlite"), "https://www.sqlite.org/wal.html");
    const headings = result.markdown.match(/^#{1,6}\s/gm) ?? [];
    expect(headings.length).toBeGreaterThan(5);
  });

  it("drops the site chrome: no nav, no cookie banner in the output", async () => {
    const result = await extractHtml(page("rustbook"), "https://doc.rust-lang.org/book/x.html");
    expect(result.markdown.toLowerCase()).not.toContain("skip to content");
    expect(result.markdown.length).toBeGreaterThan(10_000);
  });
});

describe("extractUrl", () => {
  it("returns an ExtractedFile the existing ingest path understands", async () => {
    const link = await extractUrl("https://simonwillison.net/x/", sha256, {
      fetchImpl: stubFetch(page("simonwillison")),
    });
    expect(link.kind).toBe("link");
    expect(link.chunker).toBe("markdown");
    expect(link.units).toHaveLength(1);
    expect(link.units[0]?.page).toBeNull();
    expect(link.url).toBe("https://simonwillison.net/x/");
  });

  it("stores the normalized URL, so the same page saved with tracking junk is one document", async () => {
    const clean = await extractUrl("https://www.sqlite.org/wal.html", sha256, {
      fetchImpl: stubFetch(page("sqlite")),
    });
    const dirty = await extractUrl("https://www.sqlite.org/wal.html?utm_source=hn#intro", sha256, {
      fetchImpl: stubFetch(page("sqlite")),
    });
    expect(dirty.url).toBe(clean.url);
    expect(dirty.contentHash).toBe(clean.contentHash);
  });

  // The reason the hash is taken over the extracted markdown rather than the raw bytes:
  // pages change their chrome constantly and their article rarely.
  it("hashes the article, not the markup, so a changed ad or token is not a new version", async () => {
    const original = page("sqlite");
    const rerendered = original
      .replace("<head>", '<head><meta name="csrf" content="9f8c2b41">')
      .replace("</body>", '<div class="ad">Sponsored: buy things</div><!-- built 12:04 --></body>');
    expect(rerendered).not.toBe(original);

    const first = await extractUrl("https://www.sqlite.org/wal.html", sha256, {
      fetchImpl: stubFetch(original),
    });
    const second = await extractUrl("https://www.sqlite.org/wal.html", sha256, {
      fetchImpl: stubFetch(rerendered),
    });
    expect(second.contentHash).toBe(first.contentHash);
  });

  // Modelled on the real failure this guard was written for: a GitHub blob view served 1 MB
  // of markup and extracted to ~677 characters of pure navigation chrome.
  it("refuses a page that yields almost nothing from a lot of markup", async () => {
    const chrome = '<li><a href="/x">Navigate somewhere</a></li>'.repeat(4_000);
    const shell =
      `<html><head><title>App</title></head><body><nav>${chrome}</nav>` +
      "<div id=\"root\"><p>Loading your dashboard.</p></div></body></html>";
    expect(Buffer.byteLength(shell)).toBeGreaterThan(100 * 1024);

    await expect(
      extractUrl("https://app.example.com/dashboard", sha256, { fetchImpl: stubFetch(shell) }),
    ).rejects.toMatchObject({ code: "likely_rendered" });
  });

  it("refuses a page with no readable content at all, separately from the thin case", async () => {
    const blank = "<html><head><title>App</title></head><body><div id=\"root\"></div></body></html>";
    await expect(
      extractUrl("https://app.example.com/blank", sha256, { fetchImpl: stubFetch(blank) }),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("does not refuse a page that is genuinely short", async () => {
    // A real stub article: ~740 characters of content from 13 KB of markup. Under a rule
    // that keyed on output length alone this would be rejected, and it is a valid page.
    const link = await extractUrl("https://martinfowler.com/articles/x.html", sha256, {
      fetchImpl: stubFetch(page("martinfowler")),
    });
    expect(link.units[0]?.text.length).toBeLessThan(2_000);
    expect(link.units[0]?.text).toContain("durability");
  });

  it("reports a non-HTML response instead of storing bytes as text", async () => {
    await expect(
      extractUrl("https://example.com/paper.pdf", sha256, {
        fetchImpl: stubFetch("%PDF-1.4", { contentType: "application/pdf" }),
      }),
    ).rejects.toMatchObject({ code: "not_html" });
  });

  it("reports an HTTP error with the status in the message", async () => {
    await expect(
      extractUrl("https://example.com/gone", sha256, {
        fetchImpl: stubFetch("nope", { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("refuses a body over the size cap even when the header lies about it", async () => {
    const huge = "x".repeat(MAX_PAGE_BYTES + 1);
    const fetchImpl = (async () =>
      new Response(huge, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(
      extractUrl("https://example.com/huge", sha256, { fetchImpl }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  // The document lives where the chain landed. Storing the original would give one page two
  // paths, and a re-add of the settled URL would create a second document.
  it("stores the URL a redirect landed on, not the one it started from", async () => {
    let served = 0;
    const fetchImpl = (async () => {
      served++;
      return served === 1
        ? new Response(null, {
            status: 301,
            headers: { location: "https://www.sqlite.org/wal.html" },
          })
        : new Response(page("sqlite"), { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    const link = await extractUrl("https://sqlite.org/wal.html?utm_source=x", sha256, {
      fetchImpl,
    });
    expect(link.url).toBe("https://www.sqlite.org/wal.html");
  });

  it("gives up on a redirect loop rather than following it forever", async () => {
    let hops = 0;
    const fetchImpl = (async () => {
      hops++;
      return new Response(null, { status: 302, headers: { location: "https://example.com/next" } });
    }) as unknown as typeof fetch;

    await expect(
      extractUrl("https://example.com/start", sha256, { fetchImpl }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(hops).toBeLessThanOrEqual(6);
  });

  // The extension path. A caller that already rendered the page hands over its DOM, and the
  // daemon never fetches, which is why a login-walled or JS-rendered page works at all.
  it("skips the fetch entirely when the caller supplies rendered html", async () => {
    const exploding = (async () => {
      throw new Error("fetch must not be called when html is supplied");
    }) as unknown as typeof fetch;

    const link = await extractUrl("https://app.example.com/private", sha256, {
      html: page("sqlite"),
      fetchImpl: exploding,
    });
    expect(link.units[0]?.text.length).toBeGreaterThan(1_000);
  });

  it("keeps a thin result when the caller rendered it, and says so", async () => {
    const shell = `<html><body><nav>${'<li><a href="/x">Navigate</a></li>'.repeat(4_000)}</nav><p>Short note.</p></body></html>`;
    const link = await extractUrl("https://app.example.com/x", sha256, { html: shell });
    expect(link.warning).toMatch(/characters extracted/);
  });

  it("throws a typed error, so callers can branch without matching on prose", async () => {
    const error = await extractUrl("https://example.com/gone", sha256, {
      fetchImpl: stubFetch("nope", { status: 404 }),
    }).catch((err) => err);
    expect(error).toBeInstanceOf(LinkExtractionError);
    expect(error.url).toBe("https://example.com/gone");
  });
});
