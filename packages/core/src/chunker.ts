// Zero-dependency recursive character splitter with a markdown heading-aware pre-pass.
// Research-backed defaults (Chroma/Snowflake/Firecrawl consensus, 2025-26): ~1,600-char
// chunks (~400 tokens), 2,048 hard cap, ~12% overlap. Character-sized on purpose — tiktoken
// wouldn't be accurate for Qwen's tokenizer anyway, and the embedding model has ~20x context
// headroom, so a tokenizer dependency buys nothing.
//
// The retrieval-quality lever: markdown chunks get their heading breadcrumb PREPENDED to the
// chunk text ("Guide > Setup > Postgres"), not stored as metadata alone — so both the vector
// and keyword arms of hybrid retrieval see the context (Anthropic's contextual-retrieval
// result, approximated for free).

export interface ChunkOptions {
  /** Preferred chunk size in characters; pieces merge up to this. */
  target?: number;
  /** Hard cap — any piece longer is recursively re-split. */
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
