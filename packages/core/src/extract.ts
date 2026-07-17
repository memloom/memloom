import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { assemblePageText, type PdfTextItem } from "./pdf-layout.js";

// File → text units for the context connector, behind a pluggable extractor registry.
// Built-ins are local-first, text-layer only: .md/.txt read directly, PDF via unpdf
// (pure-JS PDF.js wrapper) with geometry-aware reading-order reconstruction per page.
// No OCR, no cloud parsers: the same line every OSS ingestion pipeline draws.
// New formats plug in via registerExtractor(): one object, no fork.

/** The kind stored in context_documents.kind. Built-ins: "md" | "txt" | "pdf"; open set. */
export type ContextKind = string;

export interface ExtractedUnit {
  text: string;
  /** 1-based PDF page; null for single-unit formats. Kept so chunks can cite their page. */
  page: number | null;
}

export interface ExtractedFile {
  kind: ContextKind;
  title: string;
  contentHash: string;
  /** Section strategy the chunker applies before size-splitting. */
  chunker: "markdown" | "outline";
  units: ExtractedUnit[];
}

/** A file format the context connector can ingest. Register one with registerExtractor(). */
export interface Extractor {
  /** Stored in context_documents.kind, e.g. "pdf". */
  kind: ContextKind;
  /** Lowercase extensions with the dot, e.g. [".pdf"]. Last registration wins per extension. */
  extensions: string[];
  /**
   * Bump when this format's extract/chunk pipeline changes: the version is salted into the
   * content hash (`#p{n}` when > 1), so `context add` re-ingests files whose bytes didn't
   * change instead of no-op'ing on stale chunks. Only inequality matters: the value is an
   * opaque cache-buster, never ordered or displayed, so plain integers and the count never
   * costs anything. Bump once per shipped pipeline change, not per experiment (every bump
   * re-embeds users' existing files), and remember shared chunker changes affect every
   * extractor using that chunker.
   */
  version: number;
  /** How chunks are sectioned: markdown headings, or outline (ALL-CAPS titles + numbered points). */
  chunker: "markdown" | "outline";
  extract(bytes: Uint8Array, path: string): Promise<{ title?: string; units: ExtractedUnit[] }>;
}

const registry = new Map<string, Extractor>();

export function registerExtractor(extractor: Extractor): void {
  for (const ext of extractor.extensions) registry.set(ext.toLowerCase(), extractor);
}

/** The registered extractor's kind for this path, or null if no extractor claims it. */
export function detectKind(path: string): ContextKind | null {
  return registry.get(extname(path).toLowerCase())?.kind ?? null;
}

/** Every extension the registry can ingest, sorted: for help text and error messages. */
export function supportedExtensions(): string[] {
  return [...registry.keys()].sort();
}

function mdTitle(text: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(text);
  return heading?.[1]?.trim() || fallback;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

// --- built-ins ---------------------------------------------------------------------------

registerExtractor({
  kind: "md",
  extensions: [".md", ".markdown"],
  // v2 = whole-section chunking (one heading section per chunk, no overlap). The salted
  // hash makes every already-ingested md re-chunk on its next add instead of no-oping.
  version: 2,
  chunker: "markdown",
  async extract(bytes, path) {
    const text = decodeText(bytes);
    return { title: mdTitle(text, basename(path)), units: [{ text, page: null }] };
  },
});

registerExtractor({
  kind: "txt",
  extensions: [".txt"],
  version: 1,
  chunker: "outline",
  async extract(bytes) {
    return { units: [{ text: decodeText(bytes), page: null }] };
  },
});

registerExtractor({
  kind: "pdf",
  extensions: [".pdf"],
  version: 1,
  chunker: "outline",
  async extract(bytes) {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const units: ExtractedUnit[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const view = page.view as [number, number, number, number];
      const text = assemblePageText(content.items as PdfTextItem[], view[2] - view[0]);
      if (text.length > 0) units.push({ text, page: p });
    }
    return { units };
  },
});

// -----------------------------------------------------------------------------------------

export async function extractFile(
  path: string,
  hash: (bytes: Uint8Array) => string,
): Promise<ExtractedFile> {
  return extractBytes(new Uint8Array(await readFile(path)), path, hash);
}

/**
 * Extract from in-memory bytes: the chat-attachment path, where the browser uploads file
 * content and no file ever touches the daemon's disk. `path` only picks the extractor by
 * extension and provides the title fallback, so a bare filename works.
 */
export async function extractBytes(
  bytes: Uint8Array,
  path: string,
  hash: (bytes: Uint8Array) => string,
): Promise<ExtractedFile> {
  const extractor = registry.get(extname(path).toLowerCase());
  if (!extractor) {
    throw new Error(
      `unsupported file type: ${basename(path)} (the context connector reads ${supportedExtensions().join(", ")})`,
    );
  }
  const contentHash =
    extractor.version === 1 ? hash(bytes) : `${hash(bytes)}#p${extractor.version}`;
  const { title, units } = await extractor.extract(bytes, path);
  return {
    kind: extractor.kind,
    title: title || basename(path),
    contentHash,
    chunker: extractor.chunker,
    units,
  };
}
