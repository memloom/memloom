import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CATALOG,
  DEFAULT_MODEL_ID,
  findModel,
  modelStatus,
  resolveModel,
  selectedModelId,
  selectModel,
} from "./audio-models.js";

// The model layer, with a throwaway MEMLOOM_MODEL_DIR standing in for ~/.memloom/models so
// nothing here downloads anything or touches a real install.

let dir: string;
const originalDir = process.env.MEMLOOM_MODEL_DIR;
const originalModel = process.env.MEMLOOM_ASR_MODEL;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memloom-models-"));
  process.env.MEMLOOM_MODEL_DIR = dir;
  delete process.env.MEMLOOM_ASR_MODEL;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.MEMLOOM_MODEL_DIR;
  else process.env.MEMLOOM_MODEL_DIR = originalDir;
  if (originalModel === undefined) delete process.env.MEMLOOM_ASR_MODEL;
  else process.env.MEMLOOM_ASR_MODEL = originalModel;
});

/** Lay down the files an unpacked model would have, without downloading one. */
async function fakeInstall(id: string, files: string[]) {
  const model = findModel(id);
  const modelDir = join(dir, model.archive);
  await mkdir(modelDir, { recursive: true });
  for (const f of [...files, "tokens.txt"]) await writeFile(join(modelDir, f), "x");
  return modelDir;
}

describe("catalog", () => {
  it("has a default that exists in it", () => {
    expect(CATALOG.some((m) => m.id === DEFAULT_MODEL_ID)).toBe(true);
  });

  it("has unique ids and archive names", () => {
    expect(new Set(CATALOG.map((m) => m.id)).size).toBe(CATALOG.length);
    expect(new Set(CATALOG.map((m) => m.archive)).size).toBe(CATALOG.length);
  });

  it("names an unknown model's alternatives rather than failing blankly", () => {
    expect(() => findModel("gpt-voice")).toThrow(/unknown speech model.*parakeet-v3/s);
  });
});

describe("selection", () => {
  it("falls back to the default when nothing has been chosen", async () => {
    expect(await selectedModelId()).toBe(DEFAULT_MODEL_ID);
  });

  it("remembers a choice across calls", async () => {
    await selectModel("sense-voice");
    expect(await selectedModelId()).toBe("sense-voice");
  });

  it("lets the environment pin a model without changing the saved choice", async () => {
    await selectModel("sense-voice");
    process.env.MEMLOOM_ASR_MODEL = "parakeet-v2";
    expect(await selectedModelId()).toBe("parakeet-v2");
    delete process.env.MEMLOOM_ASR_MODEL;
    expect(await selectedModelId()).toBe("sense-voice");
  });

  it("ignores a saved id that is no longer in the catalog", async () => {
    await writeFile(join(dir, "selected.json"), JSON.stringify({ id: "retired-model" }));
    expect(await selectedModelId()).toBe(DEFAULT_MODEL_ID);
  });

  it("refuses to select something that does not exist", async () => {
    await expect(selectModel("nope")).rejects.toThrow(/unknown speech model/);
  });
});

describe("resolveModel", () => {
  // Each architecture takes a different config key, and passing the wrong one fails at
  // recognizer construction rather than degrading, so this is the load-bearing mapping.
  it("builds a transducer config for Parakeet", async () => {
    await fakeInstall("parakeet-v3", [
      "encoder.int8.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
    ]);
    const { config } = await resolveModel("parakeet-v3");
    expect(Object.keys(config)).toContain("transducer");
    const t = config.transducer as Record<string, string>;
    expect(t.encoder).toMatch(/encoder\.int8\.onnx$/);
    expect(t.joiner).toMatch(/joiner\.int8\.onnx$/);
  });

  it("builds a senseVoice config, which takes one model file rather than three", async () => {
    await fakeInstall("sense-voice", ["model.int8.onnx"]);
    const { config } = await resolveModel("sense-voice");
    expect(Object.keys(config)).toEqual(["senseVoice"]);
    expect((config.senseVoice as Record<string, string>).model).toMatch(/model\.int8\.onnx$/);
  });

  it("builds a moonshine config with its four separate graphs", async () => {
    await fakeInstall("moonshine-base", [
      "preprocess.onnx",
      "encode.int8.onnx",
      "uncached_decode.int8.onnx",
      "cached_decode.int8.onnx",
    ]);
    const { config } = await resolveModel("moonshine-base");
    const m = config.moonshine as Record<string, string>;
    expect(m.preprocessor).toMatch(/preprocess\.onnx$/);
    expect(m.uncachedDecoder).toMatch(/uncached_decode/);
    expect(m.cachedDecoder).toMatch(/cached_decode/);
    // The two decoders must not resolve to the same file, which a naive /decode/ match does.
    expect(m.cachedDecoder).not.toBe(m.uncachedDecoder);
  });

  it("builds a whisper config", async () => {
    await fakeInstall("whisper-base", ["base-encoder.onnx", "base-decoder.onnx"]);
    const { config } = await resolveModel("whisper-base");
    expect(Object.keys(config)).toEqual(["whisper"]);
  });

  // Upstream renames files between releases, so roles are discovered rather than hardcoded.
  it("finds files whose names carry epoch and averaging suffixes", async () => {
    await fakeInstall("parakeet-v3", [
      "encoder-epoch-30-avg-4.int8.onnx",
      "decoder-epoch-30-avg-4.int8.onnx",
      "joiner-epoch-30-avg-4.int8.onnx",
    ]);
    const { config } = await resolveModel("parakeet-v3");
    expect((config.transducer as Record<string, string>).encoder).toMatch(/epoch-30/);
  });

  it("prefers the int8 graph when both quantizations are present", async () => {
    await fakeInstall("parakeet-v3", [
      "encoder.onnx",
      "encoder.int8.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
    ]);
    const { config } = await resolveModel("parakeet-v3");
    expect((config.transducer as Record<string, string>).encoder).toMatch(/int8/);
  });

  it("says which file is missing instead of letting sherpa fail opaquely", async () => {
    await fakeInstall("parakeet-v3", ["encoder.int8.onnx", "decoder.int8.onnx"]);
    await expect(resolveModel("parakeet-v3")).rejects.toThrow(/joiner/);
  });
});

describe("modelStatus", () => {
  it("reports nothing installed on a fresh machine", async () => {
    const status = await modelStatus();
    expect(status.installed).toBe(false);
    expect(status.installedIds).toEqual([]);
    expect(status.selected.id).toBe(DEFAULT_MODEL_ID);
  });

  it("lists every installed model, not just the selected one", async () => {
    await fakeInstall("parakeet-v3", [
      "encoder.int8.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
    ]);
    await fakeInstall("sense-voice", ["model.int8.onnx"]);
    const status = await modelStatus();
    expect(status.installedIds.sort()).toEqual(["parakeet-v3", "sense-voice"]);
    expect(status.installed).toBe(true);
  });

  // A half-unpacked directory is the case that would otherwise look installed and then
  // fail at transcription time.
  it("does not count a model whose files are incomplete", async () => {
    await fakeInstall("parakeet-v3", ["encoder.int8.onnx"]);
    const status = await modelStatus();
    expect(status.installedIds).toEqual([]);
    expect(status.installed).toBe(false);
  });

  it("is not installed when the selected model is missing but another is present", async () => {
    await fakeInstall("sense-voice", ["model.int8.onnx"]);
    const status = await modelStatus();
    expect(status.selected.id).toBe(DEFAULT_MODEL_ID);
    expect(status.installed).toBe(false);
    expect(status.installedIds).toEqual(["sense-voice"]);
  });
});
