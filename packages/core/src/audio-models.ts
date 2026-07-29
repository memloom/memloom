import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AudioError, modelDir } from "./audio.js";

// The ASR models are not shipped with memloom and cannot be: the recognizer alone is 641 MB
// unpacked. They are fetched once into ~/.memloom/models and shared by every project on the
// machine, from the k2-fsa release that sherpa-onnx itself publishes.

const ASR_DIR = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/** Files that must exist before a transcription can start. */
const REQUIRED = [
  join(ASR_DIR, "encoder.int8.onnx"),
  join(ASR_DIR, "decoder.int8.onnx"),
  join(ASR_DIR, "joiner.int8.onnx"),
  join(ASR_DIR, "tokens.txt"),
  "silero_vad.onnx",
];

export interface ModelStatus {
  dir: string;
  installed: boolean;
  missing: string[];
}

export async function modelStatus(): Promise<ModelStatus> {
  const dir = modelDir();
  const missing: string[] = [];
  for (const rel of REQUIRED) {
    try {
      const info = await stat(join(dir, rel));
      // A truncated download leaves a real file behind, so presence alone is not enough.
      if (info.size === 0) missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { dir, installed: missing.length === 0, missing };
}

export async function requireModels(): Promise<void> {
  const status = await modelStatus();
  if (status.installed) return;
  throw new AudioError(
    `the speech model is not installed (missing ${status.missing.length} file(s) in ${status.dir}). ` +
      "Run: memloom audio setup",
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
    onProgress?.({ file: destination, receivedBytes, totalBytes });
  });
  await pipeline(body, createWriteStream(partial));
  await rename(partial, destination);
}

export interface SetupOptions {
  onProgress?: (p: DownloadProgress) => void;
  onStage?: (stage: string) => void;
}

/**
 * Fetch and unpack the models. Idempotent: an already-complete install returns immediately,
 * so this is safe to call before every transcription.
 */
export async function setupModels(options: SetupOptions = {}): Promise<ModelStatus> {
  const before = await modelStatus();
  if (before.installed) return before;

  const dir = before.dir;
  await mkdir(dir, { recursive: true });

  if (before.missing.includes("silero_vad.onnx")) {
    options.onStage?.("downloading voice activity detector (0.6 MB)");
    await download(`${RELEASE}/silero_vad.onnx`, join(dir, "silero_vad.onnx"), options.onProgress);
  }

  if (before.missing.some((m) => m.startsWith(ASR_DIR))) {
    options.onStage?.("downloading speech model (465 MB)");
    const archive = join(dir, "parakeet.tar.bz2");
    await download(
      `${RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
      archive,
      options.onProgress,
    );
    options.onStage?.("unpacking speech model (641 MB on disk)");
    await extractTarBz2(archive, dir);
    await rm(archive, { force: true });
  }

  const after = await modelStatus();
  if (!after.installed) {
    throw new AudioError(
      `the model download finished but ${after.missing.join(", ")} is still missing from ${dir}`,
      "no_model",
    );
  }
  return after;
}

/**
 * Unpack with the system tar, which exists on Windows 10+, macOS and Linux alike.
 *
 * `--force-local` is required on Windows: without it tar reads "D:\..." as a remote host
 * spec and fails with "Cannot connect to D". Harmless everywhere else.
 */
async function extractTarBz2(archive: string, into: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["--force-local", "-xjf", archive, "-C", into], {
      stdio: ["ignore", "ignore", "pipe"],
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
