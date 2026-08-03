import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { supportedExtensions } from "./extract.js";
import type { ContextRoot, SyncTargets } from "./types.js";
import { WALK_MAX_DEPTH, WALK_SKIP_DIRS, walkSupportedFiles } from "./walk.js";

// Keeping linked files current.
//
// Two mechanisms, because neither is sufficient alone. Events (chokidar) are immediate and
// cost nothing while idle, but they never arrive for a file that landed while the daemon was
// down, and network shares drop them even while it is up. A rescan is slow but complete. So:
// events for latency, a rescan every tick for truth. A file caught by both is ingested once,
// because the queue deduplicates by path and an unchanged file short-circuits on its hash.
//
// Nothing here reads or hashes a file. Every path found goes to the ingest queue, which
// already waits for the file to stop growing (stability.ts), drains one at a time, survives a
// restart, and reports progress. Calling contextAdd from a watcher instead would transcribe
// half a recording the moment the first bytes of it appeared.

/** The slice of the engine sync needs. Narrow on purpose, so tests do not need a store. */
export interface SyncStore {
  syncTargets(ownerId?: string): Promise<SyncTargets>;
  contextRootScanned(rootId: string, at: Date, ownerId?: string): Promise<void>;
  contextDocumentsUnder(
    prefix: string,
    ownerId?: string,
  ): Promise<{ id: string; path: string; watching: boolean }[]>;
  contextDocumentByPath(
    path: string,
    ownerId?: string,
  ): Promise<{ id: string; watching: boolean } | null>;
  contextMarkMissing(documentId: string, missing: boolean, ownerId?: string): Promise<boolean>;
}

export interface SyncOptions {
  /** How often to refresh the watch set and rescan every root. Floored at 10s. */
  rescanMs?: number;
  /** How long a path must stay quiet before it is queued. Editors write in bursts. */
  debounceMs?: number;
  /**
   * Force chokidar to poll instead of subscribing to OS events.
   *
   * "auto" polls only for UNC paths (\\server\share), where events are least likely to
   * arrive. Everything else rides on events plus the rescan, which is the real safety net:
   * a dropped event costs at most one rescan interval, not the file.
   */
  polling?: "auto" | "on" | "off";
  /** Poll interval when polling is in effect. */
  pollIntervalMs?: number;
  ownerId?: string;
  /** Progress and failures, one line each. The daemon points this at the console. */
  log?: (message: string) => void;
}

export interface SyncStats {
  /** Roots currently watched. */
  roots: number;
  /** Individually linked files currently watched. */
  files: number;
  /** Paths handed to the queue since start. */
  queued: number;
  /** Documents marked missing since start. */
  missing: number;
  /** Whether the last rescan of any root hit the walk cap. */
  capped: boolean;
}

/**
 * Hands paths to the ingest queue and answers with the ones it ACCEPTED.
 *
 * The return value matters: a file being transcribed has no document row until the ingest ends,
 * so every rescan in between finds it again and offers it again. The queue refuses the
 * duplicate, and only it knows that, so the watcher counts and reports what came back.
 */
export type EnqueuePaths = (paths: string[]) => Promise<string[]>;

const MIN_RESCAN_MS = 10_000;

function isUnc(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

/**
 * Keeps linked folders and files in step with what is on disk.
 *
 * One instance per daemon. `start()` is safe to call once; `refresh()` picks up roots added or
 * unwatched since, and the daemon calls it after any change to the watch list so a folder
 * linked in the viewer starts syncing without a restart.
 */
export class FileSync {
  readonly #store: SyncStore;
  readonly #enqueue: EnqueuePaths;
  readonly #opts: Required<Omit<SyncOptions, "log">> & { log: (m: string) => void };
  readonly #supported = new Set(supportedExtensions());

  #watcher: FSWatcher | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #watched = new Set<string>();
  #debounce = new Map<string, ReturnType<typeof setTimeout>>();
  #pending = new Set<string>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #rescanBusy = false;
  #stopped = false;
  #stats: SyncStats = { roots: 0, files: 0, queued: 0, missing: 0, capped: false };

  constructor(store: SyncStore, enqueue: EnqueuePaths, opts: SyncOptions = {}) {
    this.#store = store;
    this.#enqueue = enqueue;
    this.#opts = {
      rescanMs: Math.max(MIN_RESCAN_MS, opts.rescanMs ?? 60_000),
      debounceMs: opts.debounceMs ?? 1000,
      polling: opts.polling ?? "auto",
      pollIntervalMs: opts.pollIntervalMs ?? 5_000,
      ownerId: opts.ownerId ?? "",
      log: opts.log ?? (() => {}),
    };
  }

  stats(): SyncStats {
    return { ...this.#stats };
  }

  /** Build the watch set, catch up on everything missed, then tick. */
  async start(): Promise<void> {
    await this.refresh();
    this.#timer = setInterval(() => {
      void this.refresh().catch((err) => this.#opts.log(`sync tick failed: ${message(err)}`));
    }, this.#opts.rescanMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    clearTimeout(this.#flushTimer);
    for (const timer of this.#debounce.values()) clearTimeout(timer);
    this.#debounce.clear();
    await this.#watcher?.close();
    this.#watcher = null;
    this.#watched.clear();
  }

  /** Re-read the watch list, adjust what chokidar is watching, and rescan roots and files. */
  async refresh(): Promise<void> {
    if (this.#stopped) return;
    const targets = await this.#targets();
    this.#sync(targets);
    await this.#rescanAll(targets.roots);
    await this.#rescanFiles(targets.files);
  }

  /**
   * The catch-up pass for files linked on their own, which folders get from #rescan and these
   * would otherwise never get at all.
   *
   * Without it, editing a linked file while the daemon is down loses the edit permanently: no
   * event fires because nothing is running, and nothing later looks. A file's updated_at is when
   * its chunks were written, so an mtime past that means the file moved on and the store did not.
   */
  async #rescanFiles(files: SyncTargets["files"]): Promise<void> {
    for (const file of files) {
      if (this.#stopped) return;
      const info = await stat(file.path).catch(() => null);
      if (!info) {
        // Gone while nothing was watching. Marked, never deleted, as everywhere else.
        if (await this.#store.contextMarkMissing(file.id, true, this.#owner())) {
          this.#stats.missing += 1;
        }
        continue;
      }
      if (info.mtimeMs > Date.parse(file.updatedAt)) await this.#queue(file.path);
    }
  }

  async #targets(): Promise<SyncTargets> {
    const targets = await this.#store.syncTargets(this.#owner());
    // A file inside a watched folder is already covered by the folder's watcher, and watching
    // it again would mean one OS watcher per document. Only files linked on their own get one.
    const files = targets.files.filter((f) => !targets.roots.some((r) => under(f.path, r.path)));
    this.#stats.roots = targets.roots.length;
    this.#stats.files = files.length;
    return { roots: targets.roots, files };
  }

  #owner(): string | undefined {
    return this.#opts.ownerId === "" ? undefined : this.#opts.ownerId;
  }

  /** Add and remove chokidar paths so the watch set matches the store. */
  #sync(targets: SyncTargets): void {
    const wanted = new Set<string>([
      ...targets.roots.map((r) => r.path),
      ...targets.files.map((f) => f.path),
    ]);

    if (!this.#watcher) {
      if (wanted.size === 0) return;
      this.#watcher = this.#open([...wanted]);
      this.#watched = wanted;
      return;
    }
    for (const path of wanted) {
      if (!this.#watched.has(path)) this.#watcher.add(path);
    }
    for (const path of this.#watched) {
      if (!wanted.has(path)) this.#watcher.unwatch(path);
    }
    this.#watched = wanted;
  }

  #open(paths: string[]): FSWatcher {
    const polling =
      this.#opts.polling === "on" || (this.#opts.polling === "auto" && paths.some((p) => isUnc(p)));
    const watcher = watch(paths, {
      // The initial contents are the rescan's job, which knows what is already in the store.
      // Without this every restart would re-queue every file in every watched folder.
      ignoreInitial: true,
      persistent: true,
      depth: WALK_MAX_DEPTH,
      ignored: (path: string, stats?: Stats) => this.#ignored(path, stats),
      usePolling: polling,
      interval: this.#opts.pollIntervalMs,
      // A first line of defence only. The queue's waitUntilStable is the one that decides, and
      // it runs at the last moment before the bytes are read rather than at event time.
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 300 },
      ignorePermissionErrors: true,
    });
    watcher.on("add", (path) => this.#touched(path));
    watcher.on("change", (path) => this.#touched(path));
    watcher.on("unlink", (path) => void this.#vanished(path));
    // A watcher error is worth a line and nothing more: one unreadable folder must not take
    // the other roots down, and the rescan keeps working regardless.
    watcher.on("error", (err) => this.#opts.log(`sync watcher: ${message(err)}`));
    if (polling) this.#opts.log("sync: polling (network path)");
    return watcher;
  }

  #ignored(path: string, stats?: Stats): boolean {
    const base = basename(path);
    if (base.startsWith(".") || WALK_SKIP_DIRS.has(base)) return true;
    // Extension is only a valid test once chokidar has stat'd the entry and told us it is a
    // file. Applied to a path with no stats it would reject every directory, because a folder
    // named "recordings" has no extension, and the walk would never descend.
    if (stats?.isFile()) return !this.#supported.has(extname(base).toLowerCase());
    return false;
  }

  /** A file appeared or changed: queue it, once it has been quiet for the debounce window. */
  #touched(path: string): void {
    if (this.#stopped) return;
    if (!this.#supported.has(extname(path).toLowerCase())) return;
    clearTimeout(this.#debounce.get(path));
    const timer = setTimeout(() => {
      this.#debounce.delete(path);
      void this.#queue(path);
    }, this.#opts.debounceMs);
    timer.unref?.();
    this.#debounce.set(path, timer);
  }

  async #queue(path: string): Promise<void> {
    try {
      const doc = await this.#store.contextDocumentByPath(path, this.#owner());
      // Switched off individually. The folder is still watched; this one file is not.
      if (doc && !doc.watching) return;
      // A file that came back clears its own mark before the re-ingest, so the documents tab
      // is right even if the ingest then fails for an unrelated reason.
      if (doc) await this.#store.contextMarkMissing(doc.id, false, this.#owner());
      this.#pending.add(path);
      this.#scheduleFlush();
    } catch (err) {
      this.#opts.log(`sync could not queue ${path}: ${message(err)}`);
    }
  }

  // Paths debounce individually, because twenty recordings finishing at twenty different
  // moments must not hold each other up. They are then handed over in one batch, so twenty
  // files cost one queue write rather than twenty.
  #scheduleFlush(): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#flush();
    }, 200);
    this.#flushTimer.unref?.();
  }

  async #flush(): Promise<void> {
    if (this.#pending.size === 0) return;
    const paths = [...this.#pending];
    this.#pending.clear();
    try {
      // Counted and reported from what the queue ACCEPTED, not from what was offered. A file
      // being transcribed has no document row yet, so every rescan finds it again and offers it
      // again; the queue refuses the duplicate, and reporting the offer instead announced the
      // same recording once a tick for the ten minutes it took to transcribe.
      const accepted = await this.#enqueue(paths);
      if (accepted.length > 0) {
        this.#stats.queued += accepted.length;
        this.#opts.log(`sync: ${accepted.length} file(s) queued`);
      }
    } catch (err) {
      this.#opts.log(`sync could not queue ${paths.length} file(s): ${message(err)}`);
    }
  }

  /**
   * The file is gone. Mark the document and keep every chunk: the usual causes are a temp-file
   * rename, an unmounted drive and a pipeline tidying up after itself, and none of them are a
   * request to forget what the file said.
   */
  async #vanished(path: string): Promise<void> {
    if (this.#stopped) return;
    clearTimeout(this.#debounce.get(path));
    this.#debounce.delete(path);
    this.#pending.delete(path);
    try {
      const doc = await this.#store.contextDocumentByPath(path, this.#owner());
      if (!doc) return;
      if (await this.#store.contextMarkMissing(doc.id, true, this.#owner())) {
        this.#stats.missing += 1;
      }
    } catch (err) {
      this.#opts.log(`sync could not mark ${path} missing: ${message(err)}`);
    }
  }

  async #rescanAll(roots: ContextRoot[]): Promise<void> {
    // A rescan of a big folder can outlast the tick that started it. Skipping rather than
    // stacking keeps one walk in flight; the next tick picks up whatever this one misses.
    if (this.#rescanBusy) return;
    this.#rescanBusy = true;
    this.#stats.capped = false;
    try {
      for (const root of roots) {
        if (this.#stopped) return;
        await this.#rescan(root);
      }
    } finally {
      this.#rescanBusy = false;
    }
  }

  /**
   * Walk a watched root and queue what the events missed.
   *
   * Two ways in, because either alone leaks. Modified since the last scan catches edits and
   * new arrivals, and is the cheap test. Not in the store at all catches a file copied in with
   * its original timestamp, which is older than the watermark and would otherwise be invisible
   * forever. Everything else is skipped without being read, which is what keeps a folder of
   * five thousand old recordings costing a walk rather than five thousand transcriptions.
   */
  async #rescan(root: ContextRoot): Promise<void> {
    const startedAt = new Date();
    // Uncapped: the 500-file ceiling protects a person who typed the wrong folder into a text
    // box. This folder was chosen deliberately and is being watched, so stopping at 500 would
    // mean silently ignoring every recording after the five hundredth, forever.
    const walked = await walkSupportedFiles(root.path, { maxFiles: Number.POSITIVE_INFINITY });
    if (walked.capped) this.#stats.capped = true;
    const known = await this.#store.contextDocumentsUnder(root.path, this.#owner());
    const knownPaths = new Set(known.map((d) => d.path));
    const onDisk = new Set(walked.files.map((f) => f.path));
    const since = root.lastScanAt === null ? 0 : Date.parse(root.lastScanAt);
    const fresh = walked.files
      .filter((f) => !knownPaths.has(f.path) || f.mtimeMs > since)
      .map((f) => f.path);

    // Documents whose file is no longer on disk. The walk is the only place a folder can learn
    // this: an unlink event fired while the daemon was down is gone for good. Documents the
    // user switched off are left entirely alone, marks included.
    for (const doc of known) {
      if (!doc.watching || onDisk.has(doc.path)) continue;
      if (await this.#store.contextMarkMissing(doc.id, true, this.#owner())) {
        this.#stats.missing += 1;
      }
    }

    // Reported from #flush, once the queue has said which of these were actually new.
    for (const path of fresh) await this.#queue(path);
    // Stamped with the time the walk STARTED, not finished. A file written during a long walk
    // is either seen by it or falls inside the next window; stamping the end would drop it.
    await this.#store.contextRootScanned(root.id, startedAt, this.#owner());
  }
}

/** Is `path` inside `dir`? Prefix plus a separator, so /a/bc is not "inside" /a/b. */
function under(path: string, dir: string): boolean {
  if (!path.startsWith(dir)) return false;
  const next = path.charAt(dir.length);
  return next === "/" || next === "\\";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
