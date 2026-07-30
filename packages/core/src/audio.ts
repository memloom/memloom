import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedUnit } from "./extract.js";

// Audio and video -> a timestamped transcript, entirely on this machine. ffmpeg normalizes
// whatever container the user has into 16 kHz mono PCM, silero VAD finds the speech, and
// NVIDIA's parakeet-tdt-0.6b-v3 running under sherpa-onnx decodes it. Nothing is uploaded.
//
// Two numbers in here were measured rather than guessed, on 2026-07-29. Both are recorded in
// SWEEP-asr-chunking.md next to the plan.

/**
 * How much audio goes into one decode() call.
 *
 * This is the whole performance story. VAD emits speech segments averaging about 4.5
 * seconds, and decoding each one on its own means paying fixed ONNX Runtime setup once per
 * segment: 108 calls for a 10-minute file, real-time factor 0.769, so an hour of audio cost
 * about 46 minutes. Batching those segments into 60-second chunks drops it to 11 calls and
 * RTF 0.129 to 0.175, which is 8 to 11 minutes per hour.
 *
 * Longer is NOT better past this point. Self-attention cost grows with the square of the
 * chunk length, so it cancels the saving: measured RTF was 0.187 at 45 s, 0.129 at 60 s,
 * 0.134 at 90 s and 0.141 at 120 s on the same clip. The curve is flat between 45 and 120
 * and turns back up after, so this is a broad basin rather than a knife edge, and 60 is
 * picked from the middle of it on memory and safety rather than on a speed difference that
 * sits inside the measurement noise.
 */
export const DECODE_CHUNK_SECONDS = 60;

/**
 * Hard ceiling from the model, not a preference. Past roughly 400 seconds in one pass the
 * encoder's relative-position table overflows and ONNX Runtime throws a broadcast error
 * inside the self-attention layer. Nothing degrades gracefully, so stay well under.
 */
export const MAX_DECODE_CHUNK_SECONDS = 300;

/**
 * How much audio goes into one stored chunk, which is deliberately NOT the decode size.
 *
 * Decode length is a performance tuning knob and storage length is a retrieval decision, so
 * they are kept independent: retuning the decoder later must not rewrite every transcript
 * anyone has already ingested. Two minutes lands near the chunker's 1600-character target
 * for normal speech and gives citations a tight enough window to be worth following.
 */
export const SECTION_SECONDS = 120;

/**
 * A chunk producing far less text per second of speech than its neighbours did not
 * transcribe properly. See `findSuspectChunks` for why this check is not optional.
 */
export const SUSPECT_RATIO = 0.5;

/** Below this there is too little speech for the ratio to mean anything. */
const MIN_SPEECH_SECONDS_FOR_CHECK = 8;

export const SAMPLE_RATE = 16_000;

export class AudioError extends Error {
  constructor(
    message: string,
    readonly code: "no_ffmpeg" | "no_asr" | "no_model" | "decode_failed" | "no_speech",
  ) {
    super(message);
    this.name = "AudioError";
  }
}

/** Where the ASR models live. Big enough that they are fetched once and shared by all projects. */
export function modelDir(): string {
  return process.env.MEMLOOM_MODEL_DIR ?? join(homedir(), ".memloom", "models");
}

export interface TimedWord {
  word: string;
  /** Seconds from the start of the source file. */
  start: number;
}

export interface TranscriptSection {
  start: number;
  end: number;
  text: string;
}

// ---------------------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------------------

/** Like `run`, but keeps stdout too: ffprobe answers on stdout. */
function runCapture(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      if (stdout.length < 64_000) stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 64_000) stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      // A malformed file can make ffmpeg produce unbounded warnings; the tail is the useful part.
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    const { code } = await run("ffmpeg", ["-version"]);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * How long a recording is, without decoding it.
 *
 * ffprobe reads the container header and stops, so this costs milliseconds on a file that
 * would take minutes to transcribe. That is the whole point: a caller deciding whether it
 * can afford to transcribe inline must not pay for the answer.
 *
 * Null when ffprobe is absent or the container carries no duration, so a caller learns
 * "unknown" rather than being told zero. ffprobe ships with ffmpeg, and transcription needs
 * ffmpeg anyway, so its absence is not worth a separate error path.
 */
export async function mediaDurationSeconds(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nokey=1", path],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const seconds = Number.parseFloat(stdout.trim());
      resolve(code === 0 && Number.isFinite(seconds) ? seconds : null);
    });
  });
}

/**
 * Any container the user has -> 16 kHz mono 16-bit PCM, which is the only thing the model
 * accepts. 16 kHz because Nyquist puts the ceiling at 8 kHz and speech carries essentially
 * no phonetic information above that, but mostly because the model was trained at 16 kHz and
 * feeding it 44.1 does not error, it just quietly transcribes worse. Mono because the model
 * takes one channel and stereo would double the work for the same speech.
 *
 * This also transparently handles video: ffmpeg pulls the audio track and ignores the rest.
 */
/**
 * How many audio tracks a file carries. Returns 1 when it cannot tell, which keeps a
 * missing ffprobe from blocking an otherwise fine transcription.
 */
export async function countAudioStreams(inputPath: string): Promise<number> {
  try {
    const { code, stdout } = await runCapture("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      inputPath,
    ]);
    if (code !== 0) return 1;
    const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return Math.max(1, lines.length);
  } catch {
    return 1;
  }
}

export async function decodeToWav(inputPath: string, outPath: string): Promise<number> {
  if (!(await hasFfmpeg())) {
    throw new AudioError(
      "ffmpeg is required to read audio and video, and was not found on PATH. " +
        "Install it from https://ffmpeg.org/download.html and try again.",
      "no_ffmpeg",
    );
  }

  // Screen recordings routinely carry two tracks, microphone on one and desktop audio on
  // the other. ffmpeg's default is to pick exactly one, which would silently transcribe
  // half the recording and give no sign that the rest existed. Mixing keeps everything.
  // amix normalizes by input count, so a two-track mix is quieter rather than clipped, and
  // the log-mel front end is not sensitive to that.
  const tracks = await countAudioStreams(inputPath);
  const mix =
    tracks > 1
      ? ["-filter_complex", `amix=inputs=${tracks}:duration=longest`]
      : ["-ac", "1"];

  const { code, stderr } = await run("ffmpeg", [
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vn",
    ...mix,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
  if (code !== 0) {
    throw new AudioError(
      `ffmpeg could not read ${inputPath}: ${stderr.trim().split("\n").pop() ?? "unknown error"}`,
      "decode_failed",
    );
  }
  return tracks;
}

// ---------------------------------------------------------------------------------------
// sherpa-onnx
// ---------------------------------------------------------------------------------------

/**
 * sherpa-onnx-node is an optional dependency: it ships a 22 MB native addon and needs a
 * 641 MB model, which nobody who only saves markdown should be made to download. Loading it
 * lazily keeps `memloom context add notes.md` free of all of that.
 */
async function loadSherpa(): Promise<Record<string, unknown>> {
  try {
    // Indirected through a variable on purpose: as an optional dependency the package is
    // frequently absent, and a literal specifier would make `tsc --noEmit` fail on a machine
    // that has no reason to have a 22 MB ASR addon installed.
    const specifier = "sherpa-onnx-node";
    const loaded = (await import(specifier)) as Record<string, unknown>;
    // The package is CommonJS, so importing it from ESM puts the real exports behind
    // `default`. Node sometimes also copies them onto the namespace, so prefer whichever
    // actually carries the API rather than assuming either shape.
    const inner = loaded.default as Record<string, unknown> | undefined;
    return inner && typeof inner.readWave === "function" ? inner : loaded;
  } catch {
    throw new AudioError(
      "Transcribing audio needs the optional sherpa-onnx-node package. " +
        "Install it with: npm install sherpa-onnx-node",
      "no_asr",
    );
  }
}

export interface VadSegment {
  /** Sample offsets into the 16 kHz mono stream. */
  start: number;
  end: number;
}

/** One decode() call's worth of audio, plus how much of it is actually speech. */
export interface DecodeChunk {
  start: number;
  end: number;
  speechSamples: number;
}

/**
 * Group VAD segments into decode chunks.
 *
 * Contiguous, not spliced: a chunk runs from its first segment's start to its last
 * segment's end and keeps the short pauses inside. Concatenating speech-only segments would
 * skip the roughly 17 percent of a recording that is silence, but it also butts unrelated
 * phrases together with no pause between them, which is not what the model was trained on.
 * Measured gaps inside a chunk run about 1.2 seconds, so the saving is not worth the risk.
 *
 * A gap longer than `gapBreak` still ends the chunk, so a long silence is skipped rather
 * than transcribed.
 */
export function packChunks(
  segments: VadSegment[],
  chunkSeconds = DECODE_CHUNK_SECONDS,
  gapBreak = 8,
): DecodeChunk[] {
  const limit = Math.min(chunkSeconds, MAX_DECODE_CHUNK_SECONDS) * SAMPLE_RATE;
  const gapLimit = gapBreak * SAMPLE_RATE;
  const chunks: DecodeChunk[] = [];
  let cur: DecodeChunk | null = null;
  let prevEnd = 0;
  for (const seg of segments) {
    const wouldOverrun = cur !== null && seg.end - cur.start > limit;
    const bigGap = cur !== null && seg.start - prevEnd > gapLimit;
    if (cur && !wouldOverrun && !bigGap) {
      cur.end = seg.end;
      cur.speechSamples += seg.end - seg.start;
    } else {
      if (cur) chunks.push(cur);
      cur = { start: seg.start, end: seg.end, speechSamples: seg.end - seg.start };
    }
    prevEnd = seg.end;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Flag chunks that produced implausibly little text for the amount of speech they contain.
 *
 * This exists because of a measured failure, not a hypothetical one. At 90-second chunks a
 * transcript came back missing one contiguous 52-word sentence, verified present in the
 * source text and absent from the output. There was no exception, no low-confidence marker
 * and no gap in the timestamps: the words were simply gone, so a recall query for that
 * passage would return nothing and the user would never know it had been dropped.
 *
 * It happened once and did not reproduce, and that is what makes it dangerous rather than
 * fixable. The same audio extended by a few minutes, chunked at the same boundary, kept the
 * passage; the only difference was a tenth of a second of trailing context. So no chunk
 * length is safe by reasoning, and the guard has to be a runtime check rather than a
 * carefully chosen constant.
 *
 * Words per second of speech is remarkably stable across a recording, so a chunk far below
 * the median is the signal. Deliberately compared against the median rather than the mean:
 * one badly broken chunk would drag a mean down toward itself and hide.
 */
export function findSuspectChunks(
  chunks: DecodeChunk[],
  wordCounts: number[],
): number[] {
  const rates: Array<{ index: number; rate: number }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const speechSeconds = chunks[i]!.speechSamples / SAMPLE_RATE;
    if (speechSeconds < MIN_SPEECH_SECONDS_FOR_CHECK) continue;
    rates.push({ index: i, rate: wordCounts[i]! / speechSeconds });
  }
  // Two chunks cannot establish what normal looks like.
  if (rates.length < 3) return [];
  const sorted = [...rates].map((r) => r.rate).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median === 0) return [];
  return rates.filter((r) => r.rate < median * SUSPECT_RATIO).map((r) => r.index);
}

interface Recognizer {
  createStream(): unknown;
  decode(stream: unknown): void;
  getResult(stream: unknown): { text: string; timestamps: number[]; tokens: string[] };
}

/**
 * Hand the event loop back between decode calls.
 *
 * `recognizer.decode()` is a synchronous native call: while it runs, Node does nothing else
 * at all. Without this the daemon is frozen for the entire transcription, queued progress
 * writes cannot flush, and every other HTTP request waits. Measured before adding it: all
 * four progress events for a 3-minute clip arrived together at the very end.
 *
 * This does not make decoding non-blocking, it only bounds how long a single block lasts to
 * one chunk, which at 60 seconds of audio is a handful of seconds. Moving the recognizer to
 * a worker thread is the real fix and is not done here.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Merge sub-word tokens back into words. The model emits pieces ("co", "un", "tr", "y"), and
 * a piece that begins a new word carries a leading space. Each word takes the timestamp of
 * its first token, which is what makes a citation point at a moment rather than a guess.
 */
function tokensToWords(
  tokens: string[],
  timestamps: number[],
  offsetSeconds: number,
): TimedWord[] {
  const words: TimedWord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    const startsWord = token.startsWith(" ") || words.length === 0;
    if (startsWord) {
      words.push({ word: token.trim(), start: (timestamps[i] ?? 0) + offsetSeconds });
    } else {
      words[words.length - 1]!.word += token;
    }
  }
  return words.filter((w) => w.word.length > 0);
}

/** One step of a transcription, shaped for the daemon's NDJSON progress stream. */
export interface TranscribeProgress {
  stage: "decoding" | "transcribing" | "checking" | "repairing";
  /** 1-based position among this stage's units of work; 0 when the stage is not countable. */
  done: number;
  total: number;
  /** How far into the recording this step reached. */
  seconds: number;
  audioSeconds: number;
}

export interface TranscribeOptions {
  numThreads?: number;
  chunkSeconds?: number;
  /** Catalog id, e.g. "parakeet-v3". Defaults to whatever `memloom audio use` selected. */
  modelId?: string;
  onProgress?: (event: TranscribeProgress) => void;
}

/** Everything the extractor needs: the words with their times, and what was repaired. */
export interface TranscribeResult {
  words: TimedWord[];
  audioSeconds: number;
  speechSeconds: number;
  /** Chunks the plausibility check flagged, after any repair attempt. */
  suspectChunks: number;
  repairedChunks: number;
}

export async function transcribeWav(
  wavPath: string,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const { requireModels, resolveModel } = await import("./audio-models.js");
  await requireModels();
  const resolved = await resolveModel(options.modelId);
  const sherpa = await loadSherpa();
  const vadModel = join(modelDir(), "silero_vad.onnx");

  const numThreads = options.numThreads ?? 4;
  const chunkSeconds = options.chunkSeconds ?? DECODE_CHUNK_SECONDS;

  // The architecture decides which key sherpa reads the model files from, and passing the
  // wrong one fails at construction rather than degrading, so the config is built by the
  // catalog rather than assumed here.
  const makeRecognizer = () =>
    new (sherpa.OfflineRecognizer as new (c: unknown) => Recognizer)({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        ...resolved.config,
        tokens: resolved.tokens,
        numThreads,
        provider: "cpu",
      },
    });

  const readWave = sherpa.readWave as (p: string) => {
    samples: Float32Array;
    sampleRate: number;
  };
  const wave = readWave(wavPath);

  // VAD first, and it is close to free: measured RTF 0.006, so it is never worth optimizing.
  const vad = new (sherpa.Vad as new (c: unknown, b: number) => {
    config: { sileroVad: { windowSize: number } };
    acceptWaveform(s: Float32Array): void;
    isEmpty(): boolean;
    front(): { start: number; samples: Float32Array };
    pop(): void;
    flush(): void;
  })(
    {
      sileroVad: {
        model: vadModel,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.5,
        maxSpeechDuration: 20,
        windowSize: 512,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
    },
    120,
  );

  const segments: VadSegment[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      // Indices only, never the samples: retaining them would hold the whole file in memory.
      segments.push({ start: seg.start, end: seg.start + seg.samples.length });
    }
  };
  const windowSize = vad.config.sileroVad.windowSize;
  for (let i = 0; i < wave.samples.length; i += windowSize) {
    vad.acceptWaveform(wave.samples.subarray(i, i + windowSize));
    drain();
  }
  vad.flush();
  drain();

  const audioSeconds = wave.samples.length / SAMPLE_RATE;
  if (segments.length === 0) {
    throw new AudioError("no speech found in this recording", "no_speech");
  }

  const recognizer = makeRecognizer();
  const decodeRange = (start: number, end: number): { words: TimedWord[]; count: number } => {
    const stream = recognizer.createStream();
    (stream as { acceptWaveform(a: unknown): void }).acceptWaveform({
      samples: wave.samples.subarray(start, end),
      sampleRate: SAMPLE_RATE,
    });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const words = tokensToWords(result.tokens, result.timestamps, start / SAMPLE_RATE);
    return { words, count: words.length };
  };

  const chunks = packChunks(segments, chunkSeconds);
  const perChunk: TimedWord[][] = [];
  const counts: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const { words, count } = decodeRange(c.start, c.end);
    perChunk.push(words);
    counts.push(count);
    options.onProgress?.({
      stage: "transcribing",
      done: i + 1,
      total: chunks.length,
      seconds: c.end / SAMPLE_RATE,
      audioSeconds,
    });
    await yieldToEventLoop();
  }

  // The repair pass. A flagged chunk is decoded again at half the length, which changes the
  // boundaries and the amount of context the decoder carries, and that alone was enough to
  // make the observed drop disappear. Only kept if it actually recovers text, so a genuinely
  // quiet stretch is never made worse.
  let repaired = 0;
  const suspects = findSuspectChunks(chunks, counts);
  if (suspects.length > 0) {
    options.onProgress?.({
      stage: "checking",
      done: suspects.length,
      total: chunks.length,
      seconds: audioSeconds,
      audioSeconds,
    });
  }
  for (const index of suspects) {
    const c = chunks[index]!;
    const halved = packChunks(
      segmentsWithin(segments, c.start, c.end),
      Math.max(10, chunkSeconds / 2),
    );
    if (halved.length < 2) continue;
    options.onProgress?.({
      stage: "repairing",
      done: repaired + 1,
      total: suspects.length,
      seconds: c.start / SAMPLE_RATE,
      audioSeconds,
    });
    const redone: TimedWord[] = [];
    for (const h of halved) {
      redone.push(...decodeRange(h.start, h.end).words);
      await yieldToEventLoop();
    }
    if (redone.length > counts[index]!) {
      perChunk[index] = redone;
      counts[index] = redone.length;
      repaired++;
    }
  }

  const speechSeconds = segments.reduce((a, s) => a + (s.end - s.start) / SAMPLE_RATE, 0);
  return {
    words: perChunk.flat(),
    audioSeconds,
    speechSeconds,
    suspectChunks: suspects.length,
    repairedChunks: repaired,
  };
}

function segmentsWithin(segments: VadSegment[], start: number, end: number): VadSegment[] {
  return segments.filter((s) => s.start >= start && s.end <= end);
}

// ---------------------------------------------------------------------------------------
// Transcript -> markdown
// ---------------------------------------------------------------------------------------

/** "12:30", or "1:12:30" once a recording passes an hour. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * Group words into sections of roughly SECTION_SECONDS, preferring to break after a
 * sentence so a stored chunk does not start mid-thought. Falls back to a hard break once a
 * section runs 50 percent over, which keeps a speaker who never pauses from producing one
 * enormous chunk.
 */
export function sectionize(words: TimedWord[], seconds = SECTION_SECONDS): TranscriptSection[] {
  const sections: TranscriptSection[] = [];
  let current: TimedWord[] = [];
  let sectionStart = words[0]?.start ?? 0;

  const flush = (end: number) => {
    if (current.length === 0) return;
    sections.push({
      start: sectionStart,
      end,
      text: current.map((w) => w.word).join(" "),
    });
    current = [];
  };

  for (const word of words) {
    current.push(word);
    const elapsed = word.start - sectionStart;
    const endsSentence = /[.!?]$/.test(word.word);
    if ((elapsed >= seconds && endsSentence) || elapsed >= seconds * 1.5) {
      flush(word.start);
      sectionStart = word.start;
    }
  }
  flush(words[words.length - 1]?.start ?? sectionStart);
  return sections;
}

/**
 * Sections -> markdown with a time range as each heading.
 *
 * This is what lets audio reuse the whole existing pipeline untouched. chunkMarkdown already
 * makes one chunk per heading section and prepends the breadcrumb into the chunk text, and
 * describeSource already renders heading_path, so a recalled line cites
 * "from interview.m4a > 12:30 - 14:28" with no new column, no new chunker and no migration.
 */
export function toMarkdown(sections: TranscriptSection[]): string {
  return sections
    .map((s) => `## ${formatTime(s.start)} - ${formatTime(s.end)}\n\n${s.text}`)
    .join("\n\n");
}

export interface TranscribeFileResult {
  units: ExtractedUnit[];
  contentHash: string;
  audioSeconds: number;
  suspectChunks: number;
  repairedChunks: number;
  /** True when the transcript came from the cache and no ASR ran. */
  cached: boolean;
}

/**
 * Bump when anything that shapes the transcript changes: the decode size, the sectioning,
 * the repair pass, the model. Cached transcripts written by an older pipeline are ignored
 * rather than served, because a stale transcript is indistinguishable from a fresh one once
 * it is in the store.
 */
export const TRANSCRIPT_PIPELINE_VERSION = 1;

/**
 * Transcripts are cached by source-file hash, which is what makes a re-add free.
 *
 * The extractor contract computes the content hash as part of extracting, so without this an
 * unchanged recording would be fully transcribed just to discover that nothing changed. That
 * is minutes of CPU to produce a no-op. Keyed on the file's bytes rather than its path, so
 * the same podcast added from two directories, or re-added after a remove, also costs
 * nothing.
 */
/**
 * Keyed on the model as well as the file. Two models transcribe the same recording
 * differently, so a file-only key would serve whichever ran first no matter which model is
 * now selected. Keeping them in separate entries also means switching back to a model you
 * used before costs nothing.
 */
function cachePath(sha256: string, modelId: string): string {
  const dir = process.env.MEMLOOM_TRANSCRIPT_DIR ?? join(homedir(), ".memloom", "transcripts");
  return join(dir, `${sha256}-${modelId.replace(/[^a-z0-9._-]/gi, "_")}.json`);
}

interface CachedTranscript {
  pipelineVersion: number;
  modelId: string;
  audioSeconds: number;
  markdown: string;
  suspectChunks: number;
  repairedChunks: number;
}

async function readCache(sha256: string, modelId: string): Promise<CachedTranscript | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(cachePath(sha256, modelId), "utf8");
    const parsed = JSON.parse(raw) as CachedTranscript;
    // The model is checked as well as the filename, so a hand-edited or older entry cannot
    // pass one model's transcript off as another's.
    const fresh =
      parsed.pipelineVersion === TRANSCRIPT_PIPELINE_VERSION && parsed.modelId === modelId;
    return fresh ? parsed : null;
  } catch {
    // A missing or corrupt cache entry is never fatal: it just means transcribing again.
    return null;
  }
}

async function writeCache(sha256: string, record: CachedTranscript): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const file = cachePath(sha256, record.modelId);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(record));
  } catch {
    // Caching is an optimization. A read-only home directory must not fail an ingest.
  }
}

/**
 * A media file on disk -> the units the context connector stores.
 *
 * The content hash is taken over the source file's bytes, streamed rather than buffered: a
 * podcast is 60 MB and a video can be several GB, and the existing extractor path reads
 * whole files into memory. Hashing the source rather than the transcript means a re-add of
 * the same recording is a no-op without paying for transcription to find that out.
 */
export async function transcribeMedia(
  path: string,
  options: TranscribeOptions & { sha256: (p: string) => Promise<string> },
): Promise<TranscribeFileResult> {
  const contentHash = await options.sha256(path);
  const { selectedModelId } = await import("./audio-models.js");
  const modelId = options.modelId ?? (await selectedModelId());

  // Checked before any decoding: re-adding an unchanged recording must not cost an ASR run
  // to establish that it is unchanged.
  const hit = contentHash ? await readCache(contentHash, modelId) : null;
  if (hit) {
    return {
      units: [{ text: hit.markdown, page: null }],
      contentHash,
      audioSeconds: hit.audioSeconds,
      suspectChunks: hit.suspectChunks,
      repairedChunks: hit.repairedChunks,
      cached: true,
    };
  }

  const workDir = await mkdtemp(join(tmpdir(), "memloom-asr-"));
  const wavPath = join(workDir, "audio.wav");
  try {
    // Reported separately because it is the one stage with no progress of its own: ffmpeg
    // runs for 10 to 30 seconds per hour of audio and says nothing until it finishes.
    options.onProgress?.({ stage: "decoding", done: 0, total: 0, seconds: 0, audioSeconds: 0 });
    await decodeToWav(path, wavPath);
    // Pinned to the id the cache was keyed on, so the entry written below always names the
    // model that actually produced it even if the selection changes mid-run.
    const result = await transcribeWav(wavPath, { ...options, modelId });
    const markdown = toMarkdown(sectionize(result.words));
    if (contentHash) {
      await writeCache(contentHash, {
        pipelineVersion: TRANSCRIPT_PIPELINE_VERSION,
        modelId,
        audioSeconds: result.audioSeconds,
        markdown,
        suspectChunks: result.suspectChunks,
        repairedChunks: result.repairedChunks,
      });
    }
    return {
      units: [{ text: markdown, page: null }],
      contentHash,
      audioSeconds: result.audioSeconds,
      suspectChunks: result.suspectChunks,
      repairedChunks: result.repairedChunks,
      cached: false,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Streaming sha256 so a multi-gigabyte video never lands in memory. */
export async function hashFile(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
