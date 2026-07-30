import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AudioError, modelDir } from "./audio.js";

// Which speech model transcribes, and getting it onto the machine.
//
// Models are not shipped with memloom and cannot be: the default recognizer alone is 641 MB
// unpacked. They are fetched once into ~/.memloom/models and shared by every project.
//
// Everything here comes from the k2-fsa/sherpa-onnx `asr-models` release, which is the same
// project that publishes the runtime, so the ONNX graphs are known to load. That constraint
// is why this catalog cannot simply mirror what a GGUF-based app like Handy offers: those
// are a different file format for a different engine.

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/**
 * How a model's files are wired into the recognizer. sherpa-onnx takes a different config
 * key per architecture, and passing the wrong one fails at construction rather than
 * degrading, so this is carried explicitly rather than inferred from the name.
 */
export type ModelArchitecture = "transducer" | "senseVoice" | "moonshine" | "whisper";

export interface CatalogModel {
  id: string;
  /** Directory the archive unpacks into, which is also its name in the release. */
  archive: string;
  architecture: ModelArchitecture;
  label: string;
  /** Compressed download size in MB, from the GitHub release. */
  downloadMb: number;
  languages: string;
  /** What this model is actually for, in one line. */
  note: string;
}

/**
 * The curated set. Deliberately small: every extra row is a download a user has to reason
 * about, and the honest answer for most people is the default. Ordered by how often the
 * right answer is "this one".
 *
 * Sizes verified against the GitHub release on 2026-07-29.
 */
export const CATALOG: readonly CatalogModel[] = [
  {
    id: "parakeet-v3",
    archive: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    architecture: "transducer",
    label: "Parakeet TDT 0.6b v3",
    downloadMb: 465,
    languages: "25 European languages, including Polish, Russian and Ukrainian",
    note: "The default. Fast, accurate, and the only one here that covers Slavic languages.",
  },
  {
    id: "parakeet-v2",
    archive: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    architecture: "transducer",
    label: "Parakeet TDT 0.6b v2",
    downloadMb: 460,
    languages: "English only",
    note: "Slightly stronger on English than v3, at the cost of every other language.",
  },
  {
    id: "sense-voice",
    archive: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
    architecture: "senseVoice",
    label: "SenseVoice",
    downloadMb: 158,
    languages: "Chinese, English, Japanese, Korean, Cantonese",
    // Verified on 2026-07-29: it returns "AK NOT WHAT YOUR COUNTRY CAN DO FOR YOU" where
    // Parakeet returns "Ask not what your country can do for you,". Recall is case and
    // punctuation insensitive so this costs little there, but quoted passages read badly.
    note: "The Asian-language gap Parakeet does not cover. Returns uppercase, unpunctuated text.",
  },
  {
    id: "moonshine-base",
    archive: "sherpa-onnx-moonshine-base-en-int8",
    architecture: "moonshine",
    label: "Moonshine base",
    downloadMb: 239,
    languages: "English only",
    note: "Small and quick. A reasonable choice on a machine that struggles with Parakeet.",
  },
  {
    id: "parakeet-110m",
    archive: "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8",
    architecture: "transducer",
    label: "Parakeet TDT-CTC 110m",
    downloadMb: 100,
    languages: "English only",
    note: "The smallest useful option. Noticeably weaker, but it runs anywhere.",
  },
  {
    id: "whisper-base",
    archive: "sherpa-onnx-whisper-base",
    architecture: "whisper",
    label: "Whisper base",
    downloadMb: 198,
    languages: "99 languages",
    note: "Widest language coverage by far, and the weakest quality of the set.",
  },
];

export const DEFAULT_MODEL_ID = "parakeet-v3";

export function findModel(id: string): CatalogModel {
  const model = CATALOG.find((m) => m.id === id);
  if (!model) {
    throw new AudioError(
      `unknown speech model "${id}". Available: ${CATALOG.map((m) => m.id).join(", ")}`,
      "no_model",
    );
  }
  return model;
}

/** Which model transcription should use. Env wins so a run can be pinned without config. */
export async function selectedModelId(): Promise<string> {
  const fromEnv = process.env.MEMLOOM_ASR_MODEL;
  if (fromEnv) return fromEnv;
  try {
    const raw = await readFile(join(modelDir(), "selected.json"), "utf8");
    const parsed = JSON.parse(raw) as { id?: string };
    return parsed.id && CATALOG.some((m) => m.id === parsed.id) ? parsed.id : DEFAULT_MODEL_ID;
  } catch {
    return DEFAULT_MODEL_ID;
  }
}

export async function selectModel(id: string): Promise<CatalogModel> {
  const model = findModel(id);
  await mkdir(modelDir(), { recursive: true });
  await writeFile(join(modelDir(), "selected.json"), JSON.stringify({ id: model.id }));
  return model;
}

// ---------------------------------------------------------------------------------------
// Resolving the files inside an unpacked model
// ---------------------------------------------------------------------------------------

/**
 * The archives do not use one naming convention: an encoder may be `encoder.int8.onnx`,
 * `encoder-epoch-30-avg-4.int8.onnx` or `tiny-encoder.onnx` depending on the model and when
 * it was published. Hardcoding filenames would mean this breaks whenever upstream renames
 * something, so the files are discovered by role instead.
 */
async function findOnnx(dir: string, patterns: RegExp[]): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const onnx = entries.filter((f) => f.endsWith(".onnx"));
  for (const pattern of patterns) {
    // int8 is preferred wherever both exist: it is what the sizes above assume and what the
    // measured speed numbers were taken on.
    const matches = onnx.filter((f) => pattern.test(f));
    const quantized = matches.find((f) => /int8|quant/i.test(f));
    if (quantized) return join(dir, quantized);
    if (matches[0]) return join(dir, matches[0]);
  }
  return null;
}

export interface ResolvedModel {
  model: CatalogModel;
  dir: string;
  tokens: string;
  /** Ready to drop into sherpa's modelConfig under the architecture's key. */
  config: Record<string, unknown>;
}

/**
 * An installed model's files, resolved and checked. Throws rather than returning a partial
 * config, because sherpa reports a missing file as an opaque construction failure.
 */
export async function resolveModel(id?: string): Promise<ResolvedModel> {
  const model = findModel(id ?? (await selectedModelId()));
  const dir = join(modelDir(), model.archive);
  const tokens = join(dir, "tokens.txt");

  const need = async (role: string, patterns: RegExp[]): Promise<string> => {
    const found = await findOnnx(dir, patterns);
    if (!found) {
      throw new AudioError(
        `the ${model.label} model is missing its ${role} file in ${dir}. ` +
          `Run: memloom audio setup ${model.id}`,
        "no_model",
      );
    }
    return found;
  };

  let config: Record<string, unknown>;
  switch (model.architecture) {
    case "transducer":
      config = {
        transducer: {
          encoder: await need("encoder", [/^encoder/i, /encoder/i]),
          decoder: await need("decoder", [/^decoder/i, /decoder/i]),
          joiner: await need("joiner", [/^joiner/i, /joiner/i]),
        },
        modelType: "nemo_transducer",
      };
      break;
    case "senseVoice":
      config = {
        senseVoice: {
          model: await need("model", [/^model/i, /\.onnx$/]),
          useInverseTextNormalization: 1,
        },
      };
      break;
    case "moonshine":
      config = {
        moonshine: {
          preprocessor: await need("preprocessor", [/preprocess/i]),
          encoder: await need("encoder", [/encode/i]),
          uncachedDecoder: await need("uncached decoder", [/uncached[_-]?decode/i]),
          cachedDecoder: await need("cached decoder", [/^cached[_-]?decode/i, /cached[_-]?decode/i]),
        },
      };
      break;
    case "whisper":
      config = {
        whisper: {
          encoder: await need("encoder", [/encoder/i]),
          decoder: await need("decoder", [/decoder/i]),
        },
      };
      break;
  }

  return { model, dir, tokens, config };
}

// ---------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------

export interface ModelStatus {
  dir: string;
  /** The model transcription would use right now. */
  selected: CatalogModel;
  installed: boolean;
  /** Every catalog model already on disk, so a user can switch without re-downloading. */
  installedIds: string[];
}

async function isInstalled(model: CatalogModel): Promise<boolean> {
  const dir = join(modelDir(), model.archive);
  try {
    // A truncated download leaves a real file behind, so presence alone is not enough.
    const tokens = await stat(join(dir, "tokens.txt"));
    if (tokens.size === 0) return false;
  } catch {
    return false;
  }
  try {
    await resolveModel(model.id);
    return true;
  } catch {
    return false;
  }
}

export async function modelStatus(): Promise<ModelStatus> {
  const selected = findModel(await selectedModelId());
  const installedIds: string[] = [];
  for (const model of CATALOG) {
    if (await isInstalled(model)) installedIds.push(model.id);
  }
  return {
    dir: modelDir(),
    selected,
    installed: installedIds.includes(selected.id),
    installedIds,
  };
}

export async function requireModels(): Promise<void> {
  const status = await modelStatus();
  if (status.installed) return;
  throw new AudioError(
    `the ${status.selected.label} speech model is not installed in ${status.dir}. ` +
      `Run: memloom audio setup${status.selected.id === DEFAULT_MODEL_ID ? "" : ` ${status.selected.id}`}`,
    "no_model",
  );
}

export interface DownloadProgress {
  file: string;
  receivedBytes: number;
  totalBytes: number | null;
}

async function download(
  url: string,
  destination: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new AudioError(`could not download ${url}: HTTP ${response.status}`, "no_model");
  }
  const totalBytes = Number(response.headers.get("content-length") ?? "0") || null;
  let receivedBytes = 0;

  // Written to a .part file and renamed only on success, so an interrupted download can
  // never masquerade as an installed model.
  const partial = `${destination}.part`;
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    receivedBytes += chunk.length;
    onProgress?.({ file: basename(destination), receivedBytes, totalBytes });
  });
  await pipeline(body, createWriteStream(partial));
  await rename(partial, destination);
}

export interface SetupOptions {
  onProgress?: (p: DownloadProgress) => void;
  onStage?: (stage: string) => void;
  /** Which catalog model to install. Defaults to the selected one. */
  modelId?: string;
}

/**
 * Fetch and unpack a model. Idempotent, so it is safe to call before every transcription.
 * The VAD is fetched alongside the first model since every model needs it.
 */
export async function setupModels(options: SetupOptions = {}): Promise<ModelStatus> {
  const model = findModel(options.modelId ?? (await selectedModelId()));
  const dir = modelDir();
  await mkdir(dir, { recursive: true });

  const vad = join(dir, "silero_vad.onnx");
  const haveVad = await stat(vad).then((s) => s.size > 0).catch(() => false);
  if (!haveVad) {
    options.onStage?.("downloading voice activity detector (0.6 MB)");
    await download(`${RELEASE}/silero_vad.onnx`, vad, options.onProgress);
  }

  if (!(await isInstalled(model))) {
    options.onStage?.(`downloading ${model.label} (${model.downloadMb} MB)`);
    const archive = join(dir, `${model.archive}.tar.bz2`);
    await download(`${RELEASE}/${model.archive}.tar.bz2`, archive, options.onProgress);
    options.onStage?.(`unpacking ${model.label}`);
    await extractTarBz2(archive, dir);
    await rm(archive, { force: true });
  }

  if (!(await isInstalled(model))) {
    throw new AudioError(
      `${model.label} finished downloading but its files are still not usable in ${dir}`,
      "no_model",
    );
  }
  return modelStatus();
}

/**
 * Unpack with the system tar, which exists on Windows 10+, macOS and Linux alike.
 *
 * The archive is named relative to `into` and tar is run with that as its working
 * directory, so no absolute path is ever passed. That matters on Windows: GNU tar reads
 * "D:\..." as a remote host spec and needs --force-local, while the bsdtar that ships in
 * System32 rejects that flag outright. Passing a bare filename sidesteps both.
 */
async function extractTarBz2(archive: string, into: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xjf", basename(archive)], {
      cwd: into,
      stdio: ["ignore", "ignore", "pipe"],
      // Without this Windows gives a console program its own window whenever the parent has
      // no console, which the detached daemon does not. Unpacking would flash a black box.
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", () =>
      reject(new AudioError("tar is required to unpack the speech model", "no_model")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new AudioError(`could not unpack the speech model: ${stderr.trim()}`, "no_model")),
    );
  });
}
