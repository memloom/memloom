import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";

// Files hanging off a memory: the picture of the thing you wrote down.
//
// "i wanna be able to attach a file/video/image for the memory, so i can save memory and i
// also take a picture for more context of what it looks like, not just text."
//
// THREE THINGS THIS IS NOT, because memloom already has two neighbours it will be confused
// with and one obvious feature it deliberately does not have.
//
//   - Not a context document. `contextAdd` points at a file where it already lives, extracts
//     its text, chunks and embeds it. Right for a folder you keep and sync; wrong here, where
//     the file arrived over Telegram into a temp path and the memory must not stop having a
//     picture because Windows cleared %TEMP%.
//   - Not a chat attachment. `contextAttach` scopes a file to one assistant session and drops
//     it when the session goes. This one belongs to a belief and outlives every conversation.
//   - Not searchable, and that was asked and answered. Nothing describes the image and nothing
//     embeds it. Recall finds the memory by what the user WROTE and the file comes back
//     attached to it. The alternative -- a vision model captioning every upload -- makes "what
//     did that router look like" work, and puts a model's guess about a photo into a store
//     whose whole promise is that it holds what you told it.
//
// The store owns the bytes, exactly as `uploadStoreDir` does for recordings and for the same
// measured reason: a path into the OS temp dir is a file that quietly vanishes.

/**
 * Where attached files live. A sibling of the uploads store, not a child of the PGLite data
 * directory -- that one belongs to Postgres and anything else in it is something a recovery
 * procedure has to reason about. See the recovery recipe in the orchestrator's CLAUDE.md for
 * what that costs.
 */
export function attachmentStoreDir(): string {
  return (
    process.env.MEMLOOM_ATTACHMENT_DIR ??
    join(process.env.MEMLOOM_HOME ?? join(homedir(), ".memloom"), "attachments")
  );
}

/** Extensions worth naming. Everything else is a download, and that is a fine thing to be. */
const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

/** What the filename says it is. `application/octet-stream` when it says nothing. */
export function mediaTypeOf(filename: string): string {
  return TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Anything that cannot be a path component.
 *
 * The filename arrives from Telegram, so it arrives from whoever sent the file. It is used
 * as a leaf name inside a directory this function created, and `..` or a separator in it
 * would put the write somewhere else entirely.
 */
function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  // The characters Windows refuses, plus anything unprintable. `\p{C}` and not an
  // explicit range: a literal control character in a source file makes it a binary blob to
  // every tool that touches it, which this line was for about ten minutes.
  const clean = base
    .replace(/[<>:"|?*]|\p{C}/gu, "")
    .replace(/^\.+/, "")
    .trim();
  return clean.slice(0, 120) || "attachment";
}

/**
 * Write one attachment into the store and return where it landed.
 *
 * A directory per attachment, named by its id, so the file keeps the name it arrived with.
 * Two photos called `IMG_0001.jpg` are two attachments and not one overwriting the other,
 * and "what was this file called" is answerable from the path alone.
 */
export async function writeAttachment(
  id: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = join(attachmentStoreDir(), id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, safeName(filename));
  await writeFile(path, bytes);
  return path;
}

/**
 * Remove one attachment's directory, and only if it is actually inside the store.
 *
 * The root check is the same one `discardUploadedFile` makes, for the same reason: a stored
 * path is data, a row could have been written by an older version or edited by hand, and
 * `rm -r` on a path that came out of a database is how a bug becomes a disaster. A path
 * outside the store is left alone rather than trusted.
 */
export async function discardAttachment(path: string): Promise<void> {
  const root = resolve(attachmentStoreDir());
  const dir = resolve(dirname(path));
  if (dir !== root && !dir.startsWith(root + sep)) return;
  if (dir === root) return; // a bare file at the root: never ours, never sweep the store
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** A fresh attachment id. Exported so the row and the directory cannot disagree. */
export function newAttachmentId(): string {
  return randomUUID();
}
