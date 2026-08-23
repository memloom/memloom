import type { StorageAdapter } from "./storage.js";
import type { Scope, ScopeNode } from "./types.js";

// The scope registry: hierarchical folders that memories and documents point at
// (PLAN-memory-scopes.md). Everything here is registry mechanics; which rows point where is
// the engine's business. Folders address by path ("personal-life/people"): each segment is
// the slug of a folder name, matched case-insensitively, so renames that only change casing
// or spacing never break saved paths.

/** The two folders every owner has, created lazily on first use. */
export const UNCATEGORIZED = "uncategorized";
export const GLOBAL_SCOPE = "global";

/** The everything-selector: no scope filter at all. */
export const SCOPE_ALL = "*";

export const MAX_TAGS = 16;
export const MAX_TAG_LENGTH = 64;
export const MAX_SCOPE_DEPTH = 6;

/** A folder name as a path segment: trimmed, lowercased, spaces collapsed to dashes. */
export function scopeSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Split a path selector into slugs; throws on an empty or malformed path. */
export function parseScopePath(path: string): string[] {
  const segments = path
    .split("/")
    .map((s) => scopeSlug(s))
    .filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error(`memloom: empty scope path "${path}"`);
  if (segments.length > MAX_SCOPE_DEPTH) {
    throw new Error(`memloom: scope path deeper than ${MAX_SCOPE_DEPTH}: "${path}"`);
  }
  return segments;
}

/**
 * Normalize tags for storage and filtering: trimmed, lowercased, deduped, empties dropped.
 * One canonical form on both sides is what makes the any-match (&&) filter predictable;
 * "AI" and "ai" are the same tag on purpose.
 */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag.length === 0) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(`memloom: tag longer than ${MAX_TAG_LENGTH} chars: "${tag.slice(0, 80)}"`);
    }
    seen.add(tag);
    if (seen.size > MAX_TAGS) throw new Error(`memloom: more than ${MAX_TAGS} tags on one memory`);
  }
  return [...seen];
}

interface ScopeRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  kind: "user" | "system";
  created_at: string;
  updated_at: string;
}

function mapScope(row: ScopeRow): Scope {
  return {
    id: row.id,
    ownerId: row.owner_id,
    parentId: row.parent_id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    createdAt:
      typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
    updatedAt:
      typeof row.updated_at === "string" ? row.updated_at : new Date(row.updated_at).toISOString(),
  };
}

/** Every folder the owner has, one query. The registry is small; callers resolve in memory. */
export async function allScopes(storage: StorageAdapter, owner: string): Promise<Scope[]> {
  const rows = await storage.query<ScopeRow>(
    `SELECT id, owner_id, parent_id, name, description, kind, created_at, updated_at
     FROM memory_scopes WHERE owner_id = $1 ORDER BY lower(name)`,
    [owner],
  );
  return rows.map(mapScope);
}

/**
 * The system folders, created on first use. Insert-if-absent against the sibling unique
 * index, then read back: two concurrent callers race to one row, and neither errors.
 */
export async function ensureSystemScopes(
  storage: StorageAdapter,
  owner: string,
): Promise<{ uncategorizedId: string; globalId: string }> {
  for (const name of [UNCATEGORIZED, GLOBAL_SCOPE]) {
    await storage.query(
      `INSERT INTO memory_scopes (owner_id, name, kind) VALUES ($1, $2, 'system')
       ON CONFLICT DO NOTHING`,
      [owner, name],
    );
  }
  const rows = await storage.query<{ id: string; name: string }>(
    `SELECT id, name FROM memory_scopes
     WHERE owner_id = $1 AND parent_id IS NULL AND kind = 'system' AND name IN ($2, $3)`,
    [owner, UNCATEGORIZED, GLOBAL_SCOPE],
  );
  const uncategorized = rows.find((r) => r.name === UNCATEGORIZED);
  const global = rows.find((r) => r.name === GLOBAL_SCOPE);
  if (!uncategorized || !global) throw new Error("memloom: system scopes failed to seed");
  return { uncategorizedId: uncategorized.id, globalId: global.id };
}

/** Resolve a path to its folder id against an in-memory registry; null when any segment misses. */
export function resolveScopePath(scopes: Scope[], path: string): string | null {
  const segments = parseScopePath(path);
  let parentId: string | null = null;
  let resolved: string | null = null;
  for (const segment of segments) {
    const match = scopes.find((s) => s.parentId === parentId && scopeSlug(s.name) === segment);
    if (!match) return null;
    resolved = match.id;
    parentId = match.id;
  }
  return resolved;
}

/**
 * Resolve a path, creating any missing segments (kind 'user', names as typed). The friendly
 * path behind `memloom scopes add` and the capture mapping; agent-facing writes resolve
 * strictly instead, because agents must not invent folders.
 */
export async function ensureScopePath(
  storage: StorageAdapter,
  owner: string,
  path: string,
): Promise<string> {
  const rawSegments = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const segments = parseScopePath(path);
  let parentId: string | null = null;
  let resolved = "";
  for (let i = 0; i < segments.length; i++) {
    const scopes = await allScopes(storage, owner);
    const segment = segments[i];
    const match = scopes.find((s) => s.parentId === parentId && scopeSlug(s.name) === segment);
    if (match) {
      parentId = match.id;
      resolved = match.id;
      continue;
    }
    const rows: Array<{ id: string }> = await storage.query<{ id: string }>(
      `INSERT INTO memory_scopes (owner_id, parent_id, name) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [owner, parentId, rawSegments[i] ?? segment],
    );
    const inserted: string | undefined = rows[0]?.id;
    if (inserted) {
      parentId = inserted;
      resolved = inserted;
      continue;
    }
    // Lost the insert race: the sibling exists now; re-read and take it.
    const again = await allScopes(storage, owner);
    const winner = again.find((s) => s.parentId === parentId && scopeSlug(s.name) === segment);
    if (!winner) throw new Error(`memloom: scope segment "${segment}" vanished mid-create`);
    parentId = winner.id;
    resolved = winner.id;
  }
  return resolved;
}

/** The display path of one folder ("Personal life > People"), from an in-memory registry. */
export function scopeDisplayPath(scopes: Scope[], id: string): string {
  const byId = new Map(scopes.map((s) => [s.id, s]));
  const parts: string[] = [];
  let cursor = byId.get(id);
  while (cursor) {
    parts.unshift(cursor.name);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    if (parts.length > MAX_SCOPE_DEPTH + 1) break; // corrupt cycle: stop rather than hang
  }
  return parts.join(" > ");
}

/** The slug path of one folder ("personal-life/people"), the addressable form. */
export function scopeSlugPath(scopes: Scope[], id: string): string {
  const byId = new Map(scopes.map((s) => [s.id, s]));
  const parts: string[] = [];
  let cursor = byId.get(id);
  while (cursor) {
    parts.unshift(scopeSlug(cursor.name));
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    if (parts.length > MAX_SCOPE_DEPTH + 1) break;
  }
  return parts.join("/");
}

/** A folder plus every descendant, from an in-memory registry. */
export function subtreeIds(scopes: Scope[], rootId: string): string[] {
  const children = new Map<string | null, Scope[]>();
  for (const s of scopes) {
    const list = children.get(s.parentId) ?? [];
    list.push(s);
    children.set(s.parentId, list);
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    out.push(id);
    for (const child of children.get(id) ?? []) stack.push(child.id);
  }
  return out;
}

/** What a scope selector means for the fuse: an id set + the legacy-NULL flag, or no filter. */
export interface ScopeFilter {
  ids: string[];
  /** True when the set includes 'uncategorized': legacy NULL scope_id rows count as that. */
  includeUnscoped: boolean;
}

/**
 * Expand a recall selector. `"*"` (or undefined) means no filter. A path means: the
 * requested subtree, plus `uncategorized` (memories awaiting classification must not
 * vanish from recall), plus `global` (cross-cutting preferences fire in every scope).
 * Unknown paths throw rather than silently returning nothing: an agent typo'ing a scope
 * should hear about it, not conclude the user has no memories.
 */
export async function expandScopeSelector(
  storage: StorageAdapter,
  owner: string,
  selector: string | undefined,
): Promise<ScopeFilter | null> {
  if (selector === undefined || selector === SCOPE_ALL) return null;
  const { uncategorizedId, globalId } = await ensureSystemScopes(storage, owner);
  const scopes = await allScopes(storage, owner);
  const rootId = resolveScopePath(scopes, selector);
  if (!rootId) {
    const known = scopes
      .filter((s) => s.parentId === null)
      .map((s) => scopeSlug(s.name))
      .join(", ");
    throw new Error(`memloom: unknown scope "${selector}". Top-level scopes: ${known || "none"}`);
  }
  const ids = new Set(subtreeIds(scopes, rootId));
  ids.add(uncategorizedId);
  ids.add(globalId);
  return { ids: [...ids], includeUnscoped: ids.has(uncategorizedId) };
}

/** Build the display tree with per-folder counts, sorted system-first then by name. */
export function buildScopeTree(
  scopes: Scope[],
  counts: Map<string, { memories: number; documents: number }>,
): ScopeNode[] {
  const nodes = new Map<string, ScopeNode>();
  for (const s of scopes) {
    nodes.set(s.id, {
      ...s,
      path: "",
      children: [],
      memories: counts.get(s.id)?.memories ?? 0,
      documents: counts.get(s.id)?.documents ?? 0,
    });
  }
  const roots: ScopeNode[] = [];
  for (const node of nodes.values()) {
    node.path = scopeSlugPath(scopes, node.id);
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const order = (a: ScopeNode, b: ScopeNode) => {
    if (a.kind !== b.kind) return a.kind === "system" ? -1 : 1;
    return a.name.localeCompare(b.name);
  };
  const sortDeep = (list: ScopeNode[]) => {
    list.sort(order);
    for (const n of list) sortDeep(n.children);
  };
  sortDeep(roots);
  return roots;
}

/** Would moving `id` under `newParentId` create a cycle? (A folder under its own descendant.) */
export function wouldCycle(scopes: Scope[], id: string, newParentId: string | null): boolean {
  if (newParentId === null) return false;
  if (newParentId === id) return true;
  return subtreeIds(scopes, id).includes(newParentId);
}
