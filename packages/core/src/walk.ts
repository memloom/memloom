import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { supportedExtensions } from "./extract.js";

// Walking a folder for files memloom can read.
//
// Two callers with opposite needs share this. An interactive "add this folder" is a person
// who might have typed C:\ by mistake, so it is bounded and stops early. A rescan of a folder
// the user already chose to watch is not a mistake, and stopping early there would silently
// ignore recordings forever once the folder passed the cap. Same walk, different ceiling, and
// the result says which happened rather than leaving the caller to guess.

export const WALK_MAX_DEPTH = 5;
export const WALK_MAX_FILES = 500;

/** Dependency and build output, plus anything hidden. Nobody links a folder to index these. */
export const WALK_SKIP_DIRS = new Set(["node_modules", "dist", "build", "__pycache__", "target"]);

/**
 * Is this document path a real file on disk, as opposed to upload://, attachment:// or a URL?
 *
 * The test is "starts with a scheme", which all three synthetic provenances do and no local
 * path does: C:\recordings has a backslash after the colon, not two slashes. Mirrors the
 * regex in syncTargets, and both exist because only a document with a file behind it can be
 * kept in step with one.
 */
export function hasDiskPath(path: string): boolean {
  return !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path);
}

export interface WalkedFile {
  path: string;
  /** Carried out of the walk so a rescan can skip untouched files without a second stat. */
  mtimeMs: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /**
   * The walk stopped at maxFiles with more left to find. The true total is unknown: learning it
   * would mean doing the walk the cap exists to avoid.
   */
  capped: boolean;
}

export interface WalkOptions {
  maxDepth?: number;
  /** Pass Infinity for a rescan of a folder already under watch. */
  maxFiles?: number;
  signal?: AbortSignal;
}

async function walk(
  root: string,
  supported: Set<string>,
  maxDepth: number,
  maxFiles: number,
  signal: AbortSignal | undefined,
  depth: number,
  out: WalkedFile[],
): Promise<boolean> {
  if (depth > maxDepth) return false;
  if (signal?.aborted) return false;
  // An unreadable directory is skipped rather than fatal: one permission-denied subfolder must
  // not cost the caller every file above it.
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (signal?.aborted) return false;
    if (out.length >= maxFiles) return true;
    if (entry.name.startsWith(".") || WALK_SKIP_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await walk(full, supported, maxDepth, maxFiles, signal, depth + 1, out)) return true;
      continue;
    }
    if (!supported.has(extname(entry.name).toLowerCase())) continue;
    // A file that vanished between readdir and here is simply not in the folder any more.
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    out.push({ path: full, mtimeMs: info.mtimeMs });
  }
  return false;
}

/**
 * Every file under `root` that some extractor can read, with the modification time the walk saw.
 *
 * `capped` is true when maxFiles cut the walk short. Callers must surface that: a folder ingest
 * that quietly returns the first 500 of 2000 files reads exactly like a folder with 500 files in
 * it, and the difference only shows up as memories that never arrive.
 */
export async function walkSupportedFiles(
  root: string,
  opts: WalkOptions = {},
): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const capped = await walk(
    root,
    new Set(supportedExtensions()),
    opts.maxDepth ?? WALK_MAX_DEPTH,
    opts.maxFiles ?? WALK_MAX_FILES,
    opts.signal,
    0,
    files,
  );
  return { files, capped };
}
