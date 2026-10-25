import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

// PGLite is single-process; two openers of the same data dir corrupt the WAL. The
// embedded tier must guard the directory itself (PGLite 0.4.6 does not). We take an advisory
// lock on the data dir; a second opener fails with a clear error instead of corrupting.
//
// Staleness used to be time alone: a lock untouched for 15s was reclaimed. But a PGLite query
// runs on the main thread, so a daemon busy with one long query stops touching its lock while
// it is still very much alive, and a second process took the store from under it. Both then
// wrote the WAL, and the store would not open again. Now the holder also records its pid and
// when the machine booted, and a lock is reclaimed only once its holder is gone: a dead pid, or
// a holder from before a reboot (a crashed laptop). Time alone frees it only after an hour.

export type ReleaseLock = () => Promise<void>;

const STALE_MS = 60 * 60_000;
const UPDATE_MS = 5_000;
const RETRY_STEP_MS = 2_000;
// Boot time is derived from the clock and the uptime counter, so two readings of it drift
// apart when the clock is adjusted. A real reboot moves it by far more than this.
const SAME_BOOT_MS = 5 * 60_000;

export interface LockOptions {
  /** Keep retrying for up to this long before giving up. 0 (default) fails fast. */
  waitMs?: number;
}

interface LockOwner {
  pid: number;
  bootedAt: number;
}

const ownerFile = (dataDir: string) => `${dataDir}.lock-owner.json`;
const lockDir = (dataDir: string) => `${dataDir}.lock`;
const bootedAt = () => Date.now() - uptime() * 1000;

function readOwner(dataDir: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(readFileSync(ownerFile(dataDir), "utf8")) as Partial<LockOwner>;
    return typeof owner.pid === "number" && typeof owner.bootedAt === "number"
      ? { pid: owner.pid, bootedAt: owner.bootedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock left on the data dir belongs to a process that is gone. True after a reboot or
 * once the recorded pid has exited; false while the holder runs, however long it has been busy.
 * A lock with no owner record (an older memloom) is left to the time-based rule.
 */
export function lockHolderGone(dataDir: string): boolean {
  if (!existsSync(lockDir(dataDir))) return false;
  const owner = readOwner(dataDir);
  if (!owner) return false;
  if (Math.abs(owner.bootedAt - bootedAt()) > SAME_BOOT_MS) return true;
  return !isAlive(owner.pid);
}

/**
 * Clear a dead holder's lock. Two processes can both find the holder gone (two clients starting
 * the daemon after a reboot), and the slower one must not delete the lock the faster one has
 * just taken. Renaming the owner record is atomic, so only one of them wins the right to remove
 * the lock; the other finds the record gone and waits on the lock like any second opener.
 */
function reclaim(dataDir: string): void {
  const claim = `${ownerFile(dataDir)}.${process.pid}`;
  try {
    renameSync(ownerFile(dataDir), claim);
  } catch {
    return;
  }
  rmSync(lockDir(dataDir), { recursive: true, force: true });
  rmSync(claim, { force: true });
}

export async function acquireDataDirLock(
  dataDir: string,
  opts: LockOptions = {},
): Promise<ReleaseLock> {
  mkdirSync(dataDir, { recursive: true });
  const waitMs = opts.waitMs ?? 0;
  if (lockHolderGone(dataDir)) reclaim(dataDir);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(dataDir, {
      stale: STALE_MS,
      update: UPDATE_MS,
      realpath: false,
      // Another process holds the store now. Writing on would corrupt it, so stop at once.
      onCompromised: (err) => {
        console.error(`memloom: lost the lock on the store, stopping: ${err.message}`);
        process.exit(1);
      },
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
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `memloom: the store at "${dataDir}" is already open in another process ` +
        `(embedded PGLite allows one owner at a time). Close the other memloom process ` +
        `(\`memloom stop\` for the daemon) and retry. [${reason}]`,
    );
  }
  const owner: LockOwner = { pid: process.pid, bootedAt: bootedAt() };
  writeFileSync(ownerFile(dataDir), JSON.stringify(owner));
  // Only now that no other memloom process can be using the store.
  clearBogusPostmasterPid(dataDir);
  return async () => {
    rmSync(ownerFile(dataDir), { force: true });
    await release();
  };
}

/**
 * Remove a postmaster.pid that holds no pid, so PGLite can open the store.
 *
 * PGLite writes postmaster.pid on open and deletes it on a clean close. A process that dies
 * without closing (a Windows crash or power loss) can leave the file allocated but blank, all
 * spaces or NULs, and from then on every open fails with Postgres's
 * `bogus data in lock file "postmaster.pid"`, which PGLite reports only as "PGlite failed to
 * initialize properly". A leftover file that does hold a pid is fine: PGLite resumes past it.
 *
 * Only called with the data-dir lock held, so no other memloom process is using the store and
 * the file cannot belong to a live opener. Returns whether a file was removed.
 */
export function clearBogusPostmasterPid(dataDir: string): boolean {
  const pidFile = join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return false;
  const firstLine = readFileSync(pidFile, "utf8").replace(/\0/g, "").trim().split("\n")[0];
  if (/^-?\d+$/.test(firstLine?.trim() ?? "")) return false;
  rmSync(pidFile, { force: true });
  return true;
}
