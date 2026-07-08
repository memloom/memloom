import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractFile } from "./extract.js";

// extractFile through the real unpdf path, with PDFs whose text items are positioned —
// proving the geometry reconstruction end-to-end, not just on synthetic items.

interface PdfLine {
  x: number;
  y: number;
  text: string;
  size?: number;
}

/** Minimal valid PDF with one positioned text item per PdfLine, correct xref offsets. */
function makePdf(items: PdfLine[]): Uint8Array {
  const stream = items
    .map(({ x, y, text, size = 12 }) => {
      const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      return `BT /F1 ${size} Tf ${x} ${y} Td (${escaped}) Tj ET`;
    })
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const hash = (bytes: Uint8Array) => `h${bytes.length}`;

describe("extractFile (pdf geometry)", () => {
  const dir = mkdtempSync(join(tmpdir(), "memloom-extract-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reorders scrambled items and drops the duplicate 2-up column", async () => {
    // Emit the right (duplicate) column first, and each line's later word before the
    // earlier one — both must come back in reading order, once.
    const column = (x0: number): PdfLine[] => [
      { x: x0 + 70, y: 700, text: "world" },
      { x: x0, y: 700, text: "hello" },
      { x: x0, y: 680, text: "1. DEFINICJA 1. Tekst punktu." },
      { x: x0, y: 660, text: "2. DEFINICJA 2. Dalszy tekst." },
    ];
    const path = join(dir, "twoup.pdf");
    writeFileSync(path, makePdf([...column(330), ...column(60)]));

    const file = await extractFile(path, hash);
    expect(file.units).toHaveLength(1);
    const text = (file.units[0]?.text ?? "").replace(/\s+/g, " ");
    expect(text).toBe("hello world 1. DEFINICJA 1. Tekst punktu. 2. DEFINICJA 2. Dalszy tekst.");
  });

  it("salts the content hash with the pipeline version for txt/pdf but not md", async () => {
    const pdfPath = join(dir, "salted.pdf");
    writeFileSync(pdfPath, makePdf([{ x: 72, y: 720, text: "content" }]));
    const txtPath = join(dir, "salted.txt");
    writeFileSync(txtPath, "content");
    const mdPath = join(dir, "salted.md");
    writeFileSync(mdPath, "# content");

    expect((await extractFile(pdfPath, hash)).contentHash).toMatch(/#p2$/);
    expect((await extractFile(txtPath, hash)).contentHash).toMatch(/#p2$/);
    expect((await extractFile(mdPath, hash)).contentHash).not.toContain("#");
  });
});
