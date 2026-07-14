import { describe, expect, it } from "vitest";
import { assemblePageText, type PdfTextItem } from "./pdf-layout.js";

// Synthetic positioned glyphs: the shapes real math/2-up PDFs produce.

function item(str: string, x: number, y: number, w: number, h = 10): PdfTextItem {
  return { str, transform: [h, 0, 0, h, x, y], width: w, height: h };
}

const PAGE_WIDTH = 612;

describe("assemblePageText", () => {
  it("restores reading order from geometry when content-stream order is scrambled", () => {
    // Word equation objects emit ").( 0xS" for "S(x0).": positions are correct, order isn't.
    const scrambled = [
      item(").", 86, 700, 10),
      item("(", 60, 700, 10),
      item("0", 80, 697, 6, 7), // subscript: slightly lower baseline, smaller font
      item("x", 70, 700, 10),
      item("S", 50, 700, 10),
    ];
    expect(assemblePageText(scrambled, PAGE_WIDTH)).toBe("S(x0).");
  });

  it("spaces items across word gaps and stacks lines top to bottom", () => {
    const items = [
      item("world", 120, 700, 30),
      item("hello", 50, 700, 28),
      item("second line", 50, 686, 60),
    ];
    expect(assemblePageText(items, PAGE_WIDTH)).toBe("hello world\nsecond line");
  });

  it("inserts a paragraph break at a large vertical gap", () => {
    const items = [item("intro", 50, 700, 30), item("next section", 50, 650, 60)];
    expect(assemblePageText(items, PAGE_WIDTH)).toBe("intro\n\nnext section");
  });

  it("drops the duplicate column of a 2-up print layout", () => {
    const left = ["TITLE", "point one", "point two", "point three"].map((s, i) =>
      item(s, 50, 700 - i * 14, 100),
    );
    const right = ["TITLE", "point one", "point two", "point three"].map((s, i) =>
      item(s, 360, 700 - i * 14, 100),
    );
    expect(assemblePageText([...left, ...right], PAGE_WIDTH)).toBe(
      "TITLE\npoint one\npoint two\npoint three",
    );
  });

  it("keeps both columns when they differ", () => {
    const left = ["alpha", "bravo", "charlie", "delta"].map((s, i) =>
      item(s, 50, 700 - i * 14, 100),
    );
    const right = ["echo", "foxtrot", "golf", "hotel"].map((s, i) =>
      item(s, 360, 700 - i * 14, 100),
    );
    const text = assemblePageText([...left, ...right], PAGE_WIDTH);
    expect(text).toBe("alpha\nbravo\ncharlie\ndelta\n\necho\nfoxtrot\ngolf\nhotel");
  });

  it("never splits columns when a line spans the gutter", () => {
    const items = [
      item("a full-width heading spanning the middle of the page", 50, 700, 480),
      item("left cell", 50, 686, 80),
      item("right cell", 360, 686, 80),
      item("left again", 50, 672, 80),
      item("right again", 360, 672, 80),
      item("left more", 50, 658, 80),
      item("right more", 360, 658, 80),
      item("left last", 50, 644, 80),
    ];
    const text = assemblePageText(items, PAGE_WIDTH);
    // One column: rows interleave left-to-right per line instead of column-by-column.
    expect(text.split("\n")[1]).toBe("left cell right cell");
  });

  it("ignores unplaced marked-content markers and empty strings", () => {
    const items = [
      item("real", 50, 700, 25),
      { str: " ", transform: [10, 0, 0, 10, 80, 700], width: 3, height: 10 },
      { transform: [] } as unknown as PdfTextItem, // TextMarkedContent has no str
    ];
    expect(assemblePageText(items, PAGE_WIDTH)).toBe("real");
  });
});
