import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelDir } from "./audio.js";
import { modelStatus } from "./audio-models.js";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";

// End to end for the audio path: file -> ffmpeg -> VAD -> parakeet -> markdown with time
// headings -> chunkMarkdown -> embed -> store -> recall, with the citation pointing at a
// moment in the recording.
//
// Skipped unless the speech model is actually installed. It is 641 MB and fetched by
// `memloom audio setup`, so requiring it here would make a normal `pnpm test` download most
// of a gigabyte. The sample it uses ships inside the model archive, which keeps a binary
// audio fixture out of the repo.
const status = await modelStatus();
const sample = join(
  modelDir(),
  "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  "test_wavs",
  "en.wav",
);
const ready = status.installed && existsSync(sample);

describe.skipIf(!ready)("context connector: audio", () => {
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
    return memloom;
  }

  it("transcribes a recording and recalls it with a timestamp as the citation", async () => {
    const memloom = await fresh();
    const added = await memloom.contextAdd({ path: sample });

    expect(added.outcome).toBe("added");
    expect(added.chunks).toBeGreaterThan(0);

    const results = await memloom.recall("what your country can do for you");
    const chunk = results.find((r) => r.kind === "context");
    expect(chunk).toBeDefined();
    // The citation unit for audio is a time range, carried in heading_path with no new
    // column, so describeSource renders "from en.wav > 0:00 - 0:03".
    expect(chunk?.source?.headingPath).toMatch(/^\d+:\d{2}( - |$)/);
    expect(chunk?.source?.page).toBeNull();
  }, 120_000);

  it("stores it as an audio document", async () => {
    const memloom = await fresh();
    await memloom.contextAdd({ path: sample });
    const [doc] = await memloom.contextList();
    expect(doc?.kind).toBe("audio");
  }, 120_000);

  it("dates the document by when the recording was made, not when it was ingested", async () => {
    // The end of the wearable chain, on a real recording: a device stamps its own filename,
    // the file is copied across days later, and the document still carries the moment it
    // happened rather than the minute the copy finished.
    const { copyFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "memloom-stamped-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const stamped = join(dir, "REC_20260514_093100.wav");
    await copyFile(sample, stamped);

    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(256),
      llm: new NullLLMProvider(),
      dedup: false,
    });
    await memloom.init();
    const added = await memloom.contextAdd({ path: stamped });

    const rows = await storage.query<{ created_at: string | Date }>(
      "SELECT created_at FROM context_documents WHERE id = $1",
      [added.documentId],
    );
    const at = new Date(rows[0]?.created_at ?? 0);
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(4);
    expect(at.getDate()).toBe(14);
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(31);

    // And the transcript says so in words, for anything reading the text rather than the row.
    const chunks = await storage.query<{ content: string }>(
      "SELECT content FROM context_chunks WHERE document_id = $1 ORDER BY chunk_index",
      [added.documentId],
    );
    expect(chunks[0]?.content).toContain("2026-05-14 09:31:00");
    expect(chunks[0]?.content).toContain("file name");
  }, 180_000);

  it("re-adding the same recording is a no-op and does not transcribe twice", async () => {
    const memloom = await fresh();
    const first = await memloom.contextAdd({ path: sample });

    const startedAt = Date.now();
    const again = await memloom.contextAdd({ path: sample });
    const elapsed = Date.now() - startedAt;

    expect(again.outcome).toBe("unchanged");
    expect(again.documentId).toBe(first.documentId);
    // The hash is taken over the source bytes rather than the transcript, so an unchanged
    // recording settles without paying for ASR at all. Loading the model alone costs about
    // seven seconds, so anything near that means the second pass transcribed again.
    expect(elapsed).toBeLessThan(5_000);
  }, 180_000);
});
