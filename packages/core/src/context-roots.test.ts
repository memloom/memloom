import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";

// The store side of file sync: the roots list, the watch flags, and the missing mark. These
// are the queries the watcher runs on every tick, so their edge cases (a sibling folder with a
// longer name, a mark that is already set) are the ones that cost real work when wrong.

describe("context roots and watch state", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(256),
      llm: new NullLLMProvider(),
      dedup: false,
    });
    await memloom.init();
    const dir = await mkdtemp(join(tmpdir(), "memloom-roots-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return { memloom, dir };
  }

  async function note(dir: string, relative: string, body: string): Promise<string> {
    const path = join(dir, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
    return path;
  }

  it("records a linked folder once, however many times it is linked", async () => {
    const { memloom, dir } = await fresh();
    const first = await memloom.contextRootAdd(dir);
    const again = await memloom.contextRootAdd(dir);
    expect(again.id).toBe(first.id);
    expect(await memloom.contextRoots()).toHaveLength(1);
  });

  // Re-adding a folder is a person saying "yes, this folder", so it turns watching back on
  // rather than quietly leaving it off.
  it("re-linking a folder that was switched off turns it back on", async () => {
    const { memloom, dir } = await fresh();
    const root = await memloom.contextRootAdd(dir);
    await memloom.contextRootWatch(root.id, false);
    expect((await memloom.contextRoots())[0]?.watching).toBe(false);

    await memloom.contextRootAdd(dir);
    expect((await memloom.contextRoots())[0]?.watching).toBe(true);
  });

  it("counts the documents under a root, and not the ones under a folder that merely starts the same", async () => {
    const { memloom, dir } = await fresh();
    const audio = join(dir, "audio");
    await memloom.contextAdd({ path: await note(dir, "audio/inside.md", "# In\n\nkept") });
    await memloom.contextAdd({
      path: await note(dir, "audio-archive/outside.md", "# Out\n\nother"),
    });

    const root = await memloom.contextRootAdd(audio);
    const [listed] = await memloom.contextRoots();
    expect(listed?.id).toBe(root.id);
    // The separator is part of the prefix. Without it audio-archive counts as inside audio,
    // and every document in it would be reported missing the moment audio-archive is renamed.
    expect(listed?.documents).toBe(1);

    const under = await memloom.contextDocumentsUnder(audio);
    expect(under.map((d) => d.path)).toEqual([join(audio, "inside.md")]);
  });

  it("forgets a root without touching the documents it produced", async () => {
    const { memloom, dir } = await fresh();
    await memloom.contextAdd({ path: await note(dir, "kept.md", "# Kept\n\nstill here") });
    const root = await memloom.contextRootAdd(dir);

    expect(await memloom.contextRootRemove(root.id)).toBe(true);
    expect(await memloom.contextRoots()).toEqual([]);
    // Stop following a folder is not forget what you read in it.
    expect(await memloom.contextList()).toHaveLength(1);
  });

  it("stamps the scan watermark", async () => {
    const { memloom, dir } = await fresh();
    const root = await memloom.contextRootAdd(dir);
    expect(root.lastScanAt).toBeNull();

    const at = new Date("2026-08-03T10:11:12.000Z");
    await memloom.contextRootScanned(root.id, at);
    const [listed] = await memloom.contextRoots();
    expect(Date.parse(listed?.lastScanAt ?? "")).toBe(at.getTime());
  });

  it("switches one document off without touching the others", async () => {
    const { memloom, dir } = await fresh();
    const a = await memloom.contextAdd({ path: await note(dir, "a.md", "# A\n\nfirst") });
    await memloom.contextAdd({ path: await note(dir, "b.md", "# B\n\nsecond") });

    expect(await memloom.contextWatch(a.documentId, false)).toBe(true);
    const docs = await memloom.contextList();
    expect(docs.find((d) => d.id === a.documentId)?.watching).toBe(false);
    expect(docs.filter((d) => d.watching).map((d) => d.title)).toEqual(["B"]);
  });

  // A linked file is asking to be kept current, so watching starts on. Uploads and web pages
  // carry the column's default and are told apart by watchable, not by the flag.
  it("starts watching a linked file, and reports what has no file to watch", async () => {
    const { memloom, dir } = await fresh();
    await memloom.contextAdd({ path: await note(dir, "linked.md", "# Linked\n\nnotes") });
    await memloom.contextUpload({
      filename: "uploaded.md",
      bytes: new TextEncoder().encode("# Uploaded\n\nbytes only"),
    });

    const docs = await memloom.contextList();
    const linked = docs.find((d) => d.title === "Linked");
    const uploaded = docs.find((d) => d.title === "Uploaded");
    expect(linked?.watching).toBe(true);
    expect(linked?.watchable).toBe(true);
    expect(uploaded?.watchable).toBe(false);
  });

  it("marks a document missing once and reports whether anything changed", async () => {
    const { memloom, dir } = await fresh();
    const added = await memloom.contextAdd({ path: await note(dir, "gone.md", "# Gone\n\nbye") });

    expect(await memloom.contextMarkMissing(added.documentId, true)).toBe(true);
    // The second call changes nothing, and says so. Without this a folder emptied by an upload
    // pipeline rewrites every dead row on every rescan.
    expect(await memloom.contextMarkMissing(added.documentId, true)).toBe(false);
    expect((await memloom.contextList())[0]?.missingAt).not.toBeNull();

    expect(await memloom.contextMarkMissing(added.documentId, false)).toBe(true);
    expect(await memloom.contextMarkMissing(added.documentId, false)).toBe(false);
    expect((await memloom.contextList())[0]?.missingAt).toBeNull();
  });

  it("offers the watcher only what has a file behind it", async () => {
    const { memloom, dir } = await fresh();
    const linked = await memloom.contextAdd({ path: await note(dir, "linked.md", "# L\n\nx") });
    await memloom.contextUpload({
      filename: "uploaded.md",
      bytes: new TextEncoder().encode("# U\n\ny"),
    });
    const root = await memloom.contextRootAdd(dir);

    const targets = await memloom.syncTargets();
    expect(targets.roots.map((r) => r.id)).toEqual([root.id]);
    expect(targets.files.map((f) => f.id)).toEqual([linked.documentId]);

    // Switched off at both levels: nothing left to watch.
    await memloom.contextRootWatch(root.id, false);
    await memloom.contextWatch(linked.documentId, false);
    const off = await memloom.syncTargets();
    expect(off.roots).toEqual([]);
    expect(off.files).toEqual([]);
  });

  it("finds a document by its exact path", async () => {
    const { memloom, dir } = await fresh();
    const path = await note(dir, "exact.md", "# Exact\n\nhere");
    const added = await memloom.contextAdd({ path });

    expect(await memloom.contextDocumentByPath(path)).toEqual({
      id: added.documentId,
      watching: true,
    });
    expect(await memloom.contextDocumentByPath(join(dir, "nope.md"))).toBeNull();
  });
});
