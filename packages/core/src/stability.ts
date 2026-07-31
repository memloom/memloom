import { stat } from "node:fs/promises";

// Waiting for a file to stop being written.
//
// A folder watcher fires the moment a file appears, which on a USB dump or a network copy is
// the moment the FIRST bytes appear, not the last. Reading it then transcribes whatever
// happened to be on disk and stores the result as if it were the whole recording. That is the
// worst failure this pipeline can have: a memory you trust that quietly ends early.
//
// The check is deliberately dumb: stat twice a settle window apart, and require the size and
// mtime to be identical both times. No lock probing, no opening the file for write. Size
// stability is the signal that actually holds on Windows, where an exclusive-open test says
// more about the writer's share mode than about whether it is finished.

export interface FileStability {
  size: number;
  mtimeMs: number;
}

export interface StabilityOptions {
  /** How long the size and mtime must hold still. */
  settleMs?: number;
  /** Give up after this long and fail the item rather than blocking the queue forever. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called each time round the loop, so a multi-minute copy is not silent. */
  onWait?: (elapsedMs: number) => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Block until `path` has held the same size and mtime for a full settle window, then return
 * what it settled at.
 *
 * The common case costs one stat and no waiting: a file whose mtime is already older than the
 * settle window has not been touched in that window, which is the same evidence two polls
 * apart would produce. Only a file that is actually still growing pays the poll loop, so a
 * folder of twenty finished recordings is not twenty settle windows slower to ingest.
 *
 * Directories return immediately. A folder ingest walks its own files, and a directory's stat
 * says nothing about whether the files inside it are finished.
 *
 * Throws when the file disappears (a watcher can fire on a temp name that gets renamed away)
 * or when it is still growing after `timeoutMs`.
 */
export async function waitUntilStable(
  path: string,
  opts: StabilityOptions = {},
): Promise<FileStability> {
  const settleMs = opts.settleMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const started = Date.now();
  let previous: FileStability | null = null;

  for (;;) {
    if (opts.signal?.aborted) throw new Error("cancelled");

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      throw new Error(
        previous
          ? `${path} disappeared while waiting for it to finish being written`
          : `${path} does not exist`,
      );
    }
    if (info.isDirectory()) return { size: 0, mtimeMs: info.mtimeMs };

    const current: FileStability = { size: info.size, mtimeMs: info.mtimeMs };
    // A clock skewed into the future (network shares do this) makes the age negative, which
    // fails this test and falls through to polling. Slower, never wrong.
    if (Date.now() - info.mtimeMs >= settleMs) return current;
    if (
      previous !== null &&
      previous.size === current.size &&
      previous.mtimeMs === current.mtimeMs
    ) {
      return current;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `${path} is still being written after ${Math.round(timeoutMs / 1000)}s, so it was not ingested`,
      );
    }
    previous = current;
    opts.onWait?.(Date.now() - started);
    await delay(settleMs, opts.signal);
  }
}
