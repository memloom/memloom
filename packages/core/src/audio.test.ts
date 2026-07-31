import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECODE_CHUNK_SECONDS,
  type DecodeChunk,
  findSuspectChunks,
  formatTime,
  MAX_DECODE_CHUNK_SECONDS,
  packChunks,
  recordingHeader,
  recordingTime,
  SAMPLE_RATE,
  sectionize,
  type TimedWord,
  toMarkdown,
  type VadSegment,
} from "./audio.js";

/** Build VAD segments from second-pairs, which is how the real ones read on a timeline. */
const segs = (...pairs: Array<[number, number]>): VadSegment[] =>
  pairs.map(([a, b]) => ({ start: a * SAMPLE_RATE, end: b * SAMPLE_RATE }));

const words = (...pairs: Array<[string, number]>): TimedWord[] =>
  pairs.map(([word, start]) => ({ word, start }));

describe("packChunks", () => {
  it("batches short segments up to the chunk limit instead of decoding each alone", () => {
    // The whole performance finding in one assertion: twelve 4.5 s segments are one decode
    // call at 60 s, not twelve. Twelve calls is what made an hour of audio cost 46 minutes.
    const input = segs(
      ...Array.from({ length: 12 }, (_, i) => [i * 5, i * 5 + 4.5] as [number, number]),
    );
    const chunks = packChunks(input, 60);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.start).toBe(0);
  });

  it("starts a new chunk rather than exceeding the limit", () => {
    const input = segs([0, 30], [31, 61], [62, 92]);
    const chunks = packChunks(input, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect((c.end - c.start) / SAMPLE_RATE).toBeLessThanOrEqual(60);
    }
  });

  it("keeps the short pauses inside a chunk, so audio stays contiguous", () => {
    // Contiguous rather than spliced: a chunk covers the gaps between its segments, because
    // butting unrelated phrases together with no pause is not what the model was trained on.
    const chunks = packChunks(segs([0, 5], [7, 12]), 60);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.end).toBe(12 * SAMPLE_RATE);
    // Speech is tracked separately from span, which is what the plausibility check needs.
    expect(chunks[0]?.speechSamples).toBe(10 * SAMPLE_RATE);
  });

  it("breaks on a long silence instead of transcribing it", () => {
    const chunks = packChunks(segs([0, 5], [40, 45]), 60, 8);
    expect(chunks).toHaveLength(2);
  });

  it("never exceeds the encoder's hard cap, whatever it is asked for", () => {
    // Past roughly 400 s the encoder's position table overflows and ONNX Runtime throws.
    const input = segs(
      ...Array.from({ length: 200 }, (_, i) => [i * 5, i * 5 + 5] as [number, number]),
    );
    for (const c of packChunks(input, 10_000)) {
      expect((c.end - c.start) / SAMPLE_RATE).toBeLessThanOrEqual(MAX_DECODE_CHUNK_SECONDS);
    }
  });

  it("gives a single segment its own chunk even when it exceeds the limit", () => {
    const chunks = packChunks(segs([0, 90]), 60);
    expect(chunks).toHaveLength(1);
  });
});

describe("findSuspectChunks", () => {
  const chunk = (speechSeconds: number): DecodeChunk => ({
    start: 0,
    end: speechSeconds * SAMPLE_RATE,
    speechSamples: speechSeconds * SAMPLE_RATE,
  });

  // The failure this guard exists for: a transcript came back missing one contiguous 52-word
  // sentence, verified present in the source. No exception and no gap in the timestamps, so
  // nothing else in the pipeline could have noticed.
  it("flags a chunk that produced far less text than its neighbours for the same speech", () => {
    const chunks = [chunk(50), chunk(50), chunk(50), chunk(50)];
    const suspect = findSuspectChunks(chunks, [140, 145, 12, 138]);
    expect(suspect).toEqual([2]);
  });

  it("leaves a normally varying transcript alone", () => {
    const chunks = [chunk(50), chunk(50), chunk(50), chunk(50)];
    expect(findSuspectChunks(chunks, [140, 120, 155, 131])).toEqual([]);
  });

  it("uses the median, so one broken chunk cannot drag the threshold down to itself", () => {
    // With a mean, a single catastrophic chunk lowers the bar enough to clear itself.
    const chunks = [chunk(60), chunk(60), chunk(60)];
    expect(findSuspectChunks(chunks, [180, 175, 0])).toEqual([2]);
  });

  it("ignores chunks with too little speech to judge", () => {
    // A 3-second chunk producing 2 words is normal, not a failure.
    const chunks = [chunk(50), chunk(50), chunk(50), chunk(3)];
    expect(findSuspectChunks(chunks, [140, 145, 138, 2])).toEqual([]);
  });

  it("stays silent when there are too few chunks to establish a norm", () => {
    expect(findSuspectChunks([chunk(50), chunk(50)], [140, 10])).toEqual([]);
  });

  it("does not divide by zero on a file that produced no words at all", () => {
    const chunks = [chunk(50), chunk(50), chunk(50)];
    expect(findSuspectChunks(chunks, [0, 0, 0])).toEqual([]);
  });
});

describe("formatTime", () => {
  it("uses minutes and seconds below an hour", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(750)).toBe("12:30");
  });

  it("adds hours once a recording is long enough to need them", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(4350)).toBe("1:12:30");
  });
});

describe("sectionize", () => {
  it("prefers to end a section after a sentence rather than mid-thought", () => {
    const input = words(
      ["Hello", 0],
      ["there.", 1],
      ["This", 121],
      ["continues", 122],
      ["on.", 123],
      ["Next", 124],
      ["part.", 125],
    );
    const sections = sectionize(input, 120);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[0]?.text.endsWith(".")).toBe(true);
  });

  it("breaks anyway when a speaker never pauses, so one chunk cannot grow forever", () => {
    const input = words(
      ...Array.from({ length: 400 }, (_, i) => [`word${i}`, i] as [string, number]),
    );
    const sections = sectionize(input, 120);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) expect(s.end - s.start).toBeLessThanOrEqual(120 * 1.6);
  });

  it("keeps every word, since a section boundary must never drop content", () => {
    const input = words(
      ...Array.from({ length: 300 }, (_, i) => [`w${i}`, i * 1.5] as [string, number]),
    );
    const total = sectionize(input, 120)
      .map((s) => s.text.split(" ").length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(300);
  });

  it("returns nothing for an empty transcript instead of one empty section", () => {
    expect(sectionize([], 120)).toEqual([]);
  });
});

describe("toMarkdown", () => {
  // This shape is the reason audio needs no migration: chunkMarkdown makes one chunk per
  // heading and describeSource renders heading_path, so the citation reads
  // "from talk.mp4 > 12:30 - 14:28" with no new column and no new chunker.
  it("emits a time range as each heading, which is what the citation renders", () => {
    const md = toMarkdown([
      { start: 0, end: 120, text: "first part" },
      { start: 120, end: 245, text: "second part" },
    ]);
    expect(md).toContain("## 0:00 - 2:00");
    expect(md).toContain("## 2:00 - 4:05");
    expect(md.match(/^## /gm)).toHaveLength(2);
  });

  it("produces markdown the existing chunker sections cleanly", async () => {
    const { chunkMarkdown } = await import("./chunker.js");
    const md = toMarkdown([
      { start: 0, end: 120, text: "the write ahead log means readers never block writers" },
      { start: 120, end: 240, text: "checkpointing moves pages back into the main database" },
    ]);
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.headingPath).toBe("0:00 - 2:00");
    expect(chunks[1]?.headingPath).toBe("2:00 - 4:00");
  });
});

describe("constants", () => {
  it("keeps the decode chunk inside the encoder's limit", () => {
    expect(DECODE_CHUNK_SECONDS).toBeLessThanOrEqual(MAX_DECODE_CHUNK_SECONDS);
  });
});

describe("recordingTime", () => {
  const stamped = async (name: string) => {
    const dir = await mkdtemp(join(tmpdir(), "memloom-rt-"));
    const path = join(dir, name);
    await writeFile(path, "x");
    try {
      return await recordingTime(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  // Every separator style a recorder actually emits, read as the local clock the person
  // was living in when the device wrote the name.
  it.each([
    ["REC_20260731_142207.wav", 14, 22, 7],
    ["2026-07-31_14-22-07.opus", 14, 22, 7],
    ["2026-07-31 14.22.07.m4a", 14, 22, 7],
    ["meeting-2026-07-31T14-22-07.mp4", 14, 22, 7],
    ["20260731142207.wav", 14, 22, 7],
    ["2026-07-31.wav", 0, 0, 0],
  ])("reads %s", async (name, hour, minute, second) => {
    const found = await stamped(name);
    expect(found?.source).toBe("filename");
    expect(found?.at.getFullYear()).toBe(2026);
    expect(found?.at.getMonth()).toBe(6);
    expect(found?.at.getDate()).toBe(31);
    expect(found?.at.getHours()).toBe(hour);
    expect(found?.at.getMinutes()).toBe(minute);
    expect(found?.at.getSeconds()).toBe(second);
  });

  it("does not read a digit run that is not a date", async () => {
    // No 20xx year, so a serial number cannot be mistaken for a recording date.
    expect(await stamped("clip600.wav")).toBeNull();
    expect(await stamped("track_19940231_990000.wav")).toBeNull();
  });

  it("refuses an impossible date", async () => {
    expect(await stamped("2026-13-31_142207.wav")).toBeNull();
    expect(await stamped("2026-07-31_997700.wav")).toBeNull();
  });

  it("will not pass a just-written file's mtime off as a recording time", async () => {
    // A file modified seconds ago was created by the copy happening right now, so its
    // mtime is ingest time wearing a disguise.
    expect(await stamped("voice.wav")).toBeNull();
  });

  it("uses mtime once the file is old enough to be evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memloom-rt-"));
    const path = join(dir, "voice.wav");
    await writeFile(path, "x");
    const then = new Date(Date.now() - 3 * 86_400_000);
    await utimes(path, then, then);
    const found = await recordingTime(path);
    expect(found?.source).toBe("mtime");
    expect(Math.abs(found!.at.getTime() - then.getTime())).toBeLessThan(2000);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("recordingHeader", () => {
  const at = new Date(2026, 6, 31, 14, 22, 7);

  it("names the day, the clock time and where the time came from", () => {
    const line = recordingHeader({ at, source: "filename" }, 2647);
    expect(line).toContain("Friday 2026-07-31 14:22:07");
    expect(line).toContain("file name");
    expect(line).toContain("Length 44:07");
  });

  it("admits when the timestamp is only the file's own", () => {
    expect(recordingHeader({ at, source: "mtime" }, 60)).toContain("copied rather than recorded");
  });

  it("says so plainly when nothing knows the time", () => {
    expect(recordingHeader(null, 60)).toContain("Recording time unknown");
  });

  it("survives chunking as its own chunk, ahead of the first time range", async () => {
    const { chunkMarkdown } = await import("./chunker.js");
    const md = `${recordingHeader({ at, source: "filename" }, 240)}\n\n${toMarkdown([
      { start: 0, end: 120, text: "one" },
      { start: 120, end: 240, text: "two" },
    ])}`;
    const chunks = chunkMarkdown(md);
    // The header is why this matters: chunkMarkdown keeps everything before the first
    // heading, so the date is stored and searchable rather than dropped on the floor.
    expect(chunks[0]?.headingPath).toBeNull();
    expect(chunks[0]?.content).toContain("2026-07-31");
    expect(chunks[1]?.headingPath).toBe("0:00 - 2:00");
  });
});
