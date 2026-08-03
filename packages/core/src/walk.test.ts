import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderPrefix, hasDiskPath, walkSupportedFiles } from "./walk.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memloom-walk-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(relative: string, body = "x"): Promise<string> {
  const path = join(dir, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
  return path;
}

describe("walkSupportedFiles", () => {
  it("finds supported files and skips the rest", async () => {
    await file("notes.md");
    await file("readme.txt");
    await file("binary.exe");
    const { files, capped } = await walkSupportedFiles(dir);
    const names = files.map((f) => f.path.split(/[\\/]/).pop()).sort();
    expect(names).toEqual(["notes.md", "readme.txt"]);
    expect(capped).toBe(false);
  });

  it("skips hidden and dependency directories", async () => {
    await file("kept.md");
    await file(".git/config.md");
    await file("node_modules/pkg/readme.md");
    await file("dist/out.md");
    const { files } = await walkSupportedFiles(dir);
    expect(files.map((f) => f.path)).toEqual([join(dir, "kept.md")]);
  });

  it("stops at maxDepth", async () => {
    await file("a/b/deep.md");
    expect((await walkSupportedFiles(dir, { maxDepth: 5 })).files).toHaveLength(1);
    expect((await walkSupportedFiles(dir, { maxDepth: 1 })).files).toHaveLength(0);
  });

  // The cap protects someone who typed the wrong folder into a text box. Trimming is fine;
  // trimming SILENTLY is not, because 3 of 10 files reads exactly like a folder of 3.
  it("reports that the cap trimmed the result rather than looking complete", async () => {
    for (let i = 0; i < 10; i++) await file(`note-${i}.md`);
    const trimmed = await walkSupportedFiles(dir, { maxFiles: 3 });
    expect(trimmed.files).toHaveLength(3);
    expect(trimmed.capped).toBe(true);

    const whole = await walkSupportedFiles(dir, { maxFiles: 10 });
    expect(whole.files).toHaveLength(10);
    expect(whole.capped).toBe(false);
  });

  // A rescan of a watched folder passes Infinity, because the folder was chosen deliberately
  // and stopping at 500 would mean ignoring every recording after the five hundredth forever.
  it("takes an unbounded walk for a rescan", async () => {
    for (let i = 0; i < 12; i++) await file(`note-${i}.md`);
    const { files, capped } = await walkSupportedFiles(dir, {
      maxFiles: Number.POSITIVE_INFINITY,
    });
    expect(files).toHaveLength(12);
    expect(capped).toBe(false);
  });

  // The rescan filters on this instead of reading every file, so a wrong mtime means either a
  // missed recording or a re-read of the whole folder every tick.
  it("carries each file's modification time out of the walk", async () => {
    const path = await file("old.md");
    const when = new Date("2020-01-02T03:04:05Z");
    await utimes(path, when, when);
    const { files } = await walkSupportedFiles(dir);
    expect(files[0]?.mtimeMs).toBe(when.getTime());
  });

  it("returns nothing for a folder that is not there", async () => {
    const { files, capped } = await walkSupportedFiles(join(dir, "gone"));
    expect(files).toEqual([]);
    expect(capped).toBe(false);
  });
});

describe("hasDiskPath", () => {
  it("accepts real paths on both platforms", () => {
    expect(hasDiskPath("C:\\recordings\\a.wav")).toBe(true);
    expect(hasDiskPath("/home/me/notes.md")).toBe(true);
    // A UNC share is still a file the watcher can poll.
    expect(hasDiskPath("\\\\nas\\audio\\a.wav")).toBe(true);
  });

  it("rejects the provenances that have no file behind them", () => {
    expect(hasDiskPath("upload://report.pdf")).toBe(false);
    expect(hasDiskPath("attachment://session/notes.md")).toBe(false);
    expect(hasDiskPath("https://example.com/page")).toBe(false);
  });
});

// A drive root already ends in a separator, so appending another made "D:\\", a prefix of no
// path on earth. Every document under that root then looked absent: the count read 0, and the
// rescan saw an empty "already known" set, so it re-offered every file on the drive every tick
// and never noticed a deleted one.
describe("folderPrefix", () => {
  const B = String.fromCharCode(92);

  it("appends the separator the path already uses", () => {
    expect(folderPrefix(`D:${B}audio`)).toBe(`D:${B}audio${B}`);
    expect(folderPrefix("/x/audio")).toBe("/x/audio/");
  });

  it("leaves a path that already ends in a separator alone", () => {
    expect(folderPrefix(`D:${B}`)).toBe(`D:${B}`);
    expect(folderPrefix("/")).toBe("/");
    expect(folderPrefix(`D:${B}audio${B}`)).toBe(`D:${B}audio${B}`);
    expect(folderPrefix("/x/audio/")).toBe("/x/audio/");
  });

  // The whole point of the trailing separator: a sibling whose name merely starts the same is
  // not inside the folder.
  it("does not make a look-alike sibling look like it is inside", () => {
    const prefix = folderPrefix(`D:${B}audio`);
    expect(`D:${B}audio${B}in.md`.startsWith(prefix)).toBe(true);
    expect(`D:${B}audio-archive${B}out.md`.startsWith(prefix)).toBe(false);
  });
});
