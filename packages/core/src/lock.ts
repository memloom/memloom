import { mkdirSync } from "node:fs";
import lockfile from "proper-lockfile";

// D1: PGLite is single-process — two openers of the same data dir corrupt the WAL. The
// embedded tier must guard the directory itself (PGLite 0.4.6 does not). We take an advisory
// lock on the data dir; a second opener fails fast with a clear error instead of corrupting.

export type ReleaseLock = () => Promise<void>;

export async function acquireDataDirLock(dataDir: string): Promise<ReleaseLock> {
  mkdirSync(dataDir, { recursive: true });
  try {
    const release = await lockfile.lock(dataDir, {
      stale: 15_000,
      update: 5_000,
      realpath: false,
      retries: 0,
    });
    return async () => {
      await release();
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `memloom: the store at "${dataDir}" is already open in another process ` +
        `(embedded PGLite allows one owner at a time). Close the other memloom process, ` +
        `or connect through a running \`memloom serve\`. [${reason}]`,
    );
  }
}
