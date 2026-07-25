import type {
  BlockObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client";
import type { NotionBlockNode, NotionRichText } from "./notion.js";

// Notion blocks to markdown, tuned for an embedding corpus rather than visual fidelity:
// toggles flatten to text (nothing is hidden from recall), tables become pipe rows,
// child pages and databases become reference lines (they sync as their own documents),
// and file-ish blocks keep only their URL. The output feeds the markdown chunker, so
// headings matter: they become chunk boundaries with breadcrumbs.

// The official SDK is a types-only dev dependency: every payload field this renderer
// reads is checked against Notion's published schema at compile time, while the runtime
// stays tolerant of missing fields (API responses are still parsed as loose JSON).
type BlockOf<T extends BlockObjectResponse["type"]> = Extract<BlockObjectResponse, { type: T }>;
type PageProperty = PageObjectResponse["properties"][string];
type PropOf<T extends PageProperty["type"]> = Extract<PageProperty, { type: T }>;
/** Compile-time only: fails the build unless A is assignable to B. */
type Extends<A extends B, B> = A;

// Our rich text subset must stay a supertype of the SDK's full rich text item.
type _RichTextCompatible = Extends<RichTextItemResponse, NotionRichText>;

// Every block type fed through rich() carries rich_text in the official schema.
type RichRead = { rich_text: RichTextItemResponse[] };
type _RichChecks = [
  Extends<BlockOf<"paragraph">["paragraph"], RichRead>,
  Extends<BlockOf<"heading_1">["heading_1"], RichRead>,
  Extends<BlockOf<"heading_2">["heading_2"], RichRead>,
  Extends<BlockOf<"heading_3">["heading_3"], RichRead>,
  Extends<BlockOf<"bulleted_list_item">["bulleted_list_item"], RichRead>,
  Extends<BlockOf<"numbered_list_item">["numbered_list_item"], RichRead>,
  Extends<BlockOf<"to_do">["to_do"], RichRead>,
  Extends<BlockOf<"toggle">["toggle"], RichRead>,
  Extends<BlockOf<"quote">["quote"], RichRead>,
  Extends<BlockOf<"callout">["callout"], RichRead>,
  Extends<BlockOf<"code">["code"], RichRead>,
];

// The media case reads one tolerant shape across eight block types; each official
// payload must remain assignable to it (url on embeds and bookmarks, external/file
// variants on uploads, caption everywhere it exists).
type MediaRead = {
  url?: string;
  external?: { url: string } | null;
  file?: { url: string } | null;
  caption?: RichTextItemResponse[];
};
type _MediaChecks = [
  Extends<BlockOf<"image">["image"], MediaRead>,
  Extends<BlockOf<"video">["video"], MediaRead>,
  Extends<BlockOf<"audio">["audio"], MediaRead>,
  Extends<BlockOf<"pdf">["pdf"], MediaRead>,
  Extends<BlockOf<"file">["file"], MediaRead>,
  Extends<BlockOf<"embed">["embed"], MediaRead>,
  Extends<BlockOf<"bookmark">["bookmark"], MediaRead>,
  Extends<BlockOf<"link_preview">["link_preview"], MediaRead>,
];

export function richTextToMarkdown(parts: NotionRichText[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      let text = part.plain_text ?? "";
      if (!text) return "";
      const a = part.annotations ?? {};
      if (a.code) text = `\`${text}\``;
      if (a.bold) text = `**${text}**`;
      if (a.italic) text = `*${text}*`;
      if (a.strikethrough) text = `~~${text}~~`;
      if (part.href) text = `[${text}](${part.href})`;
      return text;
    })
    .join("");
}

function rich(block: Record<string, unknown>, type: string): string {
  const payload = block[type] as { rich_text?: NotionRichText[] } | undefined;
  return richTextToMarkdown(payload?.rich_text);
}

function indent(text: string, level: number): string {
  if (level === 0 || !text) return text;
  const pad = "  ".repeat(level);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function tableToMarkdown(node: NotionBlockNode): string {
  const table = node.block.table as Partial<BlockOf<"table">["table"]> | undefined;
  const width = table?.table_width ?? 0;
  const rows = node.children
    .filter((child) => child.block.type === "table_row")
    .map((child) => {
      const cells =
        (child.block.table_row as Partial<BlockOf<"table_row">["table_row"]> | undefined)?.cells ??
        [];
      const rendered: string[] = [];
      for (let i = 0; i < Math.max(width, cells.length); i++) {
        rendered.push(richTextToMarkdown(cells[i]).replace(/\|/g, "\\|") || " ");
      }
      return `| ${rendered.join(" | ")} |`;
    });
  if (rows.length === 0) return "";
  const columns = Math.max(width, 1);
  const divider = `| ${Array(columns).fill("---").join(" | ")} |`;
  if (table?.has_column_header && rows.length > 0) {
    return [rows[0], divider, ...rows.slice(1)].join("\n");
  }
  const blankHeader = `| ${Array(columns).fill(" ").join(" | ")} |`;
  return [blankHeader, divider, ...rows].join("\n");
}

function renderNode(node: NotionBlockNode, level: number, listIndex: { n: number }): string {
  const { block } = node;
  const type = block.type;
  const children = () => renderNodes(node.children, level + 1);
  const inlineChildren = () => renderNodes(node.children, level);

  switch (type) {
    case "paragraph": {
      const text = rich(block, type);
      const rest = children();
      return [indent(text, level), rest].filter(Boolean).join("\n");
    }
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const depth = Number(type.slice(-1));
      const text = `${"#".repeat(depth)} ${rich(block, type)}`;
      // A toggleable heading hides children behind the arrow; recall wants them visible.
      const rest = renderNodes(node.children, 0);
      return [text, rest].filter(Boolean).join("\n\n");
    }
    case "bulleted_list_item": {
      const line = indent(`- ${rich(block, type)}`, level);
      const rest = children();
      return [line, rest].filter(Boolean).join("\n");
    }
    case "numbered_list_item": {
      const line = indent(`${listIndex.n++}. ${rich(block, type)}`, level);
      const rest = children();
      return [line, rest].filter(Boolean).join("\n");
    }
    case "to_do": {
      const checked =
        (block.to_do as Partial<BlockOf<"to_do">["to_do"]> | undefined)?.checked === true;
      const line = indent(`- [${checked ? "x" : " "}] ${rich(block, type)}`, level);
      const rest = children();
      return [line, rest].filter(Boolean).join("\n");
    }
    case "toggle": {
      // Flattened: the toggle title as a line, its contents beneath. Nothing stays folded.
      const line = indent(rich(block, type), level);
      const rest = children();
      return [line, rest].filter(Boolean).join("\n");
    }
    case "quote": {
      const body = [rich(block, type), inlineChildren()].filter(Boolean).join("\n");
      return indent(
        body
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
        level,
      );
    }
    case "callout": {
      const iconValue = (block.callout as Partial<BlockOf<"callout">["callout"]> | undefined)?.icon;
      const icon = iconValue && "emoji" in iconValue ? iconValue.emoji : "";
      const body = [`${icon ? `${icon} ` : ""}${rich(block, type)}`, inlineChildren()]
        .filter(Boolean)
        .join("\n");
      return indent(
        body
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
        level,
      );
    }
    case "code": {
      const language = (block.code as Partial<BlockOf<"code">["code"]> | undefined)?.language ?? "";
      return indent(`\`\`\`${language}\n${rich(block, type)}\n\`\`\``, level);
    }
    case "divider":
      return indent("---", level);
    case "equation": {
      const expr =
        (block.equation as Partial<BlockOf<"equation">["equation"]> | undefined)?.expression ?? "";
      return expr ? indent(`$${expr}$`, level) : "";
    }
    case "table":
      return indent(tableToMarkdown(node), level);
    case "child_page": {
      const title =
        (block.child_page as Partial<BlockOf<"child_page">["child_page"]> | undefined)?.title ??
        "Untitled";
      return indent(`Subpage: ${title}`, level);
    }
    case "child_database": {
      const title =
        (block.child_database as Partial<BlockOf<"child_database">["child_database"]> | undefined)
          ?.title ?? "Untitled database";
      return indent(`Database: ${title}`, level);
    }
    case "image":
    case "video":
    case "audio":
    case "pdf":
    case "file":
    case "embed":
    case "bookmark":
    case "link_preview": {
      const payload = block[type] as
        | { url?: string; external?: { url?: string }; file?: { url?: string } }
        | undefined;
      // Notion-hosted files (payload.file.url) sign their URLs with hour-long expiries:
      // hundreds of characters of AWS credential noise that is dead within the hour.
      // Only user-pasted URLs (external, bookmarks, embeds) are worth keeping.
      const url = payload?.url ?? payload?.external?.url ?? "";
      const caption = richTextToMarkdown((block[type] as { caption?: NotionRichText[] })?.caption);
      if (url) return indent(`[${caption || type}](${url})`, level);
      return caption ? indent(caption, level) : "";
    }
    case "column_list":
    case "column":
    case "synced_block":
      // Pure containers: render their contents at the same level.
      return inlineChildren();
    case "table_of_contents":
    case "breadcrumb":
    case "unsupported":
      return "";
    default: {
      // Unknown future types: salvage any rich_text, otherwise skip silently.
      const text = rich(block, type);
      return text ? indent(text, level) : "";
    }
  }
}

function renderNodes(nodes: NotionBlockNode[], level: number): string {
  const lines: string[] = [];
  const listIndex = { n: 1 };
  for (const node of nodes) {
    if (node.block.type !== "numbered_list_item") listIndex.n = 1;
    const rendered = renderNode(node, level, listIndex);
    if (rendered) lines.push(rendered);
  }
  // Nested list lines join tightly; block-level siblings get a blank line at the root.
  return lines.join(level === 0 ? "\n\n" : "\n");
}

/** A page's block tree as one markdown document, title as the h1. */
export function blocksToMarkdown(title: string, nodes: NotionBlockNode[]): string {
  const body = renderNodes(nodes, 0);
  return `# ${title}\n\n${body}`.trim();
}

/** One Notion property value flattened to plain text. */
export function propertyToPlain(prop: Record<string, unknown>): string {
  const type = prop.type as string;
  const value = prop[type];
  switch (type) {
    case "title":
    case "rich_text":
      return richTextToMarkdown(value as NotionRichText[]);
    case "select":
    case "status":
      return (value as PropOf<"select">["select"] | undefined)?.name ?? "";
    case "multi_select":
      return ((value as PropOf<"multi_select">["multi_select"]) ?? [])
        .map((v) => v.name ?? "")
        .join(", ");
    case "date": {
      const date = value as PropOf<"date">["date"] | undefined;
      if (!date?.start) return "";
      return date.end ? `${date.start} to ${date.end}` : date.start;
    }
    case "number":
      return value === null || value === undefined ? "" : String(value);
    case "checkbox":
      return value === true ? "yes" : "no";
    case "url":
    case "email":
    case "phone_number":
      return typeof value === "string" ? value : "";
    case "people":
      // Partial user objects carry no name; they render as empty, same as before.
      return ((value as PropOf<"people">["people"]) ?? [])
        .map((p) => ("name" in p ? (p.name ?? "") : ""))
        .join(", ");
    case "created_time":
    case "last_edited_time":
      return typeof value === "string" ? value : "";
    case "formula": {
      const formula = value as Record<string, unknown> | null;
      return formula ? propertyToPlain({ ...formula, type: formula.type as string }) : "";
    }
    case "relation":
      return `${((value as unknown[]) ?? []).length} linked`;
    default:
      return "";
  }
}

/**
 * A data source as one markdown document: each row a small section titled by its title
 * property, remaining properties as key: value lines. The markdown chunker then gives
 * each row its own chunk under the database's breadcrumb.
 */
export function rowsToMarkdown(name: string, rows: Array<Record<string, unknown>>): string {
  const sections: string[] = [];
  for (const row of rows) {
    const properties = (row.properties ?? {}) as Record<string, Record<string, unknown>>;
    let title = "Untitled";
    const lines: string[] = [];
    for (const [key, prop] of Object.entries(properties)) {
      if (prop?.type === "title") {
        const text = propertyToPlain(prop);
        if (text.trim()) title = text.trim();
        continue;
      }
      const text = propertyToPlain(prop ?? {});
      if (text.trim()) lines.push(`${key}: ${text.trim()}`);
    }
    sections.push([`## ${title}`, ...lines].join("\n"));
  }
  return `# ${name}\n\n${sections.join("\n\n")}`.trim();
}
