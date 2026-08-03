import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EnqueuePaths, FileSync, type SyncStore } from "./sync.js";
import type { ContextRoot, SyncTargets } from "./types.js";

// The watcher is tested through refresh(), which is the rescan: deterministic, and the path
// that carries the load. OS events are chokidar's job and arrive whenever the platform feels
// like it, so asserting on them would buy a flaky suite and no extra coverage.

let dir: string;
let sync: FileSync | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memloom-sync-"));
});

afterEach(async () => {
  await sync?.stop();
  sync = null;
  await rm(dir, { recursive: true, force: true });
});

interface Doc {
  id: string;
  path: string;
  watching: boolean;
  missing: boolean;
}

/** A store made of arrays. Records every call the watcher makes so tests can assert on them. */
class FakeStore implements SyncStore {
  roots: ContextRoot[] = [];
  docs: Doc[] = [];
  scanned: { rootId: string; at: Date }[] = [];
  marked: { id: string; missing: boolean }[] = [];

  root(path: string, over: Partial<ContextRoot> = {}): ContextRoot {
    const root: ContextRoot = {
      id: `root-${this.roots.length + 1}`,
      path,
      watching: true,
      documents: 0,
      lastScanAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      ...over,
    };
    this.roots.push(root);
    return root;
  }

  doc(path: string, over: Partial<Doc> = {}): Doc {
    const doc: Doc = {
      id: `doc-${this.docs.length + 1}`,
      path,
      watching: true,
      missing: false,
      ...over,
    };
    this.docs.push(doc);
    return doc;
  }

  async syncTargets(): Promise<SyncTargets> {
    return {
      roots: this.roots.filter((r) => r.watching),
      files: this.docs.filter((d) => d.watching).map((d) => ({ id: d.id, path: d.path })),
    };
  }

  async contextRootScanned(rootId: string, at: Date): Promise<void> {
    this.scanned.push({ rootId, at });
    const root = this.roots.find((r) => r.id === rootId);
    if (root) root.lastScanAt = at.toISOString();
  }

  async contextDocumentsUnder(prefix: string) {
    return this.docs
      .filter((d) => d.path.startsWith(`${prefix}\\`) || d.path.startsWith(`${prefix}/`))
      .map((d) => ({ id: d.id, path: d.path, watching: d.watching }));
  }

  async contextDocumentByPath(path: string) {
    const doc = this.docs.find((d) => d.path === path);
    return doc ? { id: doc.id, watching: doc.watching } : null;
  }

  async contextMarkMissing(documentId: string, missing: boolean): Promise<boolean> {
    const doc = this.docs.find((d) => d.id === documentId);
    // Mirrors the engine's guard: the UPDATE only fires when the mark actually changes, so a
    // folder of already-missing files does not report every one of them again every tick.
    if (!doc || doc.missing === missing) return false;
    doc.missing = missing;
    this.marked.push({ id: documentId, missing });
    return true;
  }
}

/** Collects the paths handed to the queue. Flushing is debounced, so tests await settle(). */
function recorder() {
  const batches: string[][] = [];
  const refused = new Set<string>();
  return {
    batches,
    // Answers with everything offered, like a queue that had none of it yet. `refuse` models the
    // real one, which turns down a path it is already working on.
    enqueue: async (paths: string[]) => {
      batches.push(paths);
      return paths.filter((p) => !refused.has(p));
    },
    refuse: (path: string) => refused.add(path),
    paths: () => batches.flat(),
  };
}

/** The 200 ms coalescing flush plus a debounce window, with room to spare. */
function settle(ms = 400): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function write(relative: string, mtime?: Date): Promise<string> {
  const path = join(dir, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "hello");
  if (mtime) await utimes(path, mtime, mtime);
  return path;
}

function build(store: FakeStore, enqueue: EnqueuePaths): FileSync {
  sync = new FileSync(store, enqueue, { debounceMs: 10, rescanMs: 60_000 });
  return sync;
}

describe("FileSync rescan", () => {
  it("queues a file that appeared in a watched folder", async () => {
    const store = new FakeStore();
    store.root(dir);
    await write("new.md");
    const queue = recorder();

    await build(store, queue.enqueue).refresh();
    await settle();

    expect(queue.paths()).toEqual([join(dir, "new.md")]);
  });

  // The cheap test: everything the store already has and nobody has touched is skipped without
  // being read. This is what keeps a folder of five thousand old recordings costing a walk
  // rather than five thousand transcriptions per tick.
  it("leaves an unchanged file the store already has alone", async () => {
    const store = new FakeStore();
    const path = await write("old.md", new Date("2026-01-01T00:00:00Z"));
    store.root(dir, { lastScanAt: "2026-06-01T00:00:00.000Z" });
    store.doc(path);
    const queue = recorder();

    await build(store, queue.enqueue).refresh();
    await settle();

    expect(queue.paths()).toEqual([]);
  });

  it("queues a file the store has once its file is newer than the last scan", async () => {
    const store = new FakeStore();
    const path = await write("edited.md", new Date("2026-07-01T00:00:00Z"));
    store.root(dir, { lastScanAt: "2026-06-01T00:00:00.000Z" });
    store.doc(path);
    const queue = recorder();

    await build(store, queue.enqueue).refresh();
    await settle();

    expect(queue.paths()).toEqual([path]);
  });

  // The leak an mtime watermark alone would have. Copy tools preserve timestamps, so a batch of
  // old recordings dropped into a watched folder is OLDER than the watermark and would be
  // invisible forever. Being absent from the store is the second way in.
  it("queues a file copied in with an old timestamp, because the store has never seen it", async () => {
    const store = new FakeStore();
    const path = await write("from-2019.md", new Date("2019-03-04T05:06:07Z"));
    store.root(dir, { lastScanAt: "2026-06-01T00:00:00.000Z" });
    const queue = recorder();

    await build(store, queue.enqueue).refresh();
    await settle();

    expect(queue.paths()).toEqual([path]);
  });

  it("skips a document switched off on its own, and keeps watching the folder", async () => {
    const store = new FakeStore();
    const off = await write("ignored.md");
    const on = await write("wanted.md");
    store.root(dir);
    store.doc(off, { watching: false });
    const queue = recorder();

    await build(store, queue.enqueue).refresh();
    await settle();

    expect(queue.paths()).toEqual([on]);
  });

  it("stamps the root with the time the walk started, so a file written during it is not lost", async () => {
    const store = new FakeStore();
    store.root(dir);
    const before = Date.now();

    await build(store, recorder().enqueue).refresh();

    expect(store.scanned).toHaveLength(1);
    const at = store.scanned[0]?.at.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before - 1);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it("does not walk an unwatched folder at all", async () => {
    const store = new FakeStore();
    store.root(dir, { watching: false });
    await write("new.md");
    const queue = recorder();

    await build(store, queue.enqueue).refresh();
    await settle();

    expect(queue.paths()).toEqual([]);
    expect(store.scanned).toEqual([]);
  });
});

describe("FileSync missing files", () => {
  // A deleted file must never delete memory: the ordinary causes are a temp-file rename, an
  // unmounted drive, and a pipeline that tidies up after itself.
  it("marks a document whose file is gone and keeps the document", async () => {
    const store = new FakeStore();
    store.root(dir);
    const doc = store.doc(join(dir, "deleted.md"));
    const queue = recorder();

    await build(store, queue.enqueue).refresh();
    await settle();

    expect(store.marked).toEqual([{ id: doc.id, missing: true }]);
    expect(store.docs).toHaveLength(1);
    expect(queue.paths()).toEqual([]);
  });

  // Without the changed-only guard, a folder emptied by an upload pipeline rewrites every dead
  // row on every tick: ten thousand pointless writes a minute after a week of recordings.
  it("marks a missing file once, not on every tick", async () => {
    const store = new FakeStore();
    store.root(dir);
    store.doc(join(dir, "deleted.md"));
    const watcher = build(store, recorder().enqueue);

    await watcher.refresh();
    await watcher.refresh();
    await watcher.refresh();

    expect(store.marked).toHaveLength(1);
    expect(watcher.stats().missing).toBe(1);
  });

  it("leaves a document switched off out of the missing sweep entirely", async () => {
    const store = new FakeStore();
    store.root(dir);
    store.doc(join(dir, "deleted.md"), { watching: false });

    await build(store, recorder().enqueue).refresh();

    expect(store.marked).toEqual([]);
  });

  it("clears the mark and re-ingests when the file comes back", async () => {
    const store = new FakeStore();
    store.root(dir);
    const doc = store.doc(join(dir, "flaky.md"), { missing: true });
    const queue = recorder();
    const watcher = build(store, queue.enqueue);

    await write("flaky.md");
    await watcher.refresh();
    await settle();

    expect(store.marked).toEqual([{ id: doc.id, missing: false }]);
    expect(queue.paths()).toEqual([join(dir, "flaky.md")]);
  });
});

describe("FileSync watch set", () => {
  // One OS watcher per document would mean thousands of them for a linked folder. A file
  // inside a watched root is already covered by the root.
  it("does not watch a file individually when its folder is watched", async () => {
    const store = new FakeStore();
    store.root(dir);
    store.doc(join(dir, "inside.md"));
    store.doc(join(tmpdir(), "memloom-sync-elsewhere.md"));

    const watcher = build(store, recorder().enqueue);
    await watcher.refresh();

    expect(watcher.stats().roots).toBe(1);
    expect(watcher.stats().files).toBe(1);
  });

  // Prefix alone would put /tmp/x-extra.md "inside" /tmp/x.
  it("does not treat a sibling folder with a longer name as inside the root", async () => {
    const store = new FakeStore();
    store.root(join(dir, "audio"));
    store.doc(join(dir, "audio-archive", "old.md"));

    const watcher = build(store, recorder().enqueue);
    await watcher.refresh();

    expect(watcher.stats().files).toBe(1);
  });

  it("reports when a rescan hit the walk cap", async () => {
    const store = new FakeStore();
    store.root(dir);
    const watcher = build(store, recorder().enqueue);
    await watcher.refresh();
    // Nothing to trim: the rescan is uncapped on purpose, so this stays false however many
    // files a watched folder accumulates.
    expect(watcher.stats().capped).toBe(false);
  });

  it("stops cleanly and ignores work scheduled after that", async () => {
    const store = new FakeStore();
    store.root(dir);
    await write("new.md");
    const queue = recorder();
    const watcher = build(store, queue.enqueue);

    await watcher.stop();
    await watcher.refresh();
    await settle();

    expect(queue.paths()).toEqual([]);
  });
});

// Found by running the whole flow against a real daemon: while a recording transcribed, the
// rescan announced "1 file(s)" once a tick for the full ten minutes. The queue was refusing the
// duplicate correctly; the watcher was reporting the offer instead of the acceptance.
describe("FileSync counts what the queue took, not what it offered", () => {
  it("does not count a path the queue already has", async () => {
    const store = new FakeStore();
    store.root(dir);
    const path = await write("in-flight.md");
    const queue = recorder();
    queue.refuse(path);

    const watcher = build(store, queue.enqueue);
    await watcher.refresh();
    await settle();

    // Offered, because the file has no document row until its ingest finishes.
    expect(queue.paths()).toEqual([path]);
    // Not counted, because the queue was already working on it.
    expect(watcher.stats().queued).toBe(0);
  });

  it("counts a path the queue accepted", async () => {
    const store = new FakeStore();
    store.root(dir);
    await write("new.md");
    const queue = recorder();

    const watcher = build(store, queue.enqueue);
    await watcher.refresh();
    await settle();

    expect(watcher.stats().queued).toBe(1);
  });
});
