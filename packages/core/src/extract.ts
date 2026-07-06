import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

// File → text units for the context connector. Local-first, text-layer only: .md/.txt read
// directly, PDF via unpdf (pure-JS PDF.js wrapper, per-page). No OCR, no cloud parsers —
// the same line every OSS ingestion pipeline draws.

export type ContextKind = "md" | "txt" | "pdf";

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
  const contentHash = hash(bytes);
  const fallbackTitle = basename(path);

  if (kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    const units = text
      .map((pageText, i) => ({ text: pageText.trim(), page: i + 1 }))
      .filter((u) => u.text.length > 0);
    return { kind, title: fallbackTitle, contentHash, units };
  }

  const text = new TextDecoder("utf-8").decode(bytes);
  const title = kind === "md" ? mdTitle(text, fallbackTitle) : fallbackTitle;
  return { kind, title, contentHash, units: [{ text, page: null }] };
}
