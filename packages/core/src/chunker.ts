// Zero-dependency recursive character splitter with a markdown heading-aware pre-pass.
// Research-backed defaults (Chroma/Snowflake/Firecrawl consensus, 2025-26): ~1,600-char
// chunks (~400 tokens), 2,048 hard cap, ~12% overlap. Character-sized on purpose; tiktoken
// wouldn't be accurate for Qwen's tokenizer anyway, and the embedding model has ~20x context
// headroom, so a tokenizer dependency buys nothing.
//
// The retrieval-quality lever: markdown chunks get their heading breadcrumb PREPENDED to the
// chunk text ("Guide > Setup > Postgres"), not stored as metadata alone, so both the vector
// and keyword arms of hybrid retrieval see the context (Anthropic's contextual-retrieval
// result, approximated for free).

export interface ChunkOptions {
  /** Preferred chunk size in characters; pieces merge up to this. */
  target?: number;
  /** Hard cap: any piece longer is recursively re-split. */
  max?: number;
  /** Characters of the previous chunk's tail carried into the next chunk. */
  overlap?: number;
}

export interface Chunk {
  /** The text to embed/index (breadcrumb-prefixed for markdown sections). */
  content: string;
  /** "Guide > Setup > Postgres" for markdown chunks; null otherwise. */
  headingPath: string | null;
}

const DEFAULTS = { target: 1600, max: 2048, overlap: 200 };

// Coarse → fine. Sentence boundaries via lookbehind split; the empty string means "hard cut".
const SEPARATORS = ["\n\n", "\n"] as const;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

function splitOnce(text: string, level: number): string[] {
  if (level === 0 || level === 1) {
    const sep = SEPARATORS[level] as string;
    return text.split(sep).filter((p) => p.trim().length > 0);
  }
  if (level === 2) return text.split(SENTENCE_BOUNDARY).filter((p) => p.trim().length > 0);
  if (level === 3) return text.split(" ").filter((p) => p.length > 0);
  return []; // level 4: hard cut, handled by caller
}

// Break `text` into pieces each <= max, trying coarse separators first.
function shatter(text: string, max: number, level = 0): string[] {
  if (text.length <= max) return [text];
  if (level >= 4) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
    return out;
  }
  const parts = splitOnce(text, level);
  if (parts.length <= 1) return shatter(text, max, level + 1);
  return parts.flatMap((part) => shatter(part, max, level + 1));
}

/** Split plain text into chunk strings: shatter to <= max, greedily merge up to target. */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const { target, max, overlap } = { ...DEFAULTS, ...opts };
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= target) return [trimmed];

  const pieces = shatter(trimmed, max);
  const merged: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current.length > 0 && current.length + piece.length + 1 > target) {
      merged.push(current);
      current = piece;
    } else {
      current = current.length > 0 ? `${current}\n${piece}` : piece;
    }
  }
  if (current.trim().length > 0) merged.push(current);

  if (overlap <= 0 || merged.length <= 1) return merged;
  // Carry the previous chunk's tail (cut at a word boundary) into the next chunk, so a fact
  // straddling a boundary is retrievable from either side.
  return merged.map((chunk, i) => {
    if (i === 0) return chunk;
    const prev = merged[i - 1] as string;
    let tail = prev.slice(-overlap);
    const firstSpace = tail.indexOf(" ");
    if (firstSpace > 0) tail = tail.slice(firstSpace + 1);
    return `${tail.trimStart()}\n${chunk}`;
  });
}

interface Section {
  headingPath: string | null;
  text: string;
}

// Split markdown at ATX heading boundaries, tracking the heading stack. Headings inside
// fenced code blocks are content, not structure.
function sectionize(markdown: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let lines: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = lines.join("\n").trim();
    lines = [];
    if (text.length === 0) return;
    const headingPath = stack.length > 0 ? stack.map((h) => h.title).join(" > ") : null;
    sections.push({ headingPath, text });
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] as string).length;
      while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) {
        stack.pop();
      }
      stack.push({ level, title: (heading[2] as string).trim() });
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Chunk markdown: heading-aware sections, each recursively split, each chunk prefixed with
 * its heading breadcrumb. Overlap never crosses a heading boundary (sections chunk
 * independently).
 */
export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): Chunk[] {
  return sectionize(markdown).flatMap((section) =>
    chunkText(section.text, opts).map((piece) => ({
      content: section.headingPath ? `${section.headingPath}\n\n${piece}` : piece,
      headingPath: section.headingPath,
    })),
  );
}

// ---------------------------------------------------------------------------------------
// Outline chunking for plain text and PDF pages: no markdown headings, but real documents
// (lecture notes, exercise sheets, contracts) still have structure: ALL-CAPS title lines
// and numbered points ("2. DEFINICJA 2. …"). Split at those boundaries so a chunk never
// starts mid-definition, and carry "TITLE > 2. DEFINICJA 2." as the breadcrumb.

// An ALL-CAPS line (Unicode-aware, so Polish "GRANICA NIEWŁAŚCIWA FUNKCJI" qualifies).
function isCapsTitle(line: string): boolean {
  const t = line.trim();
  if (t.length < 4 || t.length > 120) return false;
  const letters = t.match(/\p{L}/gu) ?? [];
  return letters.length >= 4 && !/\p{Ll}/u.test(t);
}

const POINT_START = /^\s*(\d{1,3})[.)]\s+\S/;

// "DEFINICJA 1. Niech funkcja…" → "DEFINICJA 1.": the leading run of ALL-CAPS/number
// tokens after the point number, if any.
function pointKeyword(rest: string): string | null {
  const tokens: string[] = [];
  for (const token of rest.split(/\s+/)) {
    if (tokens.length >= 4 || !/^[\p{Lu}\p{N}]+[.,]?$/u.test(token)) break;
    tokens.push(token);
  }
  // The first token must be a real word ("DEFINICJA", "UWAGA"), not a stray capital like
  // the Polish preposition "O": single letters make noise breadcrumbs ("3. O").
  const first = tokens[0];
  if (!first || !/\p{Lu}/u.test(first) || first.replace(/[.,]$/, "").length < 3) return null;
  const keyword = tokens.join(" ");
  return keyword.length <= 40 ? keyword : null;
}

interface OutlineSection {
  title: string | null;
  num: string | null;
  keyword: string | null;
  text: string;
}

function outlineSections(text: string): OutlineSection[] {
  const sections: OutlineSection[] = [];
  let title: string | null = null;
  let current: OutlineSection | null = null;

  const flush = () => {
    if (current && current.text.trim().length > 0) sections.push(current);
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (isCapsTitle(line)) {
      flush();
      title = line.trim().replace(/\s+/g, " ");
      continue;
    }
    const point = POINT_START.exec(line);
    if (point) {
      flush();
      current = {
        title,
        num: point[1] as string,
        keyword: pointKeyword(line.slice((point[0] as string).length - 1).trim()),
        text: line,
      };
      continue;
    }
    if (!current) current = { title, num: null, keyword: null, text: "" };
    current.text = current.text.length > 0 ? `${current.text}\n${line}` : line;
  }
  flush();
  return sections;
}

function outlineBreadcrumb(section: OutlineSection): string | null {
  const label =
    section.num !== null
      ? section.keyword
        ? `${section.num}. ${section.keyword}`
        : `${section.num}.`
      : null;
  const parts = [section.title, label].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" > ") : null;
}

/**
 * Chunk plain text (or an extracted PDF page) along its outline: ALL-CAPS title lines and
 * numbered points are section boundaries. One point = one chunk (split further only past
 * the cap), each prefixed with its "TITLE > 2. DEFINICJA 2." breadcrumb. Text without any
 * such structure degrades to plain `chunkText`.
 */
export function chunkOutline(text: string, opts: ChunkOptions = {}): Chunk[] {
  const sections = outlineSections(text);
  // In a structured document, a tiny unlabeled fragment between points is extraction debris
  // (e.g. a formula numerator whose baseline floats above its point), not worth a chunk.
  // An unstructured document (single section) always survives, however small.
  const kept =
    sections.length > 1
      ? sections.filter((s) => s.num !== null || s.title !== null || s.text.trim().length >= 25)
      : sections;
  return kept.flatMap((section) => {
    const breadcrumb = outlineBreadcrumb(section);
    return chunkText(section.text, opts).map((piece) => ({
      content: breadcrumb ? `${breadcrumb}\n\n${piece}` : piece,
      headingPath: breadcrumb,
    }));
  });
}
