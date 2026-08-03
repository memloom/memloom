import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SpeakerTurn } from "./diarize.js";
import type { ExtractedUnit } from "./extract.js";
import type { SpeakerRoster } from "./types.js";

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
 * How sure silero has to be that a frame is speech. Its own default, and right for a recording
 * of someone talking: it keeps VAD useful as a silence-skipper, so an hour with ten minutes of
 * speech in it decodes ten minutes rather than sixty.
 *
 * MEMLOOM_VAD_THRESHOLD overrides it. Lower finds more and sends more non-speech to the
 * recognizer, which costs decode time and some junk words; higher misses quiet speech.
 */
export const VAD_THRESHOLD = 0.5;

/**
 * The second pass, run only when the first finds nothing at all.
 *
 * Speech mixed under continuous loud audio never reaches 0.5, because the model sees a
 * spectrally busy frame and the speech is a small part of its energy. Measured on a 52-second
 * phone recording of music with about ten seconds of talking over it: 0.5 found ZERO segments,
 * 0.4 found 28.8 seconds, 0.3 found 36.4. Nothing about that recording was borderline to a
 * human, so a single threshold cannot be the last word.
 */
export const VAD_RESCUE_THRESHOLD = 0.3;

/**
 * Peak sample below which a file is taken to be genuinely silent, about -60 dBFS. Peak rather
 * than average, so one spoken sentence in an hour of room tone still counts as sound.
 */
const SILENCE_PEAK = 0.001;

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
    readonly code:
      | "no_ffmpeg"
      | "no_asr"
      | "no_model"
      | "decode_failed"
      | "no_speech"
      | "truncated"
      | "cancelled",
  ) {
    super(message);
    this.name = "AudioError";
  }
}

/** Where the ASR models live. Big enough that they are fetched once and shared by all projects. */
export function modelDir(): string {
  return process.env.MEMLOOM_MODEL_DIR ?? join(homedir(), ".memloom", "models");
}

/** MEMLOOM_VAD_THRESHOLD, when it parses to a probability. Anything else falls back. */
export function vadThreshold(): number {
  const raw = Number(process.env.MEMLOOM_VAD_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : VAD_THRESHOLD;
}

/** The loudest sample in the file, so "is this silent" is answered by evidence. */
export function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (const s of samples) {
    const abs = s < 0 ? -s : s;
    if (abs > peak) peak = abs;
  }
  return peak;
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
  /** 1-based diarized speaker, present only when a multi-voice recording was diarized. */
  speaker?: number;
}

// ---------------------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------------------
//
// Every spawn here passes `windowsHide: true`. Windows gives a console program its own
// window whenever the parent process has no console to inherit, and the daemon is started
// detached with no console, so ffmpeg and ffprobe would each pop a black box on screen
// while a recording is read. It has no effect on other platforms.

/** Like `run`, but keeps stdout too: ffprobe answers on stdout. */
function runCapture(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
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
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
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

/**
 * How long the AUDIO is, as the container claims, which is what a decode should reproduce.
 *
 * Deliberately not `mediaDurationSeconds`: format duration is the longest stream, so a video
 * whose picture outlasts its sound would look truncated. The audio stream's own duration is
 * the honest comparison; mkv and friends often omit it, so format duration is the fallback.
 */
async function expectedAudioSeconds(path: string): Promise<number | null> {
  try {
    const { code, stdout } = await runCapture("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=duration",
      "-of",
      "default=nw=1:nokey=1",
      path,
    ]);
    if (code === 0) {
      const seconds = Number.parseFloat(stdout.trim());
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  } catch {
    // ffprobe missing or unrunnable. The format-duration fallback answers null too.
  }
  return mediaDurationSeconds(path);
}

/** How long the decoded wav is, from its size. pcm_s16le mono at 16 kHz is 32000 bytes a second. */
async function wavSeconds(wavPath: string): Promise<number> {
  const { size } = await stat(wavPath);
  return Math.max(0, size - 44) / (SAMPLE_RATE * 2);
}

/**
 * Refuse a recording that decoded materially shorter than its own header promises.
 *
 * This is the half-copied file, the recorder that lost power mid-write, the download that
 * stopped. ffmpeg decodes those happily: it reads until the bytes run out and exits 0, so the
 * only sign that anything is missing is that the samples do not match the header. Transcribing
 * it anyway stores a partial recording as if it were the whole thing, which is a memory that
 * is wrong rather than absent.
 *
 * Runs straight after the decode and before the model loads, so a broken file costs a few
 * seconds of ffmpeg rather than minutes of inference.
 *
 * Both tolerances have to be exceeded. A 2 percent gap catches truncation on any file long
 * enough to matter; the 2-second floor keeps container rounding on a short clip from tripping
 * it. A header that carries no duration at all means "cannot tell", never "reject".
 */
function assertNotTruncated(path: string, expected: number | null, decoded: number): void {
  if (expected === null || decoded <= 0) return;
  const missing = expected - decoded;
  if (missing <= 2 || decoded >= expected * 0.98) return;
  throw new AudioError(
    `${basename(path)} looks incomplete: it says it is ${formatTime(expected)} long but only ` +
      `${formatTime(decoded)} of audio could be read. It was probably still being copied, or ` +
      "the recording was cut short. Nothing was stored.",
    "truncated",
  );
}

/**
 * When a recording was MADE, as opposed to when memloom read it.
 *
 * Everything downstream stamps documents with ingest time, which for a wearable that dumps a
 * week of clips over USB is the same minute for all of them. The recording time is the only
 * thing that makes "what did I say on Tuesday" answerable, so it is resolved here and written
 * into the transcript itself.
 *
 * Three sources, weakest last, and the source is always reported rather than hidden:
 *
 * 1. The file name. A device that stamps its own files is asserting the time it recorded, and
 *    that survives copying, re-muxing and transfer, none of which the other two do.
 * 2. Container metadata. Written by the recorder for mp4, mov and friends; absent from wav and
 *    opus, which is exactly what a wearable produces.
 * 3. The file's mtime, which is only evidence if it is old. A file modified seconds ago was
 *    created by the copy that is happening right now, so its mtime is ingest time wearing a
 *    disguise, and claiming that as a recording time would be a confident lie.
 */
export interface RecordingTime {
  at: Date;
  source: "filename" | "metadata" | "mtime";
}

/** A file stamped within this long is being written now, so its mtime is not a recording time. */
const FRESH_FILE_MS = 60_000;

// Anchored on a 20xx year so a serial number or a bitrate cannot look like a date. Separators
// are optional throughout, which covers "20260731_142207", "2026-07-31 14.22.07",
// "2026-07-31T14-22-07" and the bare "20260731142207" that cheap recorders emit.
const FILENAME_STAMP =
  /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _tT.-]{0,3}(\d{2})[-_.:]?(\d{2})(?:[-_.:]?(\d{2}))?)?/;

function timeFromFilename(path: string): Date | null {
  const match = FILENAME_STAMP.exec(basename(path));
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number.parseInt(part, 10)));
  if (month === undefined || month < 1 || month > 12) return null;
  if (day === undefined || day < 1 || day > 31) return null;
  if ((hour ?? 0) > 23 || (minute ?? 0) > 59 || (second ?? 0) > 59) return null;
  // Local time on purpose: a recorder names its files in the clock the person was living in.
  const at = new Date(year as number, month - 1, day, hour ?? 0, minute ?? 0, second ?? 0);
  return Number.isNaN(at.getTime()) ? null : at;
}

async function timeFromContainer(path: string): Promise<Date | null> {
  try {
    const { code, stdout } = await runCapture("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format_tags=creation_time",
      "-of",
      "default=nw=1:nokey=1",
      path,
    ]);
    if (code !== 0) return null;
    // mp4 and mov write this as UTC with a trailing Z, which Date.parse handles; it is
    // rendered back in local time with an explicit offset so nothing is silently shifted.
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  } catch {
    return null;
  }
}

export async function recordingTime(path: string): Promise<RecordingTime | null> {
  const named = timeFromFilename(path);
  if (named) return { at: named, source: "filename" };
  const tagged = await timeFromContainer(path);
  if (tagged) return { at: tagged, source: "metadata" };
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > FRESH_FILE_MS) {
      return { at: info.mtime, source: "mtime" };
    }
  } catch {
    // No file to stat (the upload path spills to a temp name). Unknown is the honest answer.
  }
  return null;
}

/**
 * Any container the user has -> 16 kHz mono 16-bit PCM, which is the only thing the model
 * accepts. 16 kHz because Nyquist puts the ceiling at 8 kHz and speech carries essentially
 * no phonetic information above that, but mostly because the model was trained at 16 kHz and
 * feeding it 44.1 does not error, it just quietly transcribes worse. Mono because the model
 * takes one channel and stereo would double the work for the same speech.
 *
 * This also transparently handles video: ffmpeg pulls the audio track and ignores the rest.
 *
 * Returns how many audio tracks were mixed in.
 */
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
    tracks > 1 ? ["-filter_complex", `amix=inputs=${tracks}:duration=longest`] : ["-ac", "1"];

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
 *
 * Exported for diarize.ts, which runs on the same addon; not part of the public API.
 */
export async function loadSherpa(): Promise<Record<string, unknown>> {
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
export function findSuspectChunks(chunks: DecodeChunk[], wordCounts: number[]): number[] {
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
async function yieldToEventLoop(): Promise<void> {
  // A timer rather than setImmediate, and two turns rather than one. setImmediate resumes in
  // the check phase, which is too early for libuv to have noticed a socket the client just
  // closed, and the cancellation then has to travel a promise chain on top of that. With one
  // setImmediate a cancel took about two chunks (11 seconds) to land; this makes it one.
  // A couple of milliseconds against a chunk that decodes for seconds is free.
  await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Raised as a typed AudioError so callers can tell a cancel from a real failure. */
function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AudioError("transcription cancelled", "cancelled");
}

/**
 * Merge sub-word tokens back into words. The model emits pieces ("co", "un", "tr", "y"), and
 * a piece that begins a new word carries a leading space. Each word takes the timestamp of
 * its first token, which is what makes a citation point at a moment rather than a guess.
 */
function tokensToWords(tokens: string[], timestamps: number[], offsetSeconds: number): TimedWord[] {
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

/**
 * One step of a transcription, shaped for the daemon's NDJSON progress stream.
 *
 * Every slow stage reports, not just the decode loop. On a multi-gigabyte recording the work
 * before the first word is read is minutes long: the file is hashed in full, ffmpeg walks the
 * whole container, VAD sweeps the audio, and a 641 MB model loads. Leaving those silent made
 * a working ingest look hung, which is the exact failure this stream exists to prevent.
 *
 * `done` and `total` are bytes during "hashing" and chunks during "transcribing". The stage
 * says which, so a consumer never has to guess from magnitudes.
 */
export interface TranscribeProgress {
  stage:
    | "hashing"
    | "decoding"
    | "detecting"
    | "loading"
    | "transcribing"
    | "checking"
    | "repairing"
    | "diarizing";
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
  /**
   * Stops the run at the next chunk boundary. Checked between decode calls rather than
   * inside one, because `decode()` is a synchronous native call that cannot be interrupted
   * once entered, so the worst-case wait is one chunk.
   *
   * Cancelling is clean by construction: the temp wav is removed in a finally, the
   * transcript cache is only written on success, and the document is only stored after
   * extraction returns. A cancelled ingest leaves nothing behind.
   */
  signal?: AbortSignal;
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
  // Built per pass, because a Vad instance carries the threshold and its own stream state.
  const makeVad = (threshold: number) =>
    new (
      sherpa.Vad as new (
        c: unknown,
        b: number,
      ) => {
        config: { sileroVad: { windowSize: number } };
        acceptWaveform(s: Float32Array): void;
        isEmpty(): boolean;
        front(): { start: number; samples: Float32Array };
        pop(): void;
        flush(): void;
      }
    )(
      {
        sileroVad: {
          model: vadModel,
          threshold,
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

  const totalSamples = wave.samples.length;
  const audioSeconds = totalSamples / SAMPLE_RATE;

  // VAD is cheap per second of audio (measured RTF 0.006) but an hour of it is still about
  // twenty seconds, and it used to pass in silence between the model loading and the first
  // word appearing. Reported every percent, with a yield so the events actually reach the
  // client: acceptWaveform is native and synchronous, so nothing flushes without one.
  const runVad = async (threshold: number): Promise<VadSegment[]> => {
    const vad = makeVad(threshold);
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
    let vadPercent = -1;
    options.onProgress?.({ stage: "detecting", done: 0, total: 100, seconds: 0, audioSeconds });
    for (let i = 0; i < totalSamples; i += windowSize) {
      vad.acceptWaveform(wave.samples.subarray(i, i + windowSize));
      drain();
      const percent = Math.floor((i / totalSamples) * 100);
      if (percent !== vadPercent) {
        vadPercent = percent;
        options.onProgress?.({
          stage: "detecting",
          done: percent,
          total: 100,
          seconds: i / SAMPLE_RATE,
          audioSeconds,
        });
        await yieldToEventLoop();
        throwIfCancelled(options.signal);
      }
    }
    vad.flush();
    drain();
    return segments;
  };

  const threshold = vadThreshold();
  let segments = await runVad(threshold);

  // Nothing found is far more often VAD being wrong than a recording being empty. Speech under
  // continuous loud audio (music, a car, a fan) never reaches silero's 0.5, because the model
  // sees a spectrally busy frame and the speech is a small part of its energy. Measured on a
  // 52-second phone recording of music with ten seconds of talking over it: 0.5 found ZERO
  // segments, 0.4 found 28.8s and 0.3 found 36.4s. So a second pass runs at a lower bar before
  // anything is refused. It costs another 0.6% of real time.
  if (segments.length === 0 && threshold > VAD_RESCUE_THRESHOLD) {
    segments = await runVad(VAD_RESCUE_THRESHOLD);
  }

  // Still nothing. VAD is an optimization, not a gate: skipping silence saves decode time, and
  // being wrong about where speech is must never cost the recording. So unless the audio really
  // is silent, hand the whole file to the recognizer and let IT decide. Refusing a recording
  // that plainly contains speech is the worse failure by a distance.
  if (segments.length === 0) {
    if (peakLevel(wave.samples) < SILENCE_PEAK) {
      throw new AudioError(
        "this recording is silent: nothing above the noise floor to transcribe",
        "no_speech",
      );
    }
    segments = [{ start: 0, end: totalSamples }];
  }

  // Emitted here rather than at the top of the function because this call is where the
  // 641 MB model is actually read off disk, about seven seconds. Labelling it earlier named
  // the stage before the cost, which left the real wait unaccounted for.
  options.onProgress?.({ stage: "loading", done: 0, total: 0, seconds: 0, audioSeconds });
  await yieldToEventLoop();
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
    throwIfCancelled(options.signal);
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
      throwIfCancelled(options.signal);
    }
    if (redone.length > counts[index]!) {
      perChunk[index] = redone;
      counts[index] = redone.length;
      repaired++;
    }
  }

  const speechSeconds = segments.reduce((a, s) => a + (s.end - s.start) / SAMPLE_RATE, 0);
  const words = perChunk.flat();

  // The recognizer heard nothing it could turn into words. Refused rather than stored, because
  // the alternative is a document whose only chunk is the "Recorded on ..." header: it takes up
  // a row, it is recallable, and it says nothing. The commonest cause is speech masked by
  // continuous loud audio, which the recognizer cannot separate out; it is a speech model, not
  // a source separator.
  if (words.length === 0) {
    throw new AudioError(
      "nothing recognizable as speech in this recording. Music or noise as loud as the " +
        "talking will mask it; try a recording where the voice is clearly the loudest thing.",
      "no_speech",
    );
  }
  return {
    words,
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
 * How much speech a section needs before a change of speaker is allowed to end it.
 *
 * Below this a section is not a passage anyone can retrieve. Each one becomes its own chunk,
 * and chunkMarkdown prepends the heading into the chunk's text, so a two-word back-channel
 * embeds as "25:46 - 25:47, Alice\n\nIt": 20 characters of name and timestamp against 2 of
 * speech. Its vector is then mostly the speaker's NAME, which makes it a near-perfect match
 * for any question mentioning that person, and a whole conversation's worth of them crowd the
 * real answer out of the results. Short chunks do not merely add noise; they outrank content.
 */
export const SECTION_MIN_SPEECH_CHARS = 80;

/**
 * Group words into sections that follow the diarized turns, breaking on a change of speaker
 * once the current speaker has said enough to be worth retrieving on its own, and on the
 * SECTION_SECONDS rules so one voice holding the floor does not become a single enormous chunk.
 *
 * A word is assigned to the last turn that started at or before it. Diarization and ASR
 * disagree about boundaries by fractions of a second, and words landing in the silence
 * between turns have to go somewhere; trailing the current speaker is the reading a person
 * would give it.
 *
 * Back-channels ride along with the speech around them rather than becoming their own section,
 * which is how a person reads a transcript: "Yeah" in the middle of someone else's explanation
 * belongs to that explanation. A section is labeled with whoever said most of it, so the
 * attribution stays the honest one when it does contain more than one voice.
 */
export function sectionizeTurns(
  words: TimedWord[],
  turns: SpeakerTurn[],
  seconds = SECTION_SECONDS,
  minSpeechChars = SECTION_MIN_SPEECH_CHARS,
): TranscriptSection[] {
  if (turns.length === 0) return sectionize(words, seconds);
  const sections: TranscriptSection[] = [];
  let current: TimedWord[] = [];
  let sectionStart = words[0]?.start ?? 0;
  let turnIndex = 0;
  // Words per speaker in the section being built, so it can be labeled with whoever holds it.
  let spoken = new Map<number, number>();

  const speechChars = () =>
    current.reduce((n, w) => n + w.word.length, 0) + Math.max(0, current.length - 1);

  const dominant = (): number | null => {
    let best: number | null = null;
    let most = 0;
    for (const [speaker, count] of spoken) {
      if (count > most) {
        most = count;
        best = speaker;
      }
    }
    return best;
  };

  const flush = (end: number) => {
    if (current.length === 0) return;
    const speaker = dominant();
    sections.push({
      start: sectionStart,
      end,
      text: current.map((w) => w.word).join(" "),
      ...(speaker === null ? {} : { speaker }),
    });
    current = [];
    spoken = new Map();
  };

  for (const word of words) {
    while (turnIndex + 1 < turns.length && word.start >= turns[turnIndex + 1]!.start) {
      turnIndex++;
    }
    const speaker = turns[turnIndex]!.speaker;
    // A voice not yet heard in this section wants to start a new one, and gets to only once
    // there is a section worth keeping. Otherwise the words so far join what comes next.
    if (spoken.size > 0 && !spoken.has(speaker) && speechChars() >= minSpeechChars) {
      flush(word.start);
      sectionStart = word.start;
    }
    spoken.set(speaker, (spoken.get(speaker) ?? 0) + 1);
    current.push(word);
    const elapsed = word.start - sectionStart;
    const endsSentence = /[.!?]$/.test(word.word);
    if ((elapsed >= seconds && endsSentence) || elapsed >= seconds * 1.5) {
      flush(word.start);
      sectionStart = word.start;
    }
  }
  // The last section has nothing after it to join, so a short tail folds backwards instead.
  // Its speaker label stands: whoever held the section keeps it.
  const tailSpeech = speechChars();
  const tailSpeaker = dominant();
  flush(words[words.length - 1]?.start ?? sectionStart);
  const last = sections[sections.length - 1];
  const previous = sections[sections.length - 2];
  if (sections.length > 1 && last && previous && tailSpeech < minSpeechChars) {
    sections.pop();
    previous.end = last.end;
    previous.text = `${previous.text} ${last.text}`;
    if (previous.speaker === undefined && tailSpeaker !== null) previous.speaker = tailSpeaker;
  }
  return sections;
}

/**
 * Sections -> markdown with a time range as each heading.
 *
 * This is what lets audio reuse the whole existing pipeline untouched. chunkMarkdown already
 * makes one chunk per heading section and prepends the breadcrumb into the chunk text, and
 * describeSource already renders heading_path, so a recalled line cites
 * "from interview.m4a > 12:30 - 14:28" with no new column, no new chunker and no migration.
 *
 * A diarized section appends its speaker after a comma: "## 12:30 - 14:28, Speaker 2".
 * The time range never contains a comma, so splitting the heading at the first ", " is
 * always safe for anything that wants the parts back, including after a rename put a real
 * name (commas and all) where the label was.
 */
export function toMarkdown(sections: TranscriptSection[]): string {
  return sections
    .map((s) => {
      const speaker = s.speaker === undefined ? "" : `, Speaker ${s.speaker}`;
      return `## ${formatTime(s.start)} - ${formatTime(s.end)}${speaker}\n\n${s.text}`;
    })
    .join("\n\n");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "Friday 2026-07-31 14:22:07 +02:00": local wall clock, with the offset so it is unambiguous. */
function formatStamp(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const day = at.toLocaleDateString("en-US", { weekday: "long" });
  return (
    `${day} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const SOURCE_PHRASE: Record<RecordingTime["source"], string> = {
  filename: "taken from the file name",
  metadata: "taken from the recording's own metadata",
  mtime:
    "taken from the file timestamp, which may be when the file was copied rather than recorded",
};

/**
 * The line that puts a recording in time, written above the first section heading.
 *
 * It goes in the text rather than a column because this stream has no reserved migration
 * range. Text is not a worse home than it sounds: chunkMarkdown keeps everything before the
 * first heading as its own chunk, so the date is embedded, searchable by keyword, and shown
 * whenever that chunk is recalled. What text cannot do is let recall FILTER by date, which
 * needs a real column and a migration.
 *
 * The weekday is there for the same reason: people ask for "Tuesday", not "2026-07-28".
 */
export function recordingHeader(at: RecordingTime | null, audioSeconds: number): string {
  const length = `Length ${formatTime(audioSeconds)}.`;
  if (!at) {
    return `Recording time unknown: nothing in the file name, the metadata or the file timestamp said when this was recorded. ${length}`;
  }
  return `Recorded ${formatStamp(at.at)}, ${SOURCE_PHRASE[at.source]}. ${length}`;
}

export interface TranscribeFileResult {
  /** When it was recorded, if anything knew. Null is a real answer, not a missing one. */
  recordedAt: RecordingTime | null;
  units: ExtractedUnit[];
  contentHash: string;
  audioSeconds: number;
  suspectChunks: number;
  repairedChunks: number;
  /** True when the transcript came from the cache and no ASR ran. */
  cached: boolean;
  /** Who spoke, when diarization ran; null when the models are absent or the pass failed. */
  roster: SpeakerRoster | null;
}

/**
 * Bump when what the cache HOLDS would be wrong: the decode size, the repair pass, the model,
 * or the shape of the record itself. Cached transcripts written by an older pipeline are then
 * ignored rather than served, because a stale transcript is indistinguishable from a fresh one
 * once it is in the store.
 *
 * NOT for a sectioning change, however much a sectioning change alters the document. Since v3
 * the cache holds words and diarization, and `render` cuts sections from them on every read, so
 * new sectioning rules apply to a cached transcript the moment it is read. Bumping this for one
 * would throw away every cached transcript and re-run hours of ASR to arrive at the same words.
 * The extractor `version` in extract.ts is the right knob there: it salts the content hash, so
 * ingest re-chunks the recording without re-transcribing it.
 *
 * v2: speaker diarization. Sections break on speaker turns and headings carry a label, so a v1
 * transcript of the same file is a genuinely different document.
 *
 * v3: the cache stores the ASR words and the diarization result separately, the latter
 * keyed by its own config signature. Re-tuning diarization re-runs minutes of clustering
 * against the cached words instead of re-running the much longer ASR pass.
 */
export const TRANSCRIPT_PIPELINE_VERSION = 3;

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
  speechSeconds: number;
  /** The ASR output itself. Markdown is derived from these at read time, never stored. */
  words: TimedWord[];
  suspectChunks: number;
  repairedChunks: number;
  /**
   * The diarization that words were last combined with. `signature` names the config that
   * produced it (see diarizeSignature); a mismatch on read keeps the words and re-runs
   * only diarization. "off" when the models were absent or the pass failed, so installing
   * models (or a transient failure) triggers a retry rather than sticking forever.
   * Labels only, never names: naming lives on the document row, which survives the cache.
   */
  diarize: { signature: string; turns: SpeakerTurn[]; roster: SpeakerRoster | null };
}

async function readCache(sha256: string, modelId: string): Promise<CachedTranscript | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(cachePath(sha256, modelId), "utf8");
    const parsed = JSON.parse(raw) as CachedTranscript;
    // The model is checked as well as the filename, so a hand-edited or older entry cannot
    // pass one model's transcript off as another's.
    const fresh =
      parsed.pipelineVersion === TRANSCRIPT_PIPELINE_VERSION &&
      parsed.modelId === modelId &&
      Array.isArray(parsed.words) &&
      typeof parsed.diarize === "object" &&
      parsed.diarize !== null;
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

type WorkerMessage =
  | { type: "progress"; event: TranscribeProgress }
  | { type: "done"; result: unknown }
  | { type: "error"; message: string; code: AudioError["code"] | null };

/**
 * Run one inference job in the compiled worker, or report that the worker cannot start so
 * the caller falls back to in-process. The worker exists because sherpa's native calls are
 * synchronous: on the main thread ASR froze the daemon for seconds per chunk and
 * diarization for minutes; in a worker they block a thread nobody else is using.
 *
 * Fallback covers a source-tree run (vitest imports src/, where the compiled worker file
 * does not exist) and any environment that cannot spawn workers. MEMLOOM_ASR_INPROC=1
 * forces it for debugging. The behavior in fallback is exactly the pre-worker behavior.
 *
 * Cancellation via terminate() interrupts even a native call mid-flight, which makes a
 * cancel land instantly where the in-process path waits for the current chunk to finish.
 */
async function runWorkerJob<T>(
  job: "transcribe" | "diarize",
  wavPath: string,
  options: { numThreads?: number; chunkSeconds?: number; modelId?: string },
  onProgress?: (event: TranscribeProgress) => void,
  signal?: AbortSignal,
): Promise<{ ok: true; result: T } | { ok: false }> {
  if (process.env.MEMLOOM_ASR_INPROC === "1") return { ok: false };
  const url = new URL("./asr-worker.js", import.meta.url);
  let WorkerCtor: typeof import("node:worker_threads").Worker;
  try {
    const [{ Worker }, { existsSync }, { fileURLToPath }] = await Promise.all([
      import("node:worker_threads"),
      import("node:fs"),
      import("node:url"),
    ]);
    if (!existsSync(fileURLToPath(url))) return { ok: false };
    WorkerCtor = Worker;
  } catch {
    return { ok: false };
  }
  throwIfCancelled(signal);

  return await new Promise((resolve, reject) => {
    const worker = new WorkerCtor(url, { workerData: { job, wavPath, options } });
    // Distinguishes "never started" (fall back silently) from "died mid-job" (a real
    // failure: re-running minutes of inference against the same cause helps nobody).
    let sawMessage = false;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      void worker.terminate();
      settle(() => reject(new AudioError("transcription cancelled", "cancelled")));
    };
    signal?.addEventListener("abort", onAbort);
    worker.on("message", (msg: WorkerMessage) => {
      sawMessage = true;
      if (msg.type === "progress") onProgress?.(msg.event);
      else if (msg.type === "done") settle(() => resolve({ ok: true, result: msg.result as T }));
      else {
        const code = msg.code ?? "decode_failed";
        settle(() => reject(new AudioError(msg.message, code)));
      }
    });
    worker.on("error", () => {
      settle(() =>
        sawMessage
          ? reject(new AudioError("the transcription worker crashed", "decode_failed"))
          : resolve({ ok: false }),
      );
    });
    worker.on("exit", () => {
      // A clean exit lands after "done" settled; anything else without a verdict is
      // either a startup failure (fall back) or a mid-job death (report it).
      settle(() =>
        sawMessage
          ? reject(new AudioError("the transcription worker exited early", "decode_failed"))
          : resolve({ ok: false }),
      );
    });
  });
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
  options: TranscribeOptions & {
    sha256: (p: string, onProgress?: (read: number, total: number) => void) => Promise<string>;
  },
): Promise<TranscribeFileResult> {
  throwIfCancelled(options.signal);

  // Reported before it starts as well as during, so the very first thing the user sees is a
  // named stage rather than a still bar. A large file spends real time here.
  let lastPercent = -1;
  options.onProgress?.({ stage: "hashing", done: 0, total: 0, seconds: 0, audioSeconds: 0 });
  const contentHash = await options.sha256(path, (read, total) => {
    // One event per whole percent. A read stream fires thousands of chunks, and a line per
    // chunk would flood the NDJSON stream with more traffic than the work it describes.
    const percent = total > 0 ? Math.floor((read / total) * 100) : 0;
    if (percent === lastPercent) return;
    lastPercent = percent;
    options.onProgress?.({
      stage: "hashing",
      done: read,
      total,
      seconds: 0,
      audioSeconds: 0,
    });
  });
  const { selectedModelId } = await import("./audio-models.js");
  const modelId = options.modelId ?? (await selectedModelId());
  const { diarizeSignature, diarizeWav } = await import("./diarize.js");
  const signature = await diarizeSignature();

  // Checked before any decoding: re-adding an unchanged recording must not cost an ASR run
  // to establish that it is unchanged. Words and diarization are cached independently: a
  // matching signature means nothing at all runs, a mismatched one (threshold tuned, models
  // newly installed, an earlier pass failed) keeps the words and re-runs only diarization.
  const hit = contentHash ? await readCache(contentHash, modelId) : null;

  // Resolved before the cache branch so a re-added recording carries the same header a fresh
  // one does. One stat and at most one ffprobe, both milliseconds.
  const recordedAt = await recordingTime(path);

  const render = (
    words: TimedWord[],
    diarize: CachedTranscript["diarize"],
    audioSeconds: number,
  ): string => {
    // One voice is labeled too, which it was not before. Leaving a solo recording as plain
    // time ranges reads a little cleaner, and costs the whole recording: the name lives only
    // in the roster, so nothing in any chunk's text says who is talking, and asking about that
    // person by name cannot reach a word of it. Naming the voice later does not save it either,
    // because renameSpeaker rewrites the ", Speaker 1" suffix in a heading and a solo recording
    // has no suffix to rewrite. A voice note from one person is exactly the thing someone
    // searches for by whose voice it is.
    const sections =
      diarize.roster && diarize.roster.speakers.length > 0 && diarize.turns.length > 0
        ? sectionizeTurns(words, diarize.turns)
        : sectionize(words);
    return `${recordingHeader(recordedAt, audioSeconds)}\n\n${toMarkdown(sections)}`;
  };

  if (hit && hit.diarize.signature === signature) {
    return {
      recordedAt,
      units: [{ text: render(hit.words, hit.diarize, hit.audioSeconds), page: null }],
      contentHash,
      audioSeconds: hit.audioSeconds,
      suspectChunks: hit.suspectChunks,
      repairedChunks: hit.repairedChunks,
      cached: true,
      roster: hit.diarize.roster,
    };
  }

  const workDir = await mkdtemp(join(tmpdir(), "memloom-asr-"));
  const wavPath = join(workDir, "audio.wav");
  try {
    // Reported separately because it is the one stage with no progress of its own: ffmpeg
    // runs for 10 to 30 seconds per hour of audio and says nothing until it finishes. It
    // runs even when the words are cached, because diarization reads the same wav.
    options.onProgress?.({ stage: "decoding", done: 0, total: 0, seconds: 0, audioSeconds: 0 });
    await decodeToWav(path, wavPath);
    // ffmpeg on a long video runs for tens of seconds, so a cancel arriving during it
    // should not then load a 641 MB model and start transcribing anyway.
    throwIfCancelled(options.signal);
    assertNotTruncated(path, await expectedAudioSeconds(path), await wavSeconds(wavPath));

    // Pinned to the id the cache was keyed on, so the entry written below always names the
    // model that actually produced it even if the selection changes mid-run. The worker is
    // preferred; in-process is the fallback with identical behavior.
    let asr: Pick<
      TranscribeResult,
      "words" | "audioSeconds" | "speechSeconds" | "suspectChunks" | "repairedChunks"
    >;
    if (hit) {
      asr = {
        words: hit.words,
        audioSeconds: hit.audioSeconds,
        speechSeconds: hit.speechSeconds,
        suspectChunks: hit.suspectChunks,
        repairedChunks: hit.repairedChunks,
      };
    } else {
      const attempt = await runWorkerJob<TranscribeResult>(
        "transcribe",
        wavPath,
        {
          ...(options.numThreads === undefined ? {} : { numThreads: options.numThreads }),
          ...(options.chunkSeconds === undefined ? {} : { chunkSeconds: options.chunkSeconds }),
          modelId,
        },
        options.onProgress,
        options.signal,
      );
      asr = attempt.ok ? attempt.result : await transcribeWav(wavPath, { ...options, modelId });
    }

    // Diarization runs after ASR so a cancel during the long transcribe never pays for it,
    // and a diarization failure costs the labels, never the transcript. The models are an
    // optional download: absent models skip the stage entirely rather than announcing a
    // "diarizing" step that instantly vanishes.
    let diarized: { turns: SpeakerTurn[]; roster: SpeakerRoster } | null = null;
    if (signature !== "off") {
      throwIfCancelled(options.signal);
      options.onProgress?.({
        stage: "diarizing",
        done: 0,
        total: 0,
        seconds: 0,
        audioSeconds: asr.audioSeconds,
      });
      await yieldToEventLoop();
      try {
        const attempt = await runWorkerJob<{ turns: SpeakerTurn[]; roster: SpeakerRoster } | null>(
          "diarize",
          wavPath,
          options.numThreads === undefined ? {} : { numThreads: options.numThreads },
          options.onProgress,
          options.signal,
        );
        diarized = attempt.ok
          ? attempt.result
          : await diarizeWav(wavPath, {
              numThreads: options.numThreads,
              onProgress: (done, total) =>
                options.onProgress?.({
                  stage: "diarizing",
                  done,
                  total,
                  seconds: 0,
                  audioSeconds: asr.audioSeconds,
                }),
            });
      } catch (err) {
        // The catch exists so a diarization FAILURE costs only the labels; a cancel is not
        // a failure and must stop the ingest, not continue it unlabeled.
        if (err instanceof AudioError && err.code === "cancelled") throw err;
        diarized = null;
      }
    }

    // A failed or skipped pass is stored as "off" rather than under the live signature, so
    // the next add retries diarization instead of serving unlabeled text forever.
    const diarize: CachedTranscript["diarize"] = diarized
      ? { signature, turns: diarized.turns, roster: diarized.roster }
      : { signature: "off", turns: [], roster: null };
    if (contentHash) {
      await writeCache(contentHash, {
        pipelineVersion: TRANSCRIPT_PIPELINE_VERSION,
        modelId,
        audioSeconds: asr.audioSeconds,
        speechSeconds: asr.speechSeconds,
        words: asr.words,
        suspectChunks: asr.suspectChunks,
        repairedChunks: asr.repairedChunks,
        diarize,
      });
    }
    return {
      recordedAt,
      units: [{ text: render(asr.words, diarize, asr.audioSeconds), page: null }],
      contentHash,
      audioSeconds: asr.audioSeconds,
      suspectChunks: asr.suspectChunks,
      repairedChunks: asr.repairedChunks,
      cached: hit !== null,
      roster: diarize.roster,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Streaming sha256 so a multi-gigabyte video never lands in memory.
 *
 * Reports bytes as it goes, because this is the first thing that happens to a file and on a
 * large recording it runs for tens of seconds. Measured at about 180 MB/s, so a 5 GB video
 * spends nearly half a minute here before anything else begins.
 */
export async function hashFile(
  path: string,
  onProgress?: (readBytes: number, totalBytes: number) => void,
): Promise<string> {
  const { createReadStream, statSync } = await import("node:fs");
  let totalBytes = 0;
  try {
    totalBytes = statSync(path).size;
  } catch {
    // A size we cannot read only costs the percentage, never the hash.
  }
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    let read = 0;
    stream.on("error", reject);
    stream.on("data", (d) => {
      hash.update(d);
      read += d.length;
      onProgress?.(read, totalBytes);
    });
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
