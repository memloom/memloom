import { describe, expect, it } from "vitest";
import { chunkMarkdown, chunkText } from "./chunker.js";

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
