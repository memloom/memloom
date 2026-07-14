// Geometry-aware text reconstruction for PDF pages. PDF.js returns text items in content-
// stream order, which for equation-heavy PDFs (Word/LaTeX math objects) is NOT reading order:
// glyphs of one formula arrive scrambled. Their positions are correct, though, so we
// rebuild reading order from geometry: split columns at an uncovered vertical gutter, group
// items into lines by baseline, sort left-to-right, and space by horizontal gaps.
//
// Also handles the 2-up print layout (the same content twice, side by side): when two
// detected columns are duplicates after whitespace normalization, one is dropped.
//
// What this cannot fix: glyphs from symbol fonts without a Unicode mapping (∞, ∈, ≠ …)
// never reach the text layer at all: that needs OCR, which is out of scope by design.

/** The subset of PDF.js's TextItem we consume. */
export interface PdfTextItem {
  str: string;
  /** PDF transform matrix; [4] = x, [5] = y (baseline, origin bottom-left). */
  transform: number[];
  width: number;
  height: number;
}

interface Placed {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function place(items: PdfTextItem[]): Placed[] {
  const placed: Placed[] = [];
  for (const item of items) {
    // getTextContent also yields marked-content markers without a str: skip anything unplaced.
    if (typeof item.str !== "string" || item.str.trim().length === 0) continue;
    if (!Array.isArray(item.transform)) continue;
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const h = item.height || Math.abs(item.transform[3] ?? 0) || 10;
    placed.push({ str: item.str, x, y, w: item.width || 0, h });
  }
  return placed;
}

// Find a vertical band in the central 30–70% of the page that no item crosses. A genuine
// column gutter is uncovered along the whole page; any full-width line kills the split,
// which is exactly the conservative behavior we want.
function splitColumns(items: Placed[], pageWidth: number): Placed[][] {
  if (items.length < 8 || pageWidth <= 0) return [items];
  const spans = items.map((i) => [i.x, i.x + i.w] as const).sort((a, b) => a[0] - b[0]);
  let coveredTo = Number.NEGATIVE_INFINITY;
  let best: { at: number; width: number } | null = null;
  for (const [start, end] of spans) {
    if (start > coveredTo && Number.isFinite(coveredTo)) {
      const gap = start - coveredTo;
      const mid = coveredTo + gap / 2;
      const central = mid > pageWidth * 0.3 && mid < pageWidth * 0.7;
      if (central && gap >= pageWidth * 0.04 && (!best || gap > best.width)) {
        best = { at: mid, width: gap };
      }
    }
    coveredTo = Math.max(coveredTo, end);
  }
  if (!best) return [items];
  const at = best.at;
  const left = items.filter((i) => i.x + i.w / 2 < at);
  const right = items.filter((i) => i.x + i.w / 2 >= at);
  if (left.length < 4 || right.length < 4) return [items];
  return [left, right];
}

// Group items into baseline lines (tolerance keeps sub/superscripts on their line), order
// lines top-to-bottom and items left-to-right, insert spaces at horizontal gaps and blank
// lines at large vertical gaps (paragraph breaks).
function assembleColumn(items: Placed[]): string {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Placed[][] = [];
  for (const item of sorted) {
    const line = lines[lines.length - 1];
    const anchor = line?.[0];
    if (line && anchor && Math.abs(anchor.y - item.y) <= 0.6 * Math.max(anchor.h, item.h, 6)) {
      line.push(item);
    } else {
      lines.push([item]);
    }
  }

  const out: string[] = [];
  let prevBaseline: number | null = null;
  let prevHeight = 10;
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    const anchor = line[0] as Placed;
    if (prevBaseline !== null && prevBaseline - anchor.y > 1.8 * Math.max(prevHeight, anchor.h)) {
      out.push("");
    }
    let text = "";
    let prevEnd: number | null = null;
    for (const item of line) {
      if (prevEnd !== null && item.x - prevEnd > Math.max(0.8, 0.15 * item.h)) text += " ";
      text += item.str;
      prevEnd = Math.max(prevEnd ?? item.x, item.x + item.w);
    }
    out.push(text.replace(/\s+/g, " ").trimEnd());
    prevBaseline = anchor.y;
    prevHeight = Math.max(...line.map((i) => i.h));
  }
  return out.join("\n").trim();
}

/** Rebuild a page's text in reading order from its positioned text items. */
export function assemblePageText(items: PdfTextItem[], pageWidth: number): string {
  const placed = place(items);
  if (placed.length === 0) return "";
  const columns = splitColumns(placed, pageWidth).map(assembleColumn);
  // 2-up print layouts duplicate the whole page side by side: keep one copy.
  if (columns.length === 2) {
    const [a, b] = columns as [string, string];
    if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return a;
  }
  return columns.filter((c) => c.length > 0).join("\n\n");
}
