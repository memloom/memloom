import { describe, expect, it } from "vitest";
import { chunkMarkdown, chunkOutline, chunkText } from "./chunker.js";

describe("chunkText", () => {
  it("returns short text as a single chunk", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits long text into chunks under the cap, merged toward the target", () => {
    const paragraph = `${"word ".repeat(80)}end.`; // ~400 chars
    const text = Array.from({ length: 12 }, () => paragraph).join("\n\n"); // ~4.9k chars
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // target 1600 + overlap 200 + a merged piece can run slightly over target, never wildly.
      expect(chunk.length).toBeLessThanOrEqual(2048 + 200);
    }
  });

  it("carries overlap from the previous chunk", () => {
    const text = Array.from(
      { length: 12 },
      (_, i) => `paragraph ${i} ${"filler ".repeat(60)}`,
    ).join("\n\n");
    const chunks = chunkText(text, { target: 500, max: 600, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(2);
    const first = chunks[0] as string;
    const second = chunks[1] as string;
    // The second chunk starts with the tail of the first.
    const tail = first.slice(-60).trim().split(" ").slice(1).join(" ");
    expect(second.startsWith(tail.slice(0, 20))).toBe(true);
  });

  it("hard-cuts pathological unbreakable text at the cap", () => {
    const chunks = chunkText("x".repeat(5000), { target: 1000, max: 1000, overlap: 0 });
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });
});

describe("chunkMarkdown", () => {
  const doc = [
    "# Guide",
    "Intro text before any subheading.",
    "## Setup",
    "### Postgres",
    "Install Postgres seventeen and enable pgvector.",
    "```",
    "# this is a comment inside a code fence, not a heading",
    "```",
    "## Usage",
    "Run the thing.",
  ].join("\n");

  it("prefixes chunks with their heading breadcrumb and records headingPath", () => {
    const chunks = chunkMarkdown(doc);
    const postgres = chunks.find((c) => c.content.includes("pgvector"));
    expect(postgres?.headingPath).toBe("Guide > Setup > Postgres");
    expect(postgres?.content.startsWith("Guide > Setup > Postgres")).toBe(true);

    const usage = chunks.find((c) => c.content.includes("Run the thing"));
    expect(usage?.headingPath).toBe("Guide > Usage");
  });

  it("treats headings inside code fences as content", () => {
    const chunks = chunkMarkdown(doc);
    // The fenced pseudo-heading stays inside the Postgres section, not a new section.
    const postgres = chunks.filter((c) => c.headingPath === "Guide > Setup > Postgres");
    expect(postgres.some((c) => c.content.includes("comment inside a code fence"))).toBe(true);
  });

  it("pops the heading stack on same-or-higher levels", () => {
    const md = "# A\n## B\ntext b\n## C\ntext c";
    const chunks = chunkMarkdown(md);
    expect(chunks.find((c) => c.content.includes("text c"))?.headingPath).toBe("A > C");
  });

  it("handles text before any heading", () => {
    const chunks = chunkMarkdown("plain preamble\n\n# Later");
    expect(chunks[0]?.headingPath).toBeNull();
    expect(chunks[0]?.content).toBe("plain preamble");
  });
});

describe("chunkOutline", () => {
  // The shape of extracted lecture notes: ALL-CAPS title, numbered points with keywords.
  const notes = [
    "GRANICA NIEWŁAŚCIWA FUNKCJI",
    "1. DEFINICJA 1. Niech funkcja f będzie określona w sąsiedztwie S(x0).",
    "Funkcja f ma w punkcie x0 granicę niewłaściwą.",
    "2. DEFINICJA 2. Niech funkcja f będzie określona w sąsiedztwie S(x0).",
    "Prawdziwa jest równość dla ciągów zbieżnych do x0.",
    "3. TWIERDZENIE 1. Niech funkcje f i g będą określone w sąsiedztwie punktu x0.",
  ].join("\n");

  it("chunks one point per chunk under an ALL-CAPS title, even when all would fit in one", () => {
    const chunks = chunkOutline(notes);
    expect(chunks).toHaveLength(3);
    const def2 = chunks.find((c) => c.content.includes("DEFINICJA 2."));
    expect(def2?.headingPath).toBe("GRANICA NIEWŁAŚCIWA FUNKCJI > 2. DEFINICJA 2.");
    expect(def2?.content.startsWith("GRANICA NIEWŁAŚCIWA FUNKCJI > 2. DEFINICJA 2.")).toBe(true);
    // A point's follow-up line stays with its point, never in the next chunk.
    expect(def2?.content).toContain("równość dla ciągów");
    const thm = chunks.find((c) => c.content.includes("TWIERDZENIE 1. Niech funkcje"));
    expect(thm?.headingPath).toBe("GRANICA NIEWŁAŚCIWA FUNKCJI > 3. TWIERDZENIE 1.");
  });

  it("labels bare numbered points (no keyword) with just the number", () => {
    const sheet = ["ZADANIA", "1. Oblicz granicę funkcji.", "2. Wyznacz pole trapezu."].join("\n");
    const chunks = chunkOutline(sheet);
    expect(chunks[0]?.headingPath).toBe("ZADANIA > 1.");
    expect(chunks[1]?.headingPath).toBe("ZADANIA > 2.");
  });

  it("degrades to plain chunking when the text has no outline", () => {
    const prose = "just some ordinary prose without structure of any kind.";
    expect(chunkOutline(prose)).toEqual([{ content: prose, headingPath: null }]);
    // Tiny but unstructured input still ingests — only debris inside structured docs drops.
    expect(chunkOutline("fdsafdsa")).toEqual([{ content: "fdsafdsa", headingPath: null }]);
  });

  it("drops tiny unlabeled debris between points in a structured document", () => {
    const doc = ["x x", "1. Dana jest funkcja określona wzorem.", "2. Oblicz granicę."].join("\n");
    const chunks = chunkOutline(doc);
    expect(chunks.map((c) => c.headingPath)).toEqual(["1.", "2."]);
  });

  it("resets nothing across titles: points bind to the nearest title above", () => {
    const doc = ["TYTUŁ A", "1. Pierwszy punkt.", "TYTUŁ B", "1. Inny pierwszy punkt."].join("\n");
    const chunks = chunkOutline(doc);
    expect(chunks.map((c) => c.headingPath)).toEqual(["TYTUŁ A > 1.", "TYTUŁ B > 1."]);
  });
});
