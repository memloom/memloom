// Minimal Notion API client for the connector: token auth, global request spacing to
// respect the ~3 requests/second integration limit, Retry-After on 429, cursor pagination.
// Read-only: search, page metadata, block trees, data source schema and rows. The token
// is an opaque string (ntn_ or legacy secret_ prefix); never validated beyond presence.

import type { BlockObjectResponse } from "@notionhq/client";

const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2025-09-03";

/** Spacing between requests. 350ms keeps a long sync just under Notion's 3 rps average. */
const REQUEST_GAP_MS = 350;
const MAX_RETRIES = 3;

/** Search stops after this many results: nobody hand-picks from thousands of pages. */
const MAX_LISTED = 500;

/**
 * Recursion guards for block trees. The block cap must fit real pages: a daily diary is
 * ~10 blocks per day, so 20000 covers several years. Hitting it is REPORTED (the tree
 * comes back marked truncated), never silent: a capped diary looks complete otherwise.
 */
const MAX_BLOCK_DEPTH = 12;
const MAX_BLOCKS_PER_PAGE = 20_000;

export interface NotionRichText {
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
}

/**
 * One block as the API returns it. Typed loosely: responses are parsed as untrusted
 * JSON, and the renderer narrows per type. The assertion below keeps this shape a
 * supertype of the official SDK union, so it can never drift from the real API.
 */
export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

type _Extends<A extends B, B> = A;
type _BlockCompatible = _Extends<BlockObjectResponse, NotionBlock>;

/** A block with its fetched children: the unit notion-markdown renders. */
export interface NotionBlockNode {
  block: NotionBlock;
  children: NotionBlockNode[];
}

/** One entry from search: everything shared with the integration. */
export interface NotionListedItem {
  id: string;
  object: "page" | "data_source";
  title: string;
  lastEdited: string;
  url: string | null;
  /** Another listed item this one lives under, or null (top level, or parent not visible). */
  parentId: string | null;
  /** What parentId points at; "data_source" means this page is a database row. */
  parentType: "page" | "data_source" | null;
}

interface SearchResponse {
  results: Array<Record<string, unknown>>;
  has_more: boolean;
  next_cursor: string | null;
}

interface ChildrenResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The title property of a page object (the property whose type is "title"). */
export function pageTitle(page: Record<string, unknown>): string {
  const properties = (page.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const prop of Object.values(properties)) {
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = (prop.title as NotionRichText[]).map((t) => t.plain_text).join("");
      if (text.trim()) return text.trim();
    }
  }
  return "Untitled";
}

/**
 * Whether the tree walk descends into this block. child_page and child_database stay
 * leaves: they sync as their own documents when selected, never inlined into the parent.
 */
export function expandsInline(block: NotionBlock): boolean {
  return (
    block.has_children === true && block.type !== "child_page" && block.type !== "child_database"
  );
}

export function dataSourceTitle(item: Record<string, unknown>): string {
  if (typeof item.name === "string" && item.name.trim()) return item.name.trim();
  if (Array.isArray(item.title)) {
    const text = (item.title as NotionRichText[]).map((t) => t.plain_text).join("");
    if (text.trim()) return text.trim();
  }
  return "Untitled database";
}

export class NotionClient {
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  #lastRequestAt = 0;

  constructor(token: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.#lastRequestAt + REQUEST_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.#lastRequestAt = Date.now();

      const response = await this.#fetch(`${NOTION_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Notion-Version": NOTION_VERSION,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (response.status === 429 || response.status === 529) {
        if (attempt >= MAX_RETRIES) throw new Error(`Notion API rate limited (${response.status})`);
        const retryAfter = Number(response.headers.get("retry-after")) || 1;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!response.ok) {
        let detail = "";
        try {
          const parsed = (await response.json()) as { message?: string; code?: string };
          detail = parsed.message || parsed.code || "";
        } catch {
          // no JSON body; the status alone will have to do
        }
        throw new Error(`Notion API ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      return (await response.json()) as T;
    }
  }

  /**
   * Everything shared with the integration, newest edit first. Search is eventually
   * consistent: a page shared seconds ago can be missing, so "connect" output tells the
   * user to re-run if a page they just shared is absent.
   */
  async listShared(): Promise<NotionListedItem[]> {
    const items: NotionListedItem[] = [];
    // Raw parent per item; resolved to listing-relative parentId/parentType afterwards.
    const rawParent = new Map<string, { type: string; id: string }>();
    let cursor: string | null = null;
    do {
      const page: SearchResponse = await this.#request<SearchResponse>("POST", "/search", {
        sort: { timestamp: "last_edited_time", direction: "descending" },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const result of page.results) {
        const object = result.object as string;
        if (object !== "page" && object !== "data_source") continue;
        const id = String(result.id);
        items.push({
          id,
          object,
          title: object === "page" ? pageTitle(result) : dataSourceTitle(result),
          lastEdited: String(result.last_edited_time ?? ""),
          url: typeof result.url === "string" ? result.url : null,
          parentId: null,
          parentType: null,
        });
        const parent = result.parent as Record<string, unknown> | undefined;
        const type = typeof parent?.type === "string" ? parent.type : "";
        const parentRef = typeof parent?.[type] === "string" ? String(parent[type]) : "";
        if (type && parentRef) rawParent.set(id, { type, id: parentRef });
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor && items.length < MAX_LISTED);

    // A data source's parent is its database CONTAINER, whose id is not in the listing;
    // one lookup per distinct database resolves the page the database actually sits on.
    // Same lookup maps a row that reports a database_id parent onto the listed data source.
    const byId = new Map(items.map((i) => [i.id, i]));
    const databaseCache = new Map<string, Record<string, unknown> | null>();
    const database = async (databaseId: string) => {
      if (!databaseCache.has(databaseId)) {
        databaseCache.set(
          databaseId,
          await this.#request<Record<string, unknown>>("GET", `/databases/${databaseId}`).catch(
            () => null,
          ),
        );
      }
      return databaseCache.get(databaseId) ?? null;
    };
    for (const item of items) {
      const parent = rawParent.get(item.id);
      if (!parent) continue;
      let candidate: string | null = null;
      if (parent.type === "page_id" || parent.type === "data_source_id") {
        candidate = parent.id;
      } else if (parent.type === "database_id") {
        const db = await database(parent.id);
        if (item.object === "data_source") {
          // The data source nests where its database container lives.
          const dbParent = db?.parent as Record<string, unknown> | undefined;
          candidate = typeof dbParent?.page_id === "string" ? dbParent.page_id : null;
        } else {
          // A row page under a database container: attach to its listed data source.
          const sources = Array.isArray(db?.data_sources) ? db.data_sources : [];
          const first = sources[0] as Record<string, unknown> | undefined;
          candidate = typeof first?.id === "string" ? first.id : null;
        }
      }
      // block_id and workspace parents stay top level: resolving the ancestor page would
      // cost a fetch chain per item for a purely cosmetic nesting.
      const listedParent = candidate ? byId.get(candidate) : undefined;
      if (listedParent) {
        item.parentId = listedParent.id;
        item.parentType = listedParent.object;
      }
    }
    return items;
  }

  async page(pageId: string): Promise<Record<string, unknown>> {
    return this.#request("GET", `/pages/${pageId}`);
  }

  /**
   * The full block tree of a page (or any block), children fetched recursively.
   * child_page and child_database blocks are kept as leaves: inlining them would swallow
   * whole subtrees into one document; they sync as their own documents when selected.
   * `onProgress` reports blocks fetched so far: at ~3 requests/second a long page takes
   * minutes, and silence reads as a hang.
   */
  async blockTree(
    blockId: string,
    onProgress?: (blocksFetched: number) => void,
  ): Promise<{ nodes: NotionBlockNode[]; truncated: boolean }> {
    const budget = { blocks: MAX_BLOCKS_PER_PAGE, fetched: 0, onProgress };
    const nodes = await this.#children(blockId, 0, budget);
    return { nodes, truncated: budget.blocks <= 0 };
  }

  /**
   * Direct children of a block, one level deep, children NOT fetched. This is the cheap
   * half of incremental sync: a page of hundreds of day-sections lists in a handful of
   * requests, and each child's last_edited_time says whether its subtree needs refetching
   * (Notion bumps every ancestor when a nested block changes, so a section whose
   * timestamp is unchanged since the cached sync cannot contain a new edit).
   */
  async blockChildrenList(
    blockId: string,
    onProgress?: (blocksFetched: number) => void,
  ): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const page: ChildrenResponse = await this.#request<ChildrenResponse>(
        "GET",
        `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      );
      blocks.push(...page.results);
      onProgress?.(blocks.length);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor && blocks.length < MAX_BLOCKS_PER_PAGE);
    return blocks;
  }

  async #children(
    blockId: string,
    depth: number,
    budget: {
      blocks: number;
      fetched: number;
      onProgress?: (blocksFetched: number) => void;
    },
  ): Promise<NotionBlockNode[]> {
    if (depth >= MAX_BLOCK_DEPTH || budget.blocks <= 0) return [];
    const nodes: NotionBlockNode[] = [];
    let cursor: string | null = null;
    do {
      const page: ChildrenResponse = await this.#request<ChildrenResponse>(
        "GET",
        `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      );
      budget.fetched += page.results.length;
      budget.onProgress?.(budget.fetched);
      for (const block of page.results) {
        if (budget.blocks-- <= 0) return nodes;
        nodes.push({
          block,
          children: expandsInline(block) ? await this.#children(block.id, depth + 1, budget) : [],
        });
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return nodes;
  }

  async dataSource(dataSourceId: string): Promise<Record<string, unknown>> {
    return this.#request("GET", `/data_sources/${dataSourceId}`);
  }

  /** All rows of a data source, in the source's default order. */
  async dataSourceRows(dataSourceId: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const page: SearchResponse = await this.#request<SearchResponse>(
        "POST",
        `/data_sources/${dataSourceId}/query`,
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      rows.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return rows;
  }
}
