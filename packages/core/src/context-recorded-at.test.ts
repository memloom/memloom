import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerExtractor } from "./extract.js";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";

// A document is a mirror of something that existed before memloom saw it, so when the
// extractor knows when that something was made, that is the document's created_at. This
// covers the store wiring with a stand-in extractor; the real end of it (a recording whose
// filename carries a stamp) lives in context-audio.test.ts, behind the model download.

const RECORDED = new Date("2026-05-14T09:31:00.000Z");

// Two extensions: one that reports a recording time, one that does not, so the "leave every
// other format alone" half of the behavior is asserted rather than assumed.
registerExtractor({
  kind: "fake-recording",
  extensions: [".rec"],
  version: 1,
  chunker: "markdown",
  async extract() {
    return {
      units: [{ text: "## 0:00 - 2:00\n\nsomething was said here", page: null }],
      recordedAt: RECORDED,
    };
  },
});

registerExtractor({
  kind: "fake-note",
  extensions: [".note"],
  version: 1,
  chunker: "markdown",
  async extract() {
    return { units: [{ text: "## heading\n\nplain text with no recording time", page: null }] };
  },
});

describe("recorded-at stamping", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh(): Promise<{ memloom: Memloom; storage: StorageAdapter }> {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(256),
      llm: new NullLLMProvider(),
      dedup: false,
    });
    await memloom.init();
    return { memloom, storage };
  }

  async function withFile(name: string, body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "memloom-rec-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, name);
    await writeFile(path, body);
    return path;
  }

  const createdAt = async (storage: StorageAdapter, table: string, id: string) => {
    const column = table === "context_documents" ? "id" : "document_id";
    const rows = await storage.query<{ created_at: string | Date }>(
      `SELECT created_at FROM ${table} WHERE ${column} = $1 ORDER BY created_at LIMIT 1`,
      [id],
    );
    return new Date(rows[0]?.created_at ?? 0);
  };

  it("stamps the document with when it was recorded, not when it was read", async () => {
    const { memloom, storage } = await fresh();
    const added = await memloom.contextAdd({ path: await withFile("clip.rec", "x") });
    const stamped = await createdAt(storage, "context_documents", added.documentId);
    expect(stamped.toISOString()).toBe(RECORDED.toISOString());
  }, 120_000);

  it("stamps the chunks too, because that is what a recalled hit reports", async () => {
    // mapRecallRow reports the CHUNK's created_at as a context hit's assertedAt, so a
    // document-only stamp would still have every recalled line dated to the ingest.
    const { memloom, storage } = await fresh();
    const added = await memloom.contextAdd({ path: await withFile("clip.rec", "x") });
    const stamped = await createdAt(storage, "context_chunks", added.documentId);
    expect(stamped.toISOString()).toBe(RECORDED.toISOString());

    const [hit] = await memloom.recall("something was said");
    expect(hit?.kind).toBe("context");
    expect(new Date(hit?.assertedAt ?? 0).toISOString()).toBe(RECORDED.toISOString());
  }, 120_000);

  it("leaves a format with no recording time on ingest time", async () => {
    const { memloom, storage } = await fresh();
    const before = Date.now();
    const added = await memloom.contextAdd({ path: await withFile("memo.note", "x") });
    const stamped = await createdAt(storage, "context_documents", added.documentId);
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  }, 120_000);

  it("keeps the recording time when the file is re-ingested with new content", async () => {
    const { memloom, storage } = await fresh();
    const path = await withFile("clip.rec", "first");
    const first = await memloom.contextAdd({ path });
    await writeFile(path, "second");
    const again = await memloom.contextAdd({ path });
    expect(again.documentId).toBe(first.documentId);
    const stamped = await createdAt(storage, "context_documents", again.documentId);
    expect(stamped.toISOString()).toBe(RECORDED.toISOString());
  }, 120_000);

  it("sorts a batch by when it happened, not by the minute it was all copied across", async () => {
    // The whole point for a wearable dump: twenty clips copied in one go carry twenty
    // different dates, in the order they were actually recorded.
    const { memloom, storage } = await fresh();
    for (const name of ["a.rec", "b.note", "c.rec"]) {
      await memloom.contextAdd({ path: await withFile(name, name) });
    }
    const rows = await storage.query<{ path: string; created_at: string | Date }>(
      "SELECT path, created_at FROM context_documents ORDER BY created_at",
    );
    // Both recordings sort ahead of the note, which is stamped now.
    expect(rows.slice(0, 2).every((r) => r.path.endsWith(".rec"))).toBe(true);
    expect(rows[2]?.path.endsWith(".note")).toBe(true);
  }, 120_000);
});
