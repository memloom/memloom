import { describe, expect, it } from "vitest";
import type { NotionBlockNode } from "./notion.js";
import {
  blocksToMarkdown,
  propertyToPlain,
  richTextToMarkdown,
  rowsToMarkdown,
} from "./notion-markdown.js";

// The block-to-markdown contract: recall must see everything a diary page holds, so
// toggles flatten, checked state survives, tables become pipe rows, and child pages stay
// references instead of swallowing subtrees.

function text(content: string, annotations = {}, href: string | null = null) {
  return { plain_text: content, annotations, href };
}

function node(
  type: string,
  payload: Record<string, unknown>,
  children: NotionBlockNode[] = [],
): NotionBlockNode {
  return {
    block: { id: `id-${type}-${Math.abs(JSON.stringify(payload).length)}`, type, [type]: payload },
    children,
  };
}

describe("richTextToMarkdown", () => {
  it("applies annotations and links", () => {
    expect(
      richTextToMarkdown([
        text("plain "),
        text("bold", { bold: true }),
        text(" and "),
        text("code", { code: true }),
        text(" and ", {}),
        text("a link", {}, "https://example.com"),
      ]),
    ).toBe("plain **bold** and `code` and [a link](https://example.com)");
  });

  it("survives missing input", () => {
    expect(richTextToMarkdown(undefined)).toBe("");
  });
});

describe("blocksToMarkdown", () => {
  it("renders a diary-shaped page: toggles flattened, to_dos with state, code fenced", () => {
    const md = blocksToMarkdown("Personal Diary", [
      node("toggle", { rich_text: [text("June 14, 2026")] }, [
        node("paragraph", { rich_text: [text("Finished the UI, now the pricing page.")] }),
        node("to_do", { rich_text: [text("update pricing")], checked: true }),
        node("to_do", { rich_text: [text("update docs")], checked: false }),
        node("code", { rich_text: [text("pnpm build")], language: "bash" }),
      ]),
    ]);
    expect(md).toContain("# Personal Diary");
    expect(md).toContain("June 14, 2026");
    // The toggle's content is visible, indented beneath its title line.
    expect(md).toContain("  Finished the UI, now the pricing page.");
    expect(md).toContain("  - [x] update pricing");
    expect(md).toContain("  - [ ] update docs");
    expect(md).toContain("```bash");
    expect(md).toContain("pnpm build");
  });

  it("renders headings, lists with numbering, quotes, and dividers", () => {
    const md = blocksToMarkdown("Notes", [
      node("heading_2", { rich_text: [text("Plan")] }),
      node("numbered_list_item", { rich_text: [text("first")] }),
      node("numbered_list_item", { rich_text: [text("second")] }),
      node("paragraph", { rich_text: [text("a break")] }),
      node("numbered_list_item", { rich_text: [text("restarts")] }),
      node("bulleted_list_item", { rich_text: [text("a bullet")] }),
      node("quote", { rich_text: [text("a quote")] }),
      node("divider", {}),
    ]);
    expect(md).toContain("## Plan");
    expect(md).toContain("1. first");
    expect(md).toContain("2. second");
    // Numbering restarts after a non-list block, like Notion renders it.
    expect(md).toContain("1. restarts");
    expect(md).toContain("- a bullet");
    expect(md).toContain("> a quote");
    expect(md).toContain("---");
  });

  it("renders a table with a column header", () => {
    const row = (cells: string[]) => ({
      block: {
        id: cells.join("-"),
        type: "table_row",
        table_row: { cells: cells.map((c) => [text(c)]) },
      },
      children: [],
    });
    const md = blocksToMarkdown("T", [
      {
        block: { id: "t", type: "table", table: { table_width: 2, has_column_header: true } },
        children: [row(["Name", "State"]), row(["import", "shipped"])],
      },
    ]);
    expect(md).toContain("| Name | State |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| import | shipped |");
  });

  it("keeps child pages and databases as references, containers transparent", () => {
    const md = blocksToMarkdown("Root", [
      node("column_list", {}, [
        node("column", {}, [node("paragraph", { rich_text: [text("inside a column")] })]),
      ]),
      node("child_page", { title: "Sub Page" }),
      node("child_database", { title: "Tasks" }),
      node("unsupported", {}),
    ]);
    expect(md).toContain("inside a column");
    expect(md).toContain("Subpage: Sub Page");
    expect(md).toContain("Database: Tasks");
  });

  it("keeps user-pasted URLs, drops expiring Notion-hosted file URLs", () => {
    const md = blocksToMarkdown("Media", [
      node("bookmark", { url: "https://example.com/post" }),
      node("image", {
        external: { url: "https://example.com/pic.png" },
        caption: [text("the chart")],
      }),
      node("image", {
        file: {
          url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/x?X-Amz-Credential=SECRETISH",
        },
        caption: [text("screenshot of the day")],
      }),
      node("image", {
        file: { url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/y?X-Amz-Signature=zzz" },
      }),
    ]);
    expect(md).toContain("[bookmark](https://example.com/post)");
    expect(md).toContain("[the chart](https://example.com/pic.png)");
    // The signed URL is gone; the caption survives as plain text.
    expect(md).toContain("screenshot of the day");
    expect(md).not.toContain("amazonaws");
    expect(md).not.toContain("X-Amz");
  });

  it("toggleable headings keep their hidden children visible", () => {
    const md = blocksToMarkdown("H", [
      node("heading_3", { rich_text: [text("Hidden section")], is_toggleable: true }, [
        node("paragraph", { rich_text: [text("the buried note")] }),
      ]),
    ]);
    expect(md).toContain("### Hidden section");
    expect(md).toContain("the buried note");
  });
});

describe("rowsToMarkdown and properties", () => {
  it("flattens rows to titled sections with key: value lines", () => {
    const md = rowsToMarkdown("Reading list", [
      {
        properties: {
          Name: { type: "title", title: [text("The Idea Factory")] },
          Status: { type: "status", status: { name: "Reading" } },
          Tags: { type: "multi_select", multi_select: [{ name: "history" }, { name: "tech" }] },
          Done: { type: "checkbox", checkbox: false },
          Started: { type: "date", date: { start: "2026-07-01" } },
          Empty: { type: "rich_text", rich_text: [] },
        },
      },
    ]);
    expect(md).toContain("# Reading list");
    expect(md).toContain("## The Idea Factory");
    expect(md).toContain("Status: Reading");
    expect(md).toContain("Tags: history, tech");
    expect(md).toContain("Done: no");
    expect(md).toContain("Started: 2026-07-01");
    expect(md).not.toContain("Empty:");
  });

  it("flattens formula and relation properties", () => {
    expect(propertyToPlain({ type: "formula", formula: { type: "number", number: 7 } })).toBe("7");
    expect(propertyToPlain({ type: "relation", relation: [{}, {}] })).toBe("2 linked");
  });
});
