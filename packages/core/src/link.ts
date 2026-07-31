import { basename } from "node:path";
import type { ExtractedFile, ExtractedUnit } from "./extract.js";

// URL → text units for the context connector. memloom fetches the page itself, parses it
// in this process, and never hands the URL or the HTML to a third party: no Firecrawl, no
// Jina, no headless browser. The same line the file extractors draw.
//
// defuddle decides which subtree is the article and serializes it to markdown. linkedom is
// the DOM it walks. That pairing was measured against jsdom over twenty real pages: nineteen
// byte-identical, one a wash, and jsdom cost 6.4x the wall clock. Node has no DOM of its
// own, which is the only reason a DOM library appears here at all.

/** Bump when the fetch/extract pipeline changes: salted into the hash so links re-ingest. */
export const LINK_EXTRACTOR_VERSION = 1;

/** Page bodies larger than this are refused: a memory store is not a mirror of the web. */
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;

/** Redirect chains longer than this are a loop or a tracker, not a document. */
const MAX_REDIRECTS = 5;

const FETCH_TIMEOUT_MS = 20_000;

// Real pages serve different markup to unknown agents, and some refuse them outright.
// defuddle's own CLI ships a --user-agent flag for the same reason.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";

// Campaign and click-id junk. Two URLs that differ only by these are the same document, and
// keeping them apart would store the same article twice under two paths.
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^igshid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^s_kwcid$/i,
  /^_hs(enc|mi)$/i,
];

/**
 * A page that yields almost no text from a lot of markup did not extract: it rendered in
 * the browser, or sits behind a wall. Measured on real pages: a GitHub blob view of 1 MB
 * of HTML yields ~677 characters of pure navigation chrome, while a genuinely short
 * article stub yields ~738 characters from 13 KB. So the signal is the ratio, not the
 * length: never refuse a small page just for being small.
 */
export const MIN_EXTRACTED_CHARS = 800;
export const LARGE_HTML_BYTES = 100 * 1024;

export class LinkExtractionError extends Error {
  constructor(
    message: string,
    /** Stable code so callers can branch without matching on prose. */
    readonly code:
      | "not_html"
      | "too_large"
      | "too_many_redirects"
      | "http_error"
      | "empty"
      | "likely_rendered",
    readonly url: string,
  ) {
    super(message);
    this.name = "LinkExtractionError";
  }
}

/** True for something we should try to fetch as a page. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * The stored identity of a page: tracking parameters and the fragment stripped, host
 * lowercased. The fragment is a position inside the document, not a different document,
 * and citations rebuild it from the heading anchor anyway.
 */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  // "example.com/?" and "example.com/" are the same page; keep the shorter spelling.
  let out = url.toString();
  if (url.search === "" && out.endsWith("?")) out = out.slice(0, -1);
  return out;
}

export interface FetchedPage {
  /** The URL after redirects, normalized: this is what gets stored as the document path. */
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Fetch a page with a redirect cap and a size cap. Redirects are followed by hand rather
 * than by fetch(), so the chain length is bounded and the final URL is observable (the
 * document's identity is where it landed, not where it was pointed).
 */
export async function fetchPage(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedPage> {
  let current = normalizeUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new LinkExtractionError(
          `${current} returned ${response.status} with no redirect target`,
          "http_error",
          current,
        );
      }
      current = normalizeUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) {
      throw new LinkExtractionError(
        `${current} returned HTTP ${response.status}`,
        "http_error",
        current,
      );
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_PAGE_BYTES) {
      throw new LinkExtractionError(
        `${current} is ${Math.round(declared / 1024 / 1024)} MB, over the ${MAX_PAGE_BYTES / 1024 / 1024} MB limit`,
        "too_large",
        current,
      );
    }

    // A lying or absent content-length still cannot blow up memory: the cap is enforced
    // against what actually arrives.
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_PAGE_BYTES) {
      throw new LinkExtractionError(
        `${current} sent more than the ${MAX_PAGE_BYTES / 1024 / 1024} MB limit`,
        "too_large",
        current,
      );
    }

    return { url: current, contentType, bytes: buffer };
  }

  throw new LinkExtractionError(
    `${rawUrl} redirected more than ${MAX_REDIRECTS} times`,
    "too_many_redirects",
    rawUrl,
  );
}

/** Title fallback when the page has none: the last meaningful path segment, or the host. */
function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (!segment) return parsed.hostname;
    return decodeURIComponent(basename(segment, ".html")).replace(/[-_]+/g, " ").trim();
  } catch {
    return url;
  }
}

export interface ExtractedPage {
  title: string;
  markdown: string;
  author: string | null;
  published: string | null;
}

/**
 * HTML → article markdown. Exported on its own because the browser extension path has the
 * rendered DOM already and never needs the fetch above: that is the whole reason a page
 * behind a login or built as a single-page app is savable at all.
 */
export async function extractHtml(html: string, url: string): Promise<ExtractedPage> {
  const { parseHTML } = await import("linkedom");
  const { Defuddle } = await import("defuddle/node");

  // core compiles without the DOM lib, so the Document type is not nameable here. Taking
  // the parameter type from Defuddle itself keeps this honest and avoids an `any`.
  const { document } = parseHTML(html);
  const result = await Defuddle(document as Parameters<typeof Defuddle>[0], url, {
    markdown: true,
  });

  const markdown = (result.content ?? "").trim();
  return {
    title: (result.title || "").trim() || titleFromUrl(url),
    markdown,
    author: (result.author || "").trim() || null,
    published: (result.published || "").trim() || null,
  };
}

export interface ExtractUrlOptions {
  /**
   * Pre-rendered HTML from a browser that already loaded the page. When present no fetch
   * happens at all: the caller's DOM wins, because it saw the page as the user did.
   */
  html?: string;
  fetchImpl?: typeof fetch;
}

export interface ExtractedLink extends ExtractedFile {
  /** Final normalized URL: the document's path, and the base of every citation link. */
  url: string;
  author: string | null;
  published: string | null;
  /** Set when the extraction looks thin but was kept anyway (html was supplied). */
  warning?: string;
}

/**
 * URL → an ExtractedFile the existing ingest path understands. The content hash is taken
 * over the EXTRACTED MARKDOWN, not the raw HTML: a page whose ads, CSRF token or "3 min
 * read" counter changed is the same document, and hashing the markup would re-embed it on
 * every refresh.
 */
export async function extractUrl(
  rawUrl: string,
  hash: (bytes: Uint8Array) => string,
  options: ExtractUrlOptions = {},
): Promise<ExtractedLink> {
  const url = normalizeUrl(rawUrl);

  let html: string;
  let htmlBytes: number;
  // A redirect chain means the document lives where it LANDED, not where it was pointed:
  // storing the original would give two paths for one page and break re-add idempotence.
  let finalUrl = url;
  if (options.html !== undefined) {
    html = options.html;
    htmlBytes = Buffer.byteLength(html);
  } else {
    const fetched = await fetchPage(url, options.fetchImpl);
    if (!fetched.contentType.includes("html") && fetched.contentType !== "") {
      throw new LinkExtractionError(
        `${fetched.url} is ${fetched.contentType.split(";")[0]}, not a web page`,
        "not_html",
        fetched.url,
      );
    }
    html = new TextDecoder("utf-8").decode(fetched.bytes);
    htmlBytes = fetched.bytes.byteLength;
    finalUrl = fetched.url;
  }

  const article = await extractHtml(html, finalUrl);

  if (article.markdown.length === 0) {
    throw new LinkExtractionError(`no readable content at ${finalUrl}`, "empty", finalUrl);
  }

  // The thin-extraction guard. When the caller supplied rendered HTML they already did the
  // hard part, so a thin result is reported rather than refused: some pages really are short.
  const thin = article.markdown.length < MIN_EXTRACTED_CHARS && htmlBytes > LARGE_HTML_BYTES;
  if (thin && options.html === undefined) {
    throw new LinkExtractionError(
      `${finalUrl} yielded only ${article.markdown.length} characters from ${Math.round(htmlBytes / 1024)} KB of markup, ` +
        "so it probably renders in the browser or sits behind a wall. Save it with the memloom browser extension instead.",
      "likely_rendered",
      finalUrl,
    );
  }

  const digest = hash(new TextEncoder().encode(article.markdown));
  const units: ExtractedUnit[] = [{ text: article.markdown, page: null }];

  return {
    kind: "link",
    title: article.title,
    contentHash: LINK_EXTRACTOR_VERSION === 1 ? digest : `${digest}#p${LINK_EXTRACTOR_VERSION}`,
    chunker: "markdown",
    units,
    url: finalUrl,
    author: article.author,
    published: article.published,
    ...(thin ? { warning: `only ${article.markdown.length} characters extracted` } : {}),
  };
}
