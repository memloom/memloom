import { createInterface } from "node:readline/promises";
import type {
  MemoryEngine,
  NotionListedPage,
  NotionScope,
  NotionSyncEvent,
  NotionSyncResult,
} from "@memloom/core";

// `memloom notion ...`: the CLI face of the Notion connector. The daemon holds the token
// (NOTION_TOKEN in its environment), does the fetching, and owns the watermarks; this
// module renders listings, collects the selection, and prints sync progress.

export const NOTION_USAGE =
  "usage: memloom notion <connect|sync|status|disconnect>\n" +
  "  connect     [--page <id-or-title> ...] [--all]   pick what to sync (interactive without flags)\n" +
  "  sync        [--dry-run] [--force]                sync the selection now\n" +
  "  status                                           token, selection, last sync, documents\n" +
  "  disconnect                                       clear the selection (synced documents stay)";

const TOKEN_HINT =
  "The daemon needs NOTION_TOKEN. Create an internal integration at\n" +
  "notion.so/profile/integrations, open your page's menu, Connections, add the\n" +
  "integration, then restart the daemon with NOTION_TOKEN set.";

function formatWhen(iso: string): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

/** One renderable row of the listing tree: the item, its indent depth, collapsed rows. */
export interface ListingRow {
  item: NotionListedPage;
  depth: number;
  /** Row-pages folded into this database entry (0 for pages). */
  rows: number;
}

/**
 * The listing as a tree flattened for display. Children indent under their parent;
 * database row-pages are NOT rendered individually (syncing the database captures them),
 * they only bump their data source's `rows` count. A page nested inside a collapsed row
 * surfaces at top level rather than disappearing with it.
 */
export function flattenListing(listing: NotionListedPage[]): ListingRow[] {
  const byId = new Map(listing.map((i) => [i.id, i]));
  const isRow = (item: NotionListedPage) =>
    item.parentType === "data_source" && item.parentId !== null && byId.has(item.parentId);
  const rowCounts = new Map<string, number>();
  const children = new Map<string, NotionListedPage[]>();
  const roots: NotionListedPage[] = [];
  for (const item of listing) {
    if (isRow(item)) {
      rowCounts.set(item.parentId as string, (rowCounts.get(item.parentId as string) ?? 0) + 1);
      continue;
    }
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (parent && !isRow(parent)) {
      const list = children.get(parent.id);
      if (list) list.push(item);
      else children.set(parent.id, [item]);
    } else {
      roots.push(item);
    }
  }
  const out: ListingRow[] = [];
  const seen = new Set<string>();
  const walk = (item: NotionListedPage, depth: number) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push({ item, depth, rows: rowCounts.get(item.id) ?? 0 });
    for (const child of children.get(item.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

function listingLine(row: ListingRow, index: number): string {
  const { item, depth, rows } = row;
  const kind =
    item.object === "data_source"
      ? `database${rows > 0 ? `, ${rows} row${rows === 1 ? "" : "s"}` : ""}`
      : "page";
  const mark = item.selected ? "*" : " ";
  const indent = "  ".repeat(depth);
  return `${String(index + 1).padStart(3)}. ${mark} ${indent}${item.title}  (${kind}, edited ${formatWhen(item.lastEdited)})`;
}

/** "1,3-5" style selection over a 1-based list; "all" selects everything. */
export function parseSelection(input: string, count: number): number[] | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "all") return Array.from({ length: count }, (_, i) => i);
  const picked = new Set<number>();
  for (const part of trimmed.split(",")) {
    const range = part.trim();
    if (!range) continue;
    const dash = range.indexOf("-", 1);
    if (dash > 0) {
      const from = Number(range.slice(0, dash));
      const to = Number(range.slice(dash + 1));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > count || from > to) {
        return null;
      }
      for (let i = from; i <= to; i++) picked.add(i - 1);
    } else {
      const n = Number(range);
      if (!Number.isInteger(n) || n < 1 || n > count) return null;
      picked.add(n - 1);
    }
  }
  return picked.size > 0 ? [...picked].sort((a, b) => a - b) : null;
}

/** Match --page values against the listing: exact id first, then title substring. */
export function matchPages(
  listing: NotionListedPage[],
  wanted: string[],
): { matched: NotionListedPage[]; missing: string[] } {
  const matched = new Map<string, NotionListedPage>();
  const missing: string[] = [];
  for (const want of wanted) {
    const byId = listing.find((item) => item.id === want);
    if (byId) {
      matched.set(byId.id, byId);
      continue;
    }
    const byTitle = listing.filter((item) => item.title.toLowerCase().includes(want.toLowerCase()));
    if (byTitle.length === 1 && byTitle[0]) matched.set(byTitle[0].id, byTitle[0]);
    else missing.push(want);
  }
  return { matched: [...matched.values()], missing };
}

export async function runNotionConnect(engine: MemoryEngine, args: string[]): Promise<void> {
  const wanted: string[] = [];
  let all = false;
  const words = [...args];
  while (words.length > 0) {
    const word = words.shift() as string;
    if (word === "--all") all = true;
    else if (word === "--page" || word.startsWith("--page=")) {
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words.shift();
      if (!value) throw new Error("--page needs a value (a page id or a title)");
      wanted.push(value);
    } else throw new Error(`unknown flag ${word}. ${NOTION_USAGE}`);
  }

  let listing: NotionListedPage[];
  try {
    listing = await engine.notionListPages();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("NOTION_TOKEN")) throw new Error(TOKEN_HINT);
    throw err;
  }
  if (listing.length === 0) {
    console.log(
      "The integration cannot see any pages yet. Open a page in Notion, menu, " +
        "Connections, add your integration, then re-run. Just shared it? Notion's " +
        "search index can lag a minute.",
    );
    return;
  }

  // The picker shows the tree: subpages and databases indent under their parent, and
  // database row-pages collapse into their database's "N rows" (syncing the database
  // captures every row; a specific row-page is still reachable via --page).
  const tree = flattenListing(listing);
  let chosen: NotionListedPage[];
  if (all) {
    chosen = tree.map((row) => row.item);
  } else if (wanted.length > 0) {
    const { matched, missing } = matchPages(listing, wanted);
    if (missing.length > 0) {
      console.log("visible to the integration:");
      for (const [i, row] of tree.entries()) console.log(listingLine(row, i));
      throw new Error(
        `no unique match for: ${missing.join(", ")}. Use the exact title, a longer fragment, or the id.`,
      );
    }
    chosen = matched;
  } else {
    console.log("visible to the integration (* = currently selected):\n");
    for (const [i, row] of tree.entries()) console.log(listingLine(row, i));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question("\nselect pages to sync (e.g. 1,3-5 or all): ");
      const picked = parseSelection(answer, tree.length);
      if (!picked) throw new Error("nothing selected; selection unchanged.");
      chosen = picked
        .map((i) => tree[i]?.item)
        .filter((item): item is NotionListedPage => item !== undefined);
    } finally {
      rl.close();
    }
  }

  const scope: NotionScope = {
    items: chosen.map((item) => ({ id: item.id, object: item.object, title: item.title })),
  };
  await engine.setNotionScope(scope);
  console.log(`\nsyncing ${chosen.length} item${chosen.length === 1 ? "" : "s"}:`);
  for (const item of chosen) console.log(`  ${item.title}`);
  console.log("\nthe daemon polls for edits every 5 minutes; sync now with: memloom notion sync");
}

function truncNote(e: NotionSyncEvent): string {
  return e.truncated
    ? "  TRUNCATED: the page is over the block cap, its newest content was not synced"
    : "";
}

/** "; refetched 2 of 494 sections" when the sync used the cached tree, empty otherwise. */
function incrementalNote(e: NotionSyncEvent): string {
  return e.refetched !== undefined && e.sections !== undefined
    ? `; refetched ${e.refetched} of ${e.sections} sections`
    : "";
}

function syncLine(e: NotionSyncEvent): string {
  const label = `[${e.index}/${e.total}] ${e.title}`;
  switch (e.outcome) {
    case "waiting":
      return "another sync is already running (the daemon noticed the edit first); waiting for it, then running yours...";
    case "fetching":
      return e.chunks > 0
        ? `${label}  ->  still fetching (${e.chunks} blocks so far)`
        : `${label}  ->  fetching from Notion (only sections with edits are re-downloaded; the first sync of a long page takes a few minutes)`;
    case "fresh":
      return `${label}  ->  no edits since last sync`;
    case "would-sync":
      return `${label}  ->  would sync`;
    case "unchanged":
      return `${label}  ->  fetched, content identical (${e.chunks} chunks kept${incrementalNote(e)})${truncNote(e)}`;
    case "added":
      return `${label}  ->  synced (${e.chunks} chunks)${truncNote(e)}`;
    case "updated":
      return `${label}  ->  updated (${e.chunks} chunks${incrementalNote(e)})${truncNote(e)}`;
    case "error":
      return `${label}  ->  FAILED: ${e.error}`;
  }
}

export async function runNotionSync(engine: MemoryEngine, args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const unknown = args.find((a) => a !== "--dry-run" && a !== "--force");
  if (unknown) throw new Error(`unknown flag ${unknown}. ${NOTION_USAGE}`);

  console.log("checking Notion for changes...");
  let result: NotionSyncResult;
  try {
    result = await engine.notionSync({ dryRun, force, wait: true }, (e) =>
      console.log(syncLine(e)),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("NOTION_TOKEN")) throw new Error(TOKEN_HINT);
    throw err;
  }

  const parts = [
    result.added > 0 ? `${result.added} new` : "",
    result.updated > 0 ? `${result.updated} updated` : "",
    result.unchanged > 0 ? `${result.unchanged} unchanged` : "",
    result.fresh > 0 ? `${result.fresh} already fresh` : "",
    result.errors > 0 ? `${result.errors} FAILED` : "",
  ].filter(Boolean);
  console.log(
    result.dryRun
      ? `\ndry run over ${result.items} selected item${result.items === 1 ? "" : "s"}; nothing written.`
      : `\n${result.items} item${result.items === 1 ? "" : "s"}: ${parts.join(", ") || "nothing to do"}`,
  );
  if (result.truncated > 0) {
    console.log(
      `${result.truncated} item${result.truncated === 1 ? " was" : "s were"} truncated at the ` +
        "block cap; consider splitting very large pages into subpages and syncing those.",
    );
  }
  if (result.error) console.log(`last failure: ${result.error}`);
}

export async function runNotionStatus(engine: MemoryEngine): Promise<void> {
  const status = await engine.notionStatus();
  console.log(
    `token       ${status.tokenPresent ? "present in daemon environment" : "NOT SET (set NOTION_TOKEN and restart the daemon)"}`,
  );
  const scope =
    status.scope === null
      ? "nothing selected (memloom notion connect to choose)"
      : `${status.scope.items.length} item${status.scope.items.length === 1 ? "" : "s"}: ${status.scope.items
          .map((i) => i.title)
          .join(", ")}`;
  console.log(`selection   ${scope}`);
  console.log(
    `last sync   ${status.lastSyncAt ?? "never"}${status.lastSyncError ? `  FAILED: ${status.lastSyncError}` : ""}${status.syncing ? "  (a sync is running right now)" : ""}`,
  );
  console.log(`documents   ${status.documents} synced, ${status.chunks} chunks recallable`);
}

export async function runNotionDisconnect(engine: MemoryEngine): Promise<void> {
  await engine.setNotionScope(null);
  console.log("selection cleared; the daemon stops polling. Synced documents stay");
  console.log("(remove them in the viewer if you want them gone).");
}
