import { parentPort, workerData } from "node:worker_threads";
import { AudioError, transcribeWav, type TranscribeProgress } from "./audio.js";
import { diarizeWav } from "./diarize.js";

// The inference worker. sherpa's decode() and process() are synchronous native calls; on
// the main thread they froze the daemon for seconds per ASR chunk and for MINUTES during
// diarization, stalling every HTTP request and progress write. Here they block a thread
// nobody else needs. One worker runs one job and exits; models load per call either way,
// so a persistent worker would save nothing.
//
// Everything crossing the boundary is plain data: progress events out, a result or an
// {message, code} error object at the end. AudioError does not survive structured clone,
// so the code travels as a field and the caller rebuilds the typed error.

interface WorkerJob {
  job: "transcribe" | "diarize";
  wavPath: string;
  options: {
    numThreads?: number;
    chunkSeconds?: number;
    modelId?: string;
  };
}

async function run(): Promise<void> {
  const { job, wavPath, options } = workerData as WorkerJob;
  try {
    if (job === "transcribe") {
      const result = await transcribeWav(wavPath, {
        ...options,
        onProgress: (event: TranscribeProgress) =>
          parentPort?.postMessage({ type: "progress", event }),
      });
      parentPort?.postMessage({ type: "done", result });
    } else {
      const result = await diarizeWav(wavPath, {
        ...(options.numThreads === undefined ? {} : { numThreads: options.numThreads }),
        onProgress: (done, total) =>
          parentPort?.postMessage({
            type: "progress",
            event: { stage: "diarizing", done, total, seconds: 0, audioSeconds: 0 },
          }),
      });
      parentPort?.postMessage({ type: "done", result });
    }
  } catch (err) {
    parentPort?.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof AudioError ? err.code : null,
    });
  }
}

void run();
