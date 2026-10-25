import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { mediaTypeOf } from "./memory-attachments.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";

// Files hanging off a memory. "i wanna be able to attach a file/video/image for the memory,
// so i can save memory and i also take a picture for more context of what it looks like."
//
// The test that matters is the one about editing. `update()` appends a version and stales
// the old row, so an attachment keyed to a version id disappears the first time anybody
// corrects the wording -- and the orchestrator's assistant can revise memories on its own
// now. Keying on root_id is the whole schema decision and this is what holds it.

const bytes = (text: string) => new TextEncoder().encode(text);

let storage: StorageAdapter;
let store: string;
const previous = process.env.MEMLOOM_ATTACHMENT_DIR;

beforeAll(async () => {
  storage = await PgliteAdapter.open();
  // A real directory, because "the store owns the bytes" is the claim under test and a
  // mocked filesystem would let a broken path pass.
  store = await mkdtemp(join(tmpdir(), "memloom-attach-"));
  process.env.MEMLOOM_ATTACHMENT_DIR = store;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.MEMLOOM_ATTACHMENT_DIR;
  else process.env.MEMLOOM_ATTACHMENT_DIR = previous;
  await rm(store, { recursive: true, force: true }).catch(() => {});
  await storage.close?.();
});

async function fresh(): Promise<Memloom> {
  await truncateAll(storage);
  const m = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(256),
    llm: new NullLLMProvider(),
    dedup: false,
  });
  await m.init();
  return m;
}

describe("attaching a file to a memory", () => {
  it("copies the bytes into the store and hands back where they landed", async () => {
    const m = await fresh();
    const { id } = await m.save({ content: "the router lives behind the tv" });

    const a = await m.memoryAttach({
      memoryId: id,
      filename: "IMG_0001.jpg",
      bytes: bytes("not really a jpeg"),
    });

    expect(a.name).toBe("IMG_0001.jpg");
    expect(a.mediaType).toBe("image/jpeg");
    expect(a.bytes).toBe(17);
    expect(a.path.startsWith(store)).toBe(true);
    expect(new TextDecoder().decode(await readFile(a.path))).toBe("not really a jpeg");
  });

  it("SURVIVES AN EDIT, which is why it is keyed on the lineage", async () => {
    // The failure this prevents: attach a photo, correct a typo in the memory, photo gone.
    // `update` writes a NEW row with a new id, so anything keyed to the id it was attached
    // to is orphaned by an ordinary edit.
    const m = await fresh();
    const saved = await m.save({ content: "the router lives behind the tv" });
    await m.memoryAttach({ memoryId: saved.id, filename: "router.jpg", bytes: bytes("photo") });

    const edited = await m.update({ id: saved.id, content: "the router lives behind the sofa" });
    expect(edited.id).not.toBe(saved.id);

    const after = await m.memoryAttachments(edited.id);
    expect(after.map((a) => a.name)).toEqual(["router.jpg"]);
  });

  it("is reachable from any version of the belief, old or new", async () => {
    const m = await fresh();
    const saved = await m.save({ content: "the boiler code is on the inside of the door" });
    await m.memoryAttach({ memoryId: saved.id, filename: "boiler.png", bytes: bytes("x") });
    const edited = await m.update({ id: saved.id, content: "the boiler code is inside the door" });

    expect((await m.memoryAttachments(saved.id)).length).toBe(1);
    expect((await m.memoryAttachments(edited.id)).length).toBe(1);
  });

  it("refuses a memory that does not exist, and writes nothing", async () => {
    const m = await fresh();
    await expect(
      m.memoryAttach({
        memoryId: "00000000-0000-0000-0000-000000000000",
        filename: "x.jpg",
        bytes: bytes("x"),
      }),
    ).rejects.toThrow(/no memory/);
  });

  it("keeps two files of the same name apart", async () => {
    // A directory per attachment, so `IMG_0001.jpg` twice is two photos and not one
    // overwriting the other. Phones produce this constantly.
    const m = await fresh();
    const { id } = await m.save({ content: "two pictures of the same shelf" });
    const one = await m.memoryAttach({ memoryId: id, filename: "IMG_0001.jpg", bytes: bytes("a") });
    const two = await m.memoryAttach({
      memoryId: id,
      filename: "IMG_0001.jpg",
      bytes: bytes("bb"),
    });

    expect(one.path).not.toBe(two.path);
    expect((await m.memoryAttachments(id)).length).toBe(2);
    expect(new TextDecoder().decode(await readFile(one.path))).toBe("a");
    expect(new TextDecoder().decode(await readFile(two.path))).toBe("bb");
  });
});

describe("what comes back with a memory", () => {
  it("recall carries the attachments", async () => {
    const m = await fresh();
    const { id } = await m.save({ content: "the spare key is under the third pot" });
    await m.memoryAttach({ memoryId: id, filename: "pot.jpg", bytes: bytes("photo") });

    const hits = await m.recall("spare key under the pot");
    const hit = hits.find((h) => h.rootId && h.content.includes("spare key"));
    expect(hit?.attachments?.map((a) => a.name)).toEqual(["pot.jpg"]);
  });

  it("leaves the field alone on a memory with none", async () => {
    // Empty for almost every memory, so it must be absent rather than `[]` everywhere:
    // `attachments` present and empty reads as "we looked and there are none", which is
    // true here and would be a lie on a surface that never asked.
    const m = await fresh();
    await m.save({ content: "gosha owes me 68 zloty" });
    const hits = await m.recall("gosha owes money");
    expect(hits[0]?.attachments).toBeUndefined();
  });
});

describe("taking one off", () => {
  it("deletes the row and the file", async () => {
    const m = await fresh();
    const { id } = await m.save({ content: "the fuse box is in the hall cupboard" });
    const a = await m.memoryAttach({ memoryId: id, filename: "fuses.jpg", bytes: bytes("photo") });

    await m.memoryDetach(a.id);
    expect(await m.memoryAttachments(id)).toEqual([]);
    await expect(stat(a.path)).rejects.toThrow();
  });

  it("deleting the memory takes its files with it", async () => {
    // The rule the orchestrator is under too: a deleted belief must not leave a photo of
    // itself on disk. `deleteMemory` collects the paths inside the transaction and unlinks
    // after it commits, because a filesystem delete cannot be rolled back.
    const m = await fresh();
    const { id } = await m.save({ content: "the meter reading was 40912 on tuesday" });
    const a = await m.memoryAttach({ memoryId: id, filename: "meter.jpg", bytes: bytes("photo") });

    await m.deleteMemory(id);
    await expect(stat(a.path)).rejects.toThrow();
  });

  it("refuses an attachment that does not exist", async () => {
    const m = await fresh();
    await expect(m.memoryDetach("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /no attachment/,
    );
  });
});

describe("mediaTypeOf", () => {
  it("names what it knows", () => {
    expect(mediaTypeOf("a.jpg")).toBe("image/jpeg");
    expect(mediaTypeOf("A.JPEG")).toBe("image/jpeg");
    expect(mediaTypeOf("clip.mp4")).toBe("video/mp4");
    expect(mediaTypeOf("notes.pdf")).toBe("application/pdf");
  });

  it("calls everything else a download, which is a fine thing to be", () => {
    expect(mediaTypeOf("archive.7z")).toBe("application/octet-stream");
    expect(mediaTypeOf("noextension")).toBe("application/octet-stream");
  });
});
