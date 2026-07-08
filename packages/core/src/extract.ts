import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { assemblePageText, type PdfTextItem } from "./pdf-layout.js";

// File → text units for the context connector. Local-first, text-layer only: .md/.txt read
// directly, PDF via unpdf (pure-JS PDF.js wrapper) with geometry-aware reading-order
// reconstruction per page. No OCR, no cloud parsers — the same line every OSS ingestion
// pipeline draws.

export type ContextKind = "md" | "txt" | "pdf";

// Bumped when a kind's extract/chunk pipeline changes: the version is salted into the
// content hash, so `context add` re-ingests files whose bytes didn't change instead of
// no-op'ing on the stale chunks. md is untouched at 1 (no suffix → existing docs stay
// unchanged, no re-embedding spend).
const PIPELINE_VERSION: Record<ContextKind, number> = { md: 1, txt: 3, pdf: 3 };

export interface ExtractedUnit {
  text: string;
  /** 1-based PDF page; null for md/txt. Competitors that drop this regret it — keep it. */
  page: number | null;
}

export interface ExtractedFile {
  kind: ContextKind;
  title: string;
  contentHash: string;
  units: ExtractedUnit[];
}

export function detectKind(path: string): ContextKind | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "md";
  if (ext === ".txt") return "txt";
  if (ext === ".pdf") return "pdf";
  return null;
}

function mdTitle(text: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(text);
  return heading?.[1]?.trim() || fallback;
}

export async function extractFile(
  path: string,
  hash: (bytes: Uint8Array) => string,
): Promise<ExtractedFile> {
  const kind = detectKind(path);
  if (!kind) {
    throw new Error(
      `unsupported file type: ${basename(path)} (the context connector reads .md, .txt, and .pdf)`,
    );
  }
  const bytes = new Uint8Array(await readFile(path));
  const version = PIPELINE_VERSION[kind];
  const contentHash = version === 1 ? hash(bytes) : `${hash(bytes)}#p${version}`;
  const fallbackTitle = basename(path);

  if (kind === "pdf") {
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
    return { kind, title: fallbackTitle, contentHash, units };
  }

  const text = new TextDecoder("utf-8").decode(bytes);
  const title = kind === "md" ? mdTitle(text, fallbackTitle) : fallbackTitle;
  return { kind, title, contentHash, units: [{ text, page: null }] };
}
