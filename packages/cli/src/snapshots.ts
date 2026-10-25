import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { memloomHome } from "./config.js";

// Copies of the embedded store, taken while it is known to open, to fall back on when it will
// not.
//
// PGLite cannot force its writes to disk (the WASM build has no working fsync), so a laptop
// that crashes or loses power can leave the store's files out of step with each other, and
// Postgres then refuses to start. Without a copy the only way back is repairing the files by
// hand. So the daemon keeps the last few snapshots, and if the store will not open it moves
// the broken one aside, untouched, and starts from the newest snapshot instead.

const KEEP = 2;
const EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 2 * 60_000;
const CHECK_MS = 60 * 60_000;
const NAME = /^store-(\d{8}-\d{6})\.tar\.gz$/;

export function snapshotDir(): string {
  return join(memloomHome(), "snapshots");
}

export function snapshotsEnabled(): boolean {
  return process.env.MEMLOOM_SNAPSHOTS?.trim().toLowerCase() !== "off";
}

function stamp(d = new Date()): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.\d+Z$/, "");
}

/** Snapshots on disk, newest first. */
export function listSnapshots(dir = snapshotDir()): { path: string; takenAt: Date }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: NAME.exec(name) }))
    .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
    .map(({ name, m }) => {
      const s = m[1] as string;
      const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
      return { path: join(dir, name), takenAt: new Date(iso) };
    })
    .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/** Write a snapshot of the open store and drop all but the newest few. */
export async function takeSnapshot(db: PGlite, dir = snapshotDir()): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `store-${stamp()}.tar.gz`);
  const blob = await db.dumpDataDir("gzip");
  // Write beside and rename, so a crash mid-write never leaves a snapshot that looks whole.
  await writeFile(`${path}.partial`, new Uint8Array(await blob.arrayBuffer()));
  renameSync(`${path}.partial`, path);
  for (const old of listSnapshots(dir).slice(KEEP)) rmSync(old.path, { force: true });
  return path;
}

/**
 * Take a snapshot now and then while the daemon runs: when the newest is older than six hours
 * and the store has changed since this process last took one. Returns a stop function.
 */
export function scheduleSnapshots(db: PGlite, log = console.log): () => void {
  let lastLsn: string | undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    const newest = listSnapshots()[0];
    if (newest && Date.now() - newest.takenAt.getTime() < EVERY_MS) return;
    running = true;
    try {
      const { rows } = await db.query<{ lsn: string }>("SELECT pg_current_wal_lsn()::text AS lsn");
      const lsn = rows[0]?.lsn;
      if (newest && lsn === lastLsn) return;
      const path = await takeSnapshot(db);
      lastLsn = lsn;
      log(`memloom: saved a snapshot of the store to ${path}`);
    } catch (err) {
      log(
        `memloom: could not save a snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, FIRST_CHECK_MS);
  const every = setInterval(tick, CHECK_MS);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/**
 * Open the store, falling back to the newest snapshot that opens when it will not. The broken
 * store is renamed, not deleted, so whatever it holds past the snapshot can still be recovered.
 */
export async function openWithFallback(
  dir: string,
  open: (dir: string, snapshot?: Blob) => Promise<PGlite>,
  log = console.error,
): Promise<{ db: PGlite; restored?: { from: string; brokenDir: string } }> {
  let firstError: unknown;
  try {
    return { db: await open(dir) };
  } catch (err) {
    firstError = err;
  }
  const snapshots = snapshotsEnabled() ? listSnapshots() : [];
  if (snapshots.length === 0) throw firstError;

  const brokenDir = `${dir}.broken-${stamp()}`;
  try {
    renameSync(dir, brokenDir);
  } catch {
    // Windows will not rename a folder with files still open in it; leave the store as it is.
    throw firstError;
  }
  log(
    `memloom: the store would not open (${firstError instanceof Error ? firstError.message : String(firstError)}).`,
  );
  log(`  moved it, unchanged, to ${brokenDir}`);
  for (const snap of snapshots) {
    rmSync(dir, { recursive: true, force: true });
    try {
      const db = await open(dir, new Blob([readFileSync(snap.path)]));
      log(`  restored the snapshot from ${snap.takenAt.toISOString()} (${snap.path})`);
      log("  memories saved after that are only in the moved store.");
      return { db, restored: { from: snap.path, brokenDir } };
    } catch (err) {
      log(
        `  snapshot ${snap.path} did not open either: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Nothing worked: put the store back where it was, so the next attempt sees what this one saw.
  rmSync(dir, { recursive: true, force: true });
  renameSync(brokenDir, dir);
  throw firstError;
}
