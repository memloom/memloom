import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { waitUntilStable } from "./stability.js";

// A durable queue for ingests that take minutes.
//
// Transcribing an hour of audio costs 8 to 11 minutes, so a queue is not a convenience: it is
// the difference between "point memloom at a folder of recordings and walk away" and babysitting
// one file at a time. It has to survive the daemon restarting, because a run long enough to
// need a queue is long enough to span one.
//
// Persisted as a JSON file rather than a table on purpose. This stream has no reserved
// migration range, and a queue is transient operational state rather than memory: losing it
// costs a re-add, never a document. See 00-COORDINATION.md.

/**
 * Where uploaded recordings live. NOT the OS temp dir: an uploaded document keeps its path
 * for playback, samples, and "open file", and Windows clears %TEMP% whenever it likes,
 * which turned uploads into documents whose media quietly vanished. The store owns these
 * bytes; deleting the document (or a queue row that never became one) deletes them.
 */
export function uploadStoreDir(): string {
  return process.env.MEMLOOM_UPLOAD_DIR ?? join(homedir(), ".memloom", "uploads");
}

/**
 * Drop the per-upload directory of a queue row that will never become a document. A "done"
 * row's file belongs to its document and leaves when the document does; a running row's
 * file may still be under ffmpeg's feet (Windows refuses deletion of open files), so a
 * removed-while-running upload is left for the document delete or the next clear to catch.
 * Legacy rows that pointed at the OS temp dir are outside the root check and stay the
 * OS's problem, exactly as before.
 */
async function discardUploadedFile(item: QueueItem): Promise<void> {
  if (!item.uploaded || item.status === "done" || item.status === "running") return;
  const root = resolve(uploadStoreDir());
  const dir = resolve(dirname(item.path));
  if (!dir.startsWith(root + sep)) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export type QueueStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface QueueItem {
  id: string;
  /** Absolute path on this machine, or a temp path an upload landed at. */
  path: string;
  /** Set when the bytes were uploaded rather than linked, so the temp file can be cleaned up. */
  uploaded?: boolean;
  status: QueueStatus;
  addedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Last progress seen, so a restarted viewer can render a running item straight away. */
  stage?: string;
  done?: number;
  total?: number;
  seconds?: number;
  audioSeconds?: number;
  /**
   * Nobody asked for this one: the file watcher found a change and queued it. A finished row
   * for it is noise, so it leaves the queue on success. A FAILED one stays, because a file the
   * watcher could not read is exactly the thing a person needs told about.
   */
  silent?: boolean;
  /** Filled in on completion. */
  outcome?: string;
  chunks?: number;
  error?: string;
}

export interface QueueSnapshot {
  items: QueueItem[];
  /** True while the worker is mid-item, so a UI can distinguish idle from stalled. */
  running: boolean;
  /**
   * Items that have finished since the daemon started, successes and failures alike. Only ever
   * goes up, so a poller can tell "something completed" from "the list looks the same", which
   * counting `done` rows cannot do once finished rows start removing themselves.
   */
  completed: number;
}

function queuePath(): string {
  const home = process.env.MEMLOOM_HOME ?? join(homedir(), ".memloom");
  return join(home, "ingest-queue.json");
}

/** What the queue needs from the engine, so tests can drive it without a real store. */
export interface QueueRunner {
  ingest(
    path: string,
    onProgress: (event: {
      stage: string;
      done: number;
      total: number;
      seconds: number;
      audioSeconds: number;
    }) => void,
    signal: AbortSignal,
  ): Promise<{ outcome: string; chunks: number }>;
}

/**
 * One queue per daemon. Single worker on purpose: each recognizer holds about 1.1 GB
 * resident and the binding exposes no way to free one, so running two transcriptions at
 * once doubles the memory without buying much speed. ONNX Runtime is already using four
 * cores inside a single decode, so the cores are not idle waiting for a second job.
 */
export class IngestQueue {
  #items: QueueItem[] = [];
  #runner: QueueRunner;
  #current: AbortController | null = null;
  #pumping = false;
  #loaded = false;
  /** Serializes writes so two rapid changes cannot interleave and lose one. */
  #writeChain: Promise<void> = Promise.resolve();
  #listeners = new Set<(snapshot: QueueSnapshot) => void>();
  // In memory rather than persisted: its only job is to let a poller notice a completion, and a
  // restart is a change too.
  #completed = 0;

  constructor(runner: QueueRunner) {
    this.#runner = runner;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const raw = await readFile(queuePath(), "utf8");
      const parsed = JSON.parse(raw) as { items?: QueueItem[] };
      // Anything that was running when the daemon stopped never finished, so it goes back to
      // the front of the line rather than being reported as done or lost.
      this.#items = (parsed.items ?? []).map((item) =>
        item.status === "running" ? { ...item, status: "queued", stage: undefined } : item,
      );
    } catch {
      // No queue file yet, or an unreadable one. Either way an empty queue is correct: this
      // is operational state, and refusing to start over a corrupt file would be worse.
      this.#items = [];
    }
    this.#pump();
  }

  snapshot(): QueueSnapshot {
    return {
      items: [...this.#items],
      running: this.#current !== null,
      completed: this.#completed,
    };
  }

  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Add paths to the back of the queue. Already-queued or running paths are not duplicated.
   *
   * `skipFailed` also drops paths whose last attempt failed, and exists for the file watcher.
   * A file that cannot be ingested at all (a truncated recording, an encrypted PDF) still sits
   * in its folder, so a rescan finds it again every tick and would add a fresh failed row every
   * tick forever. A person adding the same file by hand is asking for a retry, and gets one.
   *
   * `silent` marks work nobody asked for, so its row leaves the queue once it succeeds.
   */
  async add(
    paths: string[],
    opts: { uploaded?: boolean; skipFailed?: boolean; silent?: boolean } = {},
  ): Promise<QueueItem[]> {
    await this.load();
    const pending = new Set(
      this.#items
        .filter(
          (i) =>
            i.status === "queued" ||
            i.status === "running" ||
            (opts.skipFailed === true && i.status === "failed"),
        )
        .map((i) => i.path),
    );
    const added: QueueItem[] = [];
    for (const path of paths) {
      if (pending.has(path)) continue;
      pending.add(path);
      const item: QueueItem = {
        id: randomUUID(),
        path,
        status: "queued",
        addedAt: new Date().toISOString(),
        ...(opts.uploaded ? { uploaded: true } : {}),
        ...(opts.silent ? { silent: true } : {}),
      };
      this.#items.push(item);
      added.push(item);
    }
    await this.#persist();
    this.#pump();
    return added;
  }

  /** Stop a running item, or drop a waiting one. Both end as "cancelled" so they can resume. */
  async cancel(id: string): Promise<boolean> {
    await this.load();
    const item = this.#items.find((i) => i.id === id);
    if (!item) return false;
    if (item.status === "running") {
      this.#current?.abort();
      return true; // the worker marks it cancelled as it unwinds
    }
    if (item.status !== "queued") return false;
    item.status = "cancelled";
    item.finishedAt = new Date().toISOString();
    await this.#persist();
    return true;
  }

  /** Put a cancelled or failed item back in line. The one button a stopped item needs. */
  async resume(id: string): Promise<boolean> {
    await this.load();
    const item = this.#items.find((i) => i.id === id);
    if (!item || (item.status !== "cancelled" && item.status !== "failed")) return false;
    item.status = "queued";
    item.error = undefined;
    item.stage = undefined;
    item.finishedAt = undefined;
    await this.#persist();
    this.#pump();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const item = this.#items.find((i) => i.id === id);
    if (!item) return false;
    if (item.status === "running") this.#current?.abort();
    this.#items = this.#items.filter((i) => i.id !== id);
    await discardUploadedFile(item);
    await this.#persist();
    return true;
  }

  /** Drop every finished row. The list is a work queue, not a permanent history. */
  async clearFinished(): Promise<number> {
    await this.load();
    const before = this.#items.length;
    const dropped = this.#items.filter((i) => i.status !== "queued" && i.status !== "running");
    this.#items = this.#items.filter((i) => i.status === "queued" || i.status === "running");
    for (const item of dropped) await discardUploadedFile(item);
    await this.#persist();
    return before - this.#items.length;
  }

  // -------------------------------------------------------------------------------------

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #persist(): Promise<void> {
    // Written to a sibling then renamed: a daemon killed mid-write must never leave a
    // half-serialized queue that fails to parse on the next start.
    this.#writeChain = this.#writeChain.then(async () => {
      const file = queuePath();
      try {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify({ items: this.#items }, null, 2));
        await rename(tmp, file);
      } catch {
        // A queue that cannot be written still works for this daemon's lifetime. Failing the
        // ingest because the file is read-only would be the worse trade.
      }
      this.#emit();
    });
    return this.#writeChain;
  }

  /** Drain the queue one item at a time. Safe to call whenever the queue changes. */
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    void this.#drain().finally(() => {
      this.#pumping = false;
    });
  }

  async #drain(): Promise<void> {
    for (;;) {
      const item = this.#items.find((i) => i.status === "queued");
      if (!item) return;

      const controller = new AbortController();
      this.#current = controller;
      item.status = "running";
      item.startedAt = new Date().toISOString();
      await this.#persist();

      try {
        // Checked here rather than in add() for two reasons. A POST that enqueues twenty
        // files must not block for a settle window each, and more importantly a file can
        // still be growing when it finally reaches the front of the queue, minutes after it
        // was added. This is the last moment before the bytes are read, which is the only
        // moment the answer is still true.
        await waitUntilStable(item.path, {
          signal: controller.signal,
          onWait: (elapsedMs) => {
            item.stage = "waiting";
            item.done = Math.round(elapsedMs / 1000);
            item.total = 0;
            item.seconds = 0;
            item.audioSeconds = 0;
            this.#emit();
          },
        });

        const result = await this.#runner.ingest(
          item.path,
          (event) => {
            // Kept on the item so a viewer opened mid-run renders the real state instead of
            // an empty bar. Not persisted per event: that would be a disk write per chunk.
            item.stage = event.stage;
            item.done = event.done;
            item.total = event.total;
            item.seconds = event.seconds;
            item.audioSeconds = event.audioSeconds;
            this.#emit();
          },
          controller.signal,
        );
        item.status = "done";
        item.outcome = result.outcome;
        item.chunks = result.chunks;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A cancel is not a failure. It keeps its own status so the UI offers Resume rather
        // than showing it in red as something that broke.
        item.status = controller.signal.aborted ? "cancelled" : "failed";
        if (!controller.signal.aborted) item.error = message;
      } finally {
        item.stage = undefined;
        item.finishedAt = new Date().toISOString();
        this.#current = null;
        this.#completed += 1;
        // Work the watcher started, which succeeded, leaves nothing behind. Editing a note
        // three times would otherwise leave three "done" rows in a list of jobs the person
        // never started. A failure keeps its row: that is the one outcome worth telling them.
        if (item.silent && item.status === "done") {
          this.#items = this.#items.filter((i) => i.id !== item.id);
        }
        await this.#persist();
      }
    }
  }
}
