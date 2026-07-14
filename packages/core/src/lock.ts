import { mkdirSync } from "node:fs";
import lockfile from "proper-lockfile";

// D1: PGLite is single-process; two openers of the same data dir corrupt the WAL. The
// embedded tier must guard the directory itself (PGLite 0.4.6 does not). We take an advisory
// lock on the data dir; a second opener fails with a clear error instead of corrupting.
//
// Staleness: the holder touches the lock every 5s; a lock untouched for 15s is considered
// stale (its owner crashed or was force-killed) and is reclaimed. Callers that should survive
// a just-killed owner (the daemon) pass waitMs > the stale window so acquisition retries
// through it instead of failing on a lock that is about to expire.

export type ReleaseLock = () => Promise<void>;

const STALE_MS = 15_000;
const RETRY_STEP_MS = 2_000;

export interface LockOptions {
  /** Keep retrying for up to this long before giving up. 0 (default) fails fast. */
  waitMs?: number;
}

export async function acquireDataDirLock(
  dataDir: string,
  opts: LockOptions = {},
): Promise<ReleaseLock> {
  mkdirSync(dataDir, { recursive: true });
  const waitMs = opts.waitMs ?? 0;
  try {
    const release = await lockfile.lock(dataDir, {
      stale: STALE_MS,
      update: 5_000,
      realpath: false,
      retries:
        waitMs > 0
          ? {
              retries: Math.ceil(waitMs / RETRY_STEP_MS),
              minTimeout: RETRY_STEP_MS,
              maxTimeout: RETRY_STEP_MS,
              factor: 1,
            }
          : 0,
    });
    return async () => {
      await release();
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `memloom: the store at "${dataDir}" is already open in another process ` +
        `(embedded PGLite allows one owner at a time). Close the other memloom process ` +
        `(\`memloom stop\` for the daemon), or if a daemon was force-killed moments ago, ` +
        `wait ~15s for its lock to expire and retry. [${reason}]`,
    );
  }
}
