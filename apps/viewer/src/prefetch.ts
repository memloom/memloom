// A tiny read-through cache behind every tab's data.
//
// Tab views mount fresh on every visit, and a component that starts at null shows
// "loading" for a round trip even when the daemon answers in milliseconds. Two changes
// make switching feel instant: hovering a header tab starts its fetches before the click
// lands, and a view's first render seeds from whatever this cache already holds, showing
// data immediately and revalidating behind it. No library: a Map, a TTL, and promise
// dedup are the entire mechanism.

interface Entry {
  at: number;
  promise: Promise<unknown>;
  /** Set once the promise resolves; what cachedData serves for instant first paint. */
  data?: unknown;
}

const cache = new Map<string, Entry>();

/**
 * Within this window a repeat call reuses the same promise, so hover-prefetch and the
 * view's own mount fetch cost one request between them. Past it, a call starts a fresh
 * request while cachedData keeps serving the stale copy: stale-while-revalidate.
 */
const FRESH_MS = 15_000;

export function prefetch<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise as Promise<T>;
  const entry: Entry = {
    at: Date.now(),
    promise: load().then((data) => {
      entry.data = data;
      return data;
    }),
  };
  entry.promise.catch(() => {
    // A failed fetch must not become the cached answer for the next 15 seconds; the
    // caller sees the rejection, the cache forgets it happened. A previously resolved
    // entry is only ever replaced by a successful refresh (the new entry landed already,
    // so delete only if it is still ours).
    if (cache.get(key) === entry) cache.delete(key);
  });
  cache.set(key, entry);
  return entry.promise as Promise<T>;
}

/** The last resolved value at any age, or null: the seed for a view's first render. */
export function cachedData<T>(key: string): T | null {
  const hit = cache.get(key);
  return hit && hit.data !== undefined ? (hit.data as T) : null;
}

/**
 * Record a value the caller already knows is current, without a request. For the mutations
 * whose response IS the new state (a settings PATCH answers with the saved settings): busting
 * the key instead would leave the next visit seeding from the pre-edit copy and flipping a
 * toggle back under the user for one frame.
 */
export function seed<T>(key: string, data: T): void {
  cache.set(key, { at: Date.now(), promise: Promise.resolve(data), data });
}

/** Bust and reload: what a mutation calls so its own refresh cannot serve the pre-edit copy. */
export function refetch<T>(key: string, load: () => Promise<T>): Promise<T> {
  cache.delete(key);
  return prefetch(key, load);
}
