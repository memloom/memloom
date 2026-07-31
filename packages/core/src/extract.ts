import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { assemblePageText, type PdfTextItem } from "./pdf-layout.js";
import type { SpeakerRoster } from "./types.js";

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
  /** Diarized voices, media extractors only. Stored on the document row, not in chunks. */
  speakers?: SpeakerRoster | null;
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
  extract(
    bytes: Uint8Array,
    path: string,
  ): Promise<{ title?: string; units: ExtractedUnit[]; speakers?: SpeakerRoster | null }>;
  /**
   * Optional path-based extraction, for formats too large to hold in memory. `extractFile`
   * prefers this and never reads the file, which is what keeps a multi-gigabyte video from
   * being buffered just to hash it. Returns its own content hash because such an extractor
   * streams the bytes past a digest itself rather than being handed them.
   */
  extractPath?(
    path: string,
    opts?: ExtractPathOptions,
  ): Promise<{
    title?: string;
    units: ExtractedUnit[];
    contentHash: string;
    speakers?: SpeakerRoster | null;
  }>;
}

/**
 * Progress from an extractor slow enough to need it. Only the media path emits this today:
 * transcribing an hour of audio takes 8 to 11 minutes, and a silent CLI for that long reads
 * as a hang.
 */
export interface ExtractProgress {
  stage: string;
  done: number;
  total: number;
  seconds: number;
  audioSeconds: number;
}

/** What a path-based extractor accepts beyond the path itself. */
export interface ExtractPathOptions {
  onProgress?: (event: ExtractProgress) => void;
  /**
   * Stops a slow extraction early. Only the media path honours it, and only between decode
   * chunks, so the worst-case wait after a cancel is one chunk. Nothing is stored when an
   * extraction is cancelled, because the document is written only after it returns.
   */
  signal?: AbortSignal;
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

// Audio and video. Both are the same job (get a WAV, run ASR, keep the timestamps) and
// differ only in the kind stored on the document, which is worth keeping distinct so a
// recording and a screencast do not look identical in `context list`.
//
// These declare `chunker: "markdown"` because the transcript IS markdown: each section is a
// heading holding its time range, so chunkMarkdown makes one chunk per span and the existing
// citation formatter renders "from talk.mp4 > 12:30 - 14:28" with no new machinery.
for (const [kind, extensions] of [
  ["audio", [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac", ".wma"]],
  ["video", [".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]],
] as const) {
  registerExtractor({
    kind,
    extensions: [...extensions],
    // v2 = speaker diarization: sections break on speaker turns and multi-voice headings
    // carry labels, so already-ingested recordings re-ingest on their next add.
    // v3 = calibrated clustering (threshold 0.7 + junk-cluster absorption), so recordings
    // labeled by the over-splitting v2 defaults re-ingest with a sane roster.
    // v4 = the transcript opens with when the recording was made, so already-ingested
    // recordings pick up a date. Cheap to re-ingest: the words are cached by hash and model,
    // and the diarization signature is stored separately, so neither pass runs again.
    version: 4,
    chunker: "markdown",
    async extractPath(path, opts) {
      const { transcribeMedia, hashFile } = await import("./audio.js");
      const result = await transcribeMedia(path, {
        sha256: hashFile,
        onProgress: opts?.onProgress,
        signal: opts?.signal,
      });
      return { units: result.units, contentHash: result.contentHash, speakers: result.roster };
    },
    // The upload path, where bytes arrived over HTTP and never touched disk. ffmpeg needs a
    // file, so this spills to a temp file rather than refusing an uploaded recording.
    async extract(bytes, path) {
      const { transcribeMedia } = await import("./audio.js");
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "memloom-upload-"));
      const file = join(dir, basename(path));
      try {
        await writeFile(file, bytes);
        const result = await transcribeMedia(file, { sha256: async () => "" });
        return { units: result.units, speakers: result.roster };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  });
}

// -----------------------------------------------------------------------------------------

export async function extractFile(
  path: string,
  hash: (bytes: Uint8Array) => string,
  opts?: ExtractPathOptions,
): Promise<ExtractedFile> {
  const extractor = registry.get(extname(path).toLowerCase());
  if (extractor?.extractPath) {
    const { title, units, contentHash, speakers } = await extractor.extractPath(path, opts);
    return {
      kind: extractor.kind,
      title: title || basename(path),
      contentHash: extractor.version === 1 ? contentHash : `${contentHash}#p${extractor.version}`,
      chunker: extractor.chunker,
      units,
      ...(speakers === undefined ? {} : { speakers }),
    };
  }
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
  const { title, units, speakers } = await extractor.extract(bytes, path);
  return {
    kind: extractor.kind,
    title: title || basename(path),
    contentHash,
    chunker: extractor.chunker,
    units,
    ...(speakers === undefined ? {} : { speakers }),
  };
}
