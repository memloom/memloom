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
