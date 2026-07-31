import { loadSherpa, SAMPLE_RATE } from "./audio.js";
import {
  resolveSpeakerModels,
  SPEAKER_EMBEDDING_MODEL_ID,
} from "./audio-models.js";
import type { DocumentSpeaker, SpeakerRoster } from "./types.js";

// Who spoke when, entirely on this machine. pyannote segmentation finds voice activity per
// speaker, the WeSpeaker embedding model turns stretches into vectors, and sherpa-onnx
// clusters them into anonymous speakers. Nothing here knows anybody's name: the transcript
// gets "Speaker 1/2/3" in order of first appearance, and naming is the user's move (or,
// later, a voice library's).
//
// Diarization is deliberately optional at every call site. The models are a separate 34 MB
// download, and a recording with no roster still transcribes exactly as before, so a missing
// model degrades to the old behavior instead of failing an ingest.

/** One diarized stretch of a single voice, in seconds from the start of the recording. */
export interface SpeakerTurn {
  start: number;
  end: number;
  /** 1-based, ordered by first appearance. */
  speaker: number;
}

export interface DiarizeResult {
  turns: SpeakerTurn[];
  roster: SpeakerRoster;
}

/**
 * Adjacent same-speaker segments closer than this are one turn. Diarization splits on every
 * breath pause; a transcript labeled per-breath would be unreadable, and a two-second gap is
 * about where a pause stops being "the same remark".
 */
export const TURN_MERGE_GAP_SECONDS = 2;

/**
 * Clustering distance cutoff: smaller splits voices apart, larger merges them together.
 *
 * Calibrated on real recordings, twice. The first pass landed on 0.7: sherpa's demo 0.5
 * fragmented a 1:1 call into raw slivers and 0.8 merged its two humans. Then a second
 * 1:1 recording merged its two voices AT 0.7 over its full 21 minutes while separating
 * fine on an 8-minute cut: cluster distances grow with recording length, so a threshold
 * tuned on one file's window can sit outside another's. 0.6 separated both 1:1s
 * (identical splits to their best runs), kept a solo recording at one speaker, and the
 * junk filter below absorbs the extra slivers that a tighter cutoff splits off, which is
 * what made the old 0.5-fragmentation argument obsolete. Very short clips (seconds per
 * voice) can still merge: their embeddings are too noisy for any threshold.
 */
export const DIARIZE_THRESHOLD_DEFAULT = 0.6;

/**
 * Bump when anything that changes diarization OUTPUT changes: the threshold default, the
 * junk filter, the models. Part of the cache signature, so tuning any of it re-diarizes
 * cached transcripts without re-running ASR.
 *
 * v3: the junk floor scales with total speech, and segmentation is multi-threaded.
 *
 * v4: threshold 0.6, after a full-length recording merged two voices at 0.7.
 */
export const DIARIZE_VERSION = 4;

/**
 * A cluster below both floors is not a person, it is a notification sound, a laugh, or a
 * cough that clustered apart because it does not sound like speech. Measured on the same
 * recording: the real second speaker held 27 percent of the talk; junk clusters held
 * seconds. The share floor is relative to the biggest cluster so a long recording does not
 * silently raise the bar for a quiet-but-real participant.
 */
export const MIN_SPEAKER_SECONDS = 8;
export const MIN_SPEAKER_SHARE_OF_BIGGEST = 0.05;

/**
 * Drop junk clusters before labeling. The dropped segments are removed entirely rather
 * than reassigned: sectionizeTurns attributes a word to the last turn that started before
 * it, so a removed sliver's words flow into the surrounding kept speaker's section, which
 * is where a listener would have put them.
 *
 * The absolute floor scales down with total speech, because "too short to be a person" is
 * relative: nine seconds inside a seven-minute call is a notification sound, but five
 * seconds inside a thirteen-second clip is a full participant (a fixed 8 s floor measured
 * on the long recording silently deleted exactly such a speaker from a short one).
 */
export function dropJunkClusters(segments: RawSegment[]): RawSegment[] {
  const talk = new Map<number, number>();
  let total = 0;
  for (const s of segments) {
    talk.set(s.speaker, (talk.get(s.speaker) ?? 0) + (s.end - s.start));
    total += s.end - s.start;
  }
  const biggest = Math.max(...talk.values());
  const floor = Math.min(MIN_SPEAKER_SECONDS, total * 0.1);
  const keep = new Set(
    [...talk]
      .filter(([, sec]) => sec >= floor && sec >= biggest * MIN_SPEAKER_SHARE_OF_BIGGEST)
      .map(([id]) => id),
  );
  // A recording of nothing but slivers keeps them all: dropping every voice would turn a
  // short clip into "no speech", which is worse than a noisy roster.
  if (keep.size === 0) return segments;
  return segments.filter((s) => keep.has(s.speaker));
}

/** The effective clustering config, shared by the run and by the cache signature. */
export function clusterConfig(): { numClusters: number; threshold: number } {
  const fixed = Number.parseInt(process.env.MEMLOOM_DIARIZE_SPEAKERS ?? "", 10);
  if (Number.isFinite(fixed) && fixed > 0) return { numClusters: fixed, threshold: 0 };
  const threshold = Number.parseFloat(process.env.MEMLOOM_DIARIZE_THRESHOLD ?? "");
  return {
    numClusters: -1,
    threshold: Number.isFinite(threshold) ? threshold : DIARIZE_THRESHOLD_DEFAULT,
  };
}

/**
 * What the current diarization setup would produce, as a cache key: "off" when the models
 * are absent, otherwise version + models + clustering knobs. A transcript cached under one
 * signature is re-diarized (words reused, ASR skipped) when the signature changes, which
 * is what makes threshold tuning cost minutes instead of an ASR re-run.
 */
export async function diarizeSignature(): Promise<string> {
  if ((await resolveSpeakerModels()) === null) return "off";
  const c = clusterConfig();
  const knob = c.numClusters > 0 ? `n=${c.numClusters}` : `t=${c.threshold}`;
  return `d${DIARIZE_VERSION}:${SPEAKER_EMBEDDING_MODEL_ID}:${knob}`;
}

/**
 * The sample snippet a labeling UI plays. Long enough to recognize a colleague's voice,
 * short enough that stepping through five speakers stays under a minute.
 */
const SAMPLE_SECONDS = 8;

/** Embeddings come from at most this much audio: more adds latency, not identity. */
const EMBEDDING_SECONDS = 15;

interface RawSegment {
  start: number;
  end: number;
  speaker: number;
}

/**
 * sherpa's cluster ids come out in an arbitrary order. Relabeling by first appearance makes
 * "Speaker 1" the first voice heard, which is what a person skimming the transcript expects,
 * and keeps the labels stable across runs on the same file.
 */
export function relabelByAppearance(segments: RawSegment[]): RawSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const order = new Map<number, number>();
  for (const seg of sorted) {
    if (!order.has(seg.speaker)) order.set(seg.speaker, order.size + 1);
  }
  return sorted.map((s) => ({ ...s, speaker: order.get(s.speaker) ?? 0 }));
}

/** Merge per-breath segments into readable turns. Input must be sorted by start. */
export function mergeTurns(
  segments: RawSegment[],
  gap = TURN_MERGE_GAP_SECONDS,
): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const seg of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker && seg.start - last.end <= gap) {
      last.end = Math.max(last.end, seg.end);
    } else {
      turns.push({ start: seg.start, end: seg.end, speaker: seg.speaker });
    }
  }
  return turns;
}

/**
 * The speaker's single longest segment. Longest rather than first, because first
 * appearances are often a two-word interjection over someone else, and both the playable
 * sample and the stored embedding need clean solo speech more than anything else here.
 */
export function longestSegment(segments: RawSegment[], speaker: number): RawSegment | null {
  let best: RawSegment | null = null;
  for (const seg of segments) {
    if (seg.speaker !== speaker) continue;
    if (!best || seg.end - seg.start > best.end - best.start) best = seg;
  }
  return best;
}

function l2Normalize(v: Float32Array): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  // Six decimals keeps a 256-dim vector at about 3 KB of jsonb instead of 6; cosine
  // similarity is insensitive to noise that small.
  return Array.from(v, (x) => Math.round((x / norm) * 1e6) / 1e6);
}

interface EmbeddingExtractor {
  createStream(): { acceptWaveform(o: unknown): void; inputFinished(): void };
  compute(stream: unknown, enableExternalBuffer?: boolean): Float32Array;
}

/**
 * The raw native addon, for the one API the JS wrapper does not expose:
 * offlineSpeakerDiarizationProcessAsync, which reports progress per segmentation chunk
 * and runs the pass off the calling thread. Verified against 1.13.4: the callback
 * receives (processedChunks, totalChunks) and the call returns a Promise of segments.
 */
async function loadSherpaAddon(): Promise<Record<string, unknown>> {
  // Indirected for the same reason as loadSherpa: the optional dependency is frequently
  // absent and a literal specifier would fail typecheck on machines without it.
  const specifier = "sherpa-onnx-node/addon.js";
  const loaded = (await import(specifier)) as Record<string, unknown>;
  const inner = loaded.default as Record<string, unknown> | undefined;
  return inner && typeof inner.offlineSpeakerDiarizationProcessAsync === "function"
    ? inner
    : loaded;
}

/**
 * Diarize a 16 kHz mono WAV.
 *
 * Returns null when the speaker models are not installed or the recording defeated the
 * pipeline, so every caller has one degraded path: no roster, plain transcript.
 *
 * `process()` is a single synchronous native call over the whole file, the same tradeoff
 * the ASR decode makes, but without a chunk boundary to yield at: clustering needs the
 * global view, so the event loop is held for the duration. Measured around 3 percent of
 * real time on CPU, so a one-hour recording blocks for roughly two minutes. The worker
 * thread that would fix this for ASR fixes it for diarization too, and is equally not
 * done here.
 */
export async function diarizeWav(
  wavPath: string,
  options: {
    numThreads?: number;
    /** Segmentation progress, (processedChunks, totalChunks): the honest percentage. */
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<DiarizeResult | null> {
  const models = await resolveSpeakerModels();
  if (!models) return null;
  const sherpa = await loadSherpa();
  const addon = await loadSherpaAddon();
  // Capped at 4, and this is a crash line, not a tuning preference. Measured on a
  // 12-core machine over 10 minutes of real call audio: 2 threads 337s, 4 threads 223s,
  // 8 threads a native abort inside onnxruntime's arena allocator (BFCArena "Failed to
  // allocate memory") that kills the entire process, not just the job. The win from 2
  // to 4 is real; the step to 8 is a crater.
  const numThreads = Math.min(options.numThreads ?? 4, 4);

  // MEMLOOM_DIARIZE_SPEAKERS pins the count when the user knows it; MEMLOOM_DIARIZE_THRESHOLD
  // overrides the calibrated default. Env rather than config, matching MEMLOOM_ASR_MODEL:
  // a run can be pinned without persistent state. Resolution lives in clusterConfig so the
  // cache signature always describes the same run this constructs.
  const clustering = clusterConfig();

  const sd = new (sherpa.OfflineSpeakerDiarization as new (c: unknown) => {
    process(samples: Float32Array): RawSegment[];
  })({
    // Segmentation threads scale with the caller's numThreads too: it slides a window over
    // the ENTIRE recording, so it dominates the pass, and pinning it to 1 (as the upstream
    // example does) left most of the cost single-threaded.
    segmentation: { pyannote: { model: models.segmentation }, numThreads },
    embedding: { model: models.embedding, numThreads },
    clustering:
      clustering.numClusters > 0
        ? { numClusters: clustering.numClusters }
        : { numClusters: -1, threshold: clustering.threshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });

  const readWave = sherpa.readWave as (p: string) => {
    samples: Float32Array;
    sampleRate: number;
  };
  const wave = readWave(wavPath);
  // The async variant instead of sd.process(): same output, but it reports progress per
  // segmentation chunk and runs on a background thread instead of holding this one.
  const processAsync = addon.offlineSpeakerDiarizationProcessAsync as (
    handle: unknown,
    samples: Float32Array,
    callback: (done: number, total: number) => number,
  ) => Promise<RawSegment[]>;
  const raw = await processAsync(
    (sd as unknown as { handle: unknown }).handle,
    wave.samples,
    (done, total) => {
      options.onProgress?.(done, total);
      // Zero means "keep going"; a nonzero return would abort the pass.
      return 0;
    },
  );
  if (!raw || raw.length === 0) return null;

  const segments = relabelByAppearance(dropJunkClusters(raw));
  const turns = mergeTurns(segments);
  const speakerIds = [...new Set(segments.map((s) => s.speaker))].sort((a, b) => a - b);

  // One embedding per speaker, from their clearest solo stretch, stored against the day a
  // voice library can say "this is Alice again". Extraction failure costs the vector, never
  // the roster: the labeling UI works fine without it.
  const extractor = (() => {
    try {
      return new (sherpa.SpeakerEmbeddingExtractor as new (c: unknown) => EmbeddingExtractor)(
        { model: models.embedding, numThreads },
      );
    } catch {
      return null;
    }
  })();

  const speakers: DocumentSpeaker[] = speakerIds.map((id) => {
    const seconds = segments
      .filter((s) => s.speaker === id)
      .reduce((a, s) => a + (s.end - s.start), 0);
    const best = longestSegment(segments, id) ?? { start: 0, end: 0, speaker: id };
    const sample = { start: best.start, end: Math.min(best.end, best.start + SAMPLE_SECONDS) };
    let embedding: number[] | null = null;
    if (extractor) {
      try {
        // Clipped to the segment's own end: a window that ran past it would blend the next
        // voice into this speaker's vector, which is exactly the contamination the longest
        // solo segment was chosen to avoid.
        const start = Math.floor(best.start * SAMPLE_RATE);
        const end = Math.min(
          Math.floor(Math.min(best.end, best.start + EMBEDDING_SECONDS) * SAMPLE_RATE),
          wave.samples.length,
        );
        const stream = extractor.createStream();
        stream.acceptWaveform({
          samples: wave.samples.subarray(start, end),
          sampleRate: SAMPLE_RATE,
        });
        stream.inputFinished();
        embedding = l2Normalize(extractor.compute(stream));
      } catch {
        embedding = null;
      }
    }
    return {
      id,
      label: `Speaker ${id}`,
      name: null,
      seconds: Math.round(seconds * 10) / 10,
      sampleStart: Math.round(sample.start * 10) / 10,
      sampleEnd: Math.round(sample.end * 10) / 10,
      embedding,
    };
  });

  return {
    turns,
    roster: { version: 1, embeddingModel: SPEAKER_EMBEDDING_MODEL_ID, speakers },
  };
}
