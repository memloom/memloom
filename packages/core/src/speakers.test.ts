import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sectionizeTurns, toMarkdown, type TimedWord } from "./audio.js";
import {
  dropJunkClusters,
  longestSegment,
  mergeTurns,
  relabelByAppearance,
  type SpeakerTurn,
} from "./diarize.js";
import { registerExtractor } from "./extract.js";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { SpeakerRoster } from "./types.js";

const words = (...pairs: Array<[string, number]>): TimedWord[] =>
  pairs.map(([word, start]) => ({ word, start }));

describe("relabelByAppearance", () => {
  it("makes the first voice heard speaker 1, whatever the clusterer called it", () => {
    const out = relabelByAppearance([
      { start: 10, end: 12, speaker: 0 },
      { start: 0, end: 5, speaker: 3 },
      { start: 6, end: 9, speaker: 1 },
    ]);
    expect(out.map((s) => s.speaker)).toEqual([1, 2, 3]);
    expect(out[0]?.start).toBe(0);
  });
});

describe("mergeTurns", () => {
  it("merges per-breath segments of one voice into a turn", () => {
    const turns = mergeTurns([
      { start: 0, end: 4, speaker: 1 },
      { start: 5, end: 9, speaker: 1 },
      { start: 10, end: 14, speaker: 2 },
    ]);
    expect(turns).toEqual([
      { start: 0, end: 9, speaker: 1 },
      { start: 10, end: 14, speaker: 2 },
    ]);
  });

  it("keeps a long silence as a turn boundary even for the same voice", () => {
    const turns = mergeTurns([
      { start: 0, end: 4, speaker: 1 },
      { start: 20, end: 24, speaker: 1 },
    ]);
    expect(turns).toHaveLength(2);
  });
});

describe("dropJunkClusters", () => {
  it("absorbs sliver clusters that are sounds, not people", () => {
    // The measured real-recording shape: two humans plus a seconds-long noise cluster.
    const kept = dropJunkClusters([
      { start: 0, end: 300, speaker: 0 },
      { start: 305, end: 307, speaker: 2 },
      { start: 310, end: 425, speaker: 1 },
    ]);
    expect(new Set(kept.map((s) => s.speaker))).toEqual(new Set([0, 1]));
  });

  it("keeps a quiet but real participant", () => {
    // 27 percent of the talk, like the real second speaker in the calibration recording.
    const kept = dropJunkClusters([
      { start: 0, end: 300, speaker: 0 },
      { start: 300, end: 415, speaker: 1 },
    ]);
    expect(new Set(kept.map((s) => s.speaker))).toEqual(new Set([0, 1]));
  });

  it("keeps everything when every cluster is a sliver", () => {
    const slivers = [
      { start: 0, end: 3, speaker: 0 },
      { start: 4, end: 6, speaker: 1 },
    ];
    expect(dropJunkClusters(slivers)).toEqual(slivers);
  });

  it("keeps a brief speaker in a short clip: the floor scales with total speech", () => {
    // 5 s out of 13 s is a full participant, not a notification sound. A fixed 8 s floor
    // deleted exactly this speaker from the two-voice smoke clip.
    const kept = dropJunkClusters([
      { start: 0, end: 8, speaker: 0 },
      { start: 8, end: 13, speaker: 1 },
    ]);
    expect(new Set(kept.map((s) => s.speaker))).toEqual(new Set([0, 1]));
  });
});

describe("longestSegment", () => {
  it("prefers the long clean stretch over the first interjection", () => {
    const best = longestSegment(
      [
        { start: 0, end: 1, speaker: 2 },
        { start: 30, end: 45, speaker: 2 },
        { start: 50, end: 52, speaker: 2 },
      ],
      2,
    );
    expect(best?.start).toBe(30);
  });
});

describe("sectionizeTurns", () => {
  const turns: SpeakerTurn[] = [
    { start: 0, end: 5, speaker: 1 },
    { start: 5, end: 10, speaker: 2 },
  ];

  it("breaks a section exactly where the speaker changes", () => {
    const sections = sectionizeTurns(
      words(["Hello", 0], ["there.", 2], ["Thanks", 6], ["Kostek.", 8]),
      turns,
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ speaker: 1, text: "Hello there." });
    expect(sections[1]).toMatchObject({ speaker: 2, text: "Thanks Kostek." });
  });

  it("still splits one voice's monologue on the time rules", () => {
    const monologue = words(
      ...Array.from(
        { length: 40 },
        (_, i): [string, number] => [i % 9 === 8 ? "word." : "word", i * 10],
      ),
    );
    const sections = sectionizeTurns(monologue, [{ start: 0, end: 400, speaker: 1 }], 120);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) expect(s.speaker).toBe(1);
  });

  it("lets words in the silence between turns trail the current speaker", () => {
    const sections = sectionizeTurns(
      words(["One.", 0], ["straggler", 4.8], ["Two.", 6]),
      turns,
    );
    expect(sections[0]?.text).toBe("One. straggler");
  });
});

describe("toMarkdown with speakers", () => {
  it("labels multi-voice sections and leaves unlabeled sections alone", () => {
    const md = toMarkdown([
      { start: 0, end: 5, text: "Hello there.", speaker: 1 },
      { start: 5, end: 10, text: "Thanks." },
    ]);
    expect(md).toContain("## 0:00 - 0:05, Speaker 1\n\nHello there.");
    expect(md).toContain("## 0:05 - 0:10\n\nThanks.");
  });
});

// ----------------------------------------------------------------------------------------
// renameSpeaker, end to end against a real store.
//
// A test extractor stands in for the ASR pipeline: it emits exactly the markdown shape
// transcribeMedia produces (time-range headings with ", Speaker N") plus a roster, without
// requiring the 641 MB model. What is under test is everything AFTER transcription: the
// roster landing in jsonb, and a rename rewriting breadcrumbs without touching the words.
// ----------------------------------------------------------------------------------------

const roster = (): SpeakerRoster => ({
  version: 1,
  embeddingModel: "test",
  speakers: [
    {
      id: 1,
      label: "Speaker 1",
      name: null,
      seconds: 5,
      sampleStart: 0,
      sampleEnd: 5,
      embedding: null,
    },
    {
      id: 2,
      label: "Speaker 2",
      name: null,
      seconds: 7,
      sampleStart: 5,
      sampleEnd: 12,
      embedding: null,
    },
  ],
});

const TRANSCRIPT = [
  "## 0:00 - 0:05, Speaker 1",
  "",
  "Hello and welcome to the show.",
  "## 0:05 - 0:12, Speaker 2",
  "",
  "Glad to be here. Speaker 2 is literally what my badge says.",
  "## 0:12 - 0:20, Speaker 1",
  "",
  "Let us get into it.",
].join("\n");

registerExtractor({
  kind: "audio",
  extensions: [".spktest"],
  version: 1,
  chunker: "markdown",
  async extract() {
    return { units: [{ text: TRANSCRIPT, page: null }], speakers: roster() };
  },
});

describe("renameSpeaker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function freshWithDoc() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(256),
      llm: new NullLLMProvider(),
      dedup: false,
    });
    await memloom.init();
    const dir = await mkdtemp(join(tmpdir(), "memloom-spk-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "standup.spktest");
    await writeFile(path, "irrelevant; the test extractor ignores the bytes");
    const added = await memloom.contextAdd({ path });
    return { memloom, documentId: added.documentId };
  }

  it("stores the roster on the document", async () => {
    const { memloom } = await freshWithDoc();
    const [doc] = await memloom.contextList();
    expect(doc?.speakers?.speakers).toHaveLength(2);
    expect(doc?.speakers?.speakers[1]?.label).toBe("Speaker 2");
  });

  it("renames a speaker in the roster and in every breadcrumb, sparing the spoken words", async () => {
    const { memloom, documentId } = await freshWithDoc();
    const updated = await memloom.renameSpeaker(documentId, 2, "Alice");
    expect(updated.speakers.find((s) => s.id === 2)?.name).toBe("Alice");

    const { chunks } = await memloom.contextChunks(documentId);
    expect(chunks.map((c) => c.headingPath)).toEqual([
      "0:00 - 0:05, Speaker 1",
      "0:05 - 0:12, Alice",
      "0:12 - 0:20, Speaker 1",
    ]);
    const renamed = chunks[1];
    // The breadcrumb line changed with the heading; the transcript body did not, including
    // its literal utterance of "Speaker 2".
    expect(renamed?.content.startsWith("0:05 - 0:12, Alice\n\n")).toBe(true);
    expect(renamed?.content).toContain("Speaker 2 is literally what my badge says.");
  });

  it("renames a renamed speaker by matching the current name", async () => {
    const { memloom, documentId } = await freshWithDoc();
    await memloom.renameSpeaker(documentId, 2, "Alice");
    await memloom.renameSpeaker(documentId, 2, "Alicia");
    const { chunks } = await memloom.contextChunks(documentId);
    expect(chunks[1]?.headingPath).toBe("0:05 - 0:12, Alicia");
  });

  it("refuses a name another speaker already carries", async () => {
    const { memloom, documentId } = await freshWithDoc();
    await memloom.renameSpeaker(documentId, 1, "Alice");
    await expect(memloom.renameSpeaker(documentId, 2, "Alice")).rejects.toThrow(
      /already named/,
    );
  });

  it("rejects an unknown speaker and an empty name", async () => {
    const { memloom, documentId } = await freshWithDoc();
    await expect(memloom.renameSpeaker(documentId, 9, "Bob")).rejects.toThrow(/no speaker 9/);
    await expect(memloom.renameSpeaker(documentId, 1, "   ")).rejects.toThrow(/empty/);
  });
});

// The voice library: name a voice once, and later recordings of the same voice arrive
// pre-named. A mutable fixture roster lets each test file carry its own voices through
// the one registered extractor.

let voiceRoster: SpeakerRoster | null = null;

registerExtractor({
  kind: "audio",
  extensions: [".spkvoice"],
  version: 1,
  chunker: "markdown",
  async extract() {
    return { units: [{ text: TRANSCRIPT, page: null }], speakers: voiceRoster };
  },
});

/** A normalized voice vector: `close` nudges it so similarity stays near but below 1. */
function voice(axis: number, close = 0): number[] {
  const v = [0, 0, 0, 0];
  v[axis] = 1;
  if (close > 0) {
    v[axis] = Math.sqrt(1 - close * close);
    v[(axis + 1) % 4] = close;
  }
  return v;
}

function voiceSpeaker(id: number, embedding: number[], seconds = 60) {
  return {
    id,
    label: `Speaker ${id}`,
    name: null,
    seconds,
    sampleStart: 0,
    sampleEnd: 8,
    embedding,
  };
}

describe("autoNameSpeakers", () => {
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
    const dir = await mkdtemp(join(tmpdir(), "memloom-voice-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const add = async (file: string, roster: SpeakerRoster) => {
      voiceRoster = roster;
      const path = join(dir, file);
      await writeFile(path, "bytes");
      return memloom.contextAdd({ path });
    };
    return { memloom, add };
  }

  const rosterOf = (speakers: ReturnType<typeof voiceSpeaker>[]): SpeakerRoster => ({
    version: 1,
    embeddingModel: "test",
    speakers,
  });

  it("names a known voice at ingest and leaves strangers numbered", async () => {
    const { memloom, add } = await fresh();
    const first = await add("first.spkvoice", rosterOf([voiceSpeaker(1, voice(0))]));
    await memloom.renameSpeaker(first.documentId, 1, "Kostek Sytnyk");

    // A near-identical voice (cosine ~0.99) plus an orthogonal stranger.
    const second = await add(
      "second.spkvoice",
      rosterOf([voiceSpeaker(1, voice(0, 0.14)), voiceSpeaker(2, voice(2))]),
    );
    const doc = (await memloom.contextList()).find((d) => d.id === second.documentId);
    expect(doc?.speakers?.speakers.find((s) => s.id === 1)?.name).toBe("Kostek Sytnyk");
    expect(doc?.speakers?.speakers.find((s) => s.id === 2)?.name).toBeNull();

    // The name reached the transcript too, through the same rewrite a manual rename uses.
    const { chunks } = await memloom.contextChunks(second.documentId);
    expect(chunks.some((c) => c.headingPath?.endsWith(", Kostek Sytnyk"))).toBe(true);
  });

  it("never auto-names a sliver, however similar", async () => {
    const { memloom, add } = await fresh();
    const first = await add("named.spkvoice", rosterOf([voiceSpeaker(1, voice(0))]));
    await memloom.renameSpeaker(first.documentId, 1, "Kostek Sytnyk");

    const sliver = await add(
      "sliver.spkvoice",
      rosterOf([voiceSpeaker(1, voice(0, 0.14), 3)]),
    );
    const doc = (await memloom.contextList()).find((d) => d.id === sliver.documentId);
    expect(doc?.speakers?.speakers[0]?.name).toBeNull();
  });

  it("sweeps names onto recordings ingested before the label existed", async () => {
    const { memloom, add } = await fresh();
    // The backlog case: this recording arrives while nobody is labeled yet.
    const early = await add("early.spkvoice", rosterOf([voiceSpeaker(1, voice(0, 0.1))]));
    const labeled = await add("labeled.spkvoice", rosterOf([voiceSpeaker(1, voice(0))]));
    await memloom.renameSpeaker(labeled.documentId, 1, "Kostek Sytnyk");

    const result = await memloom.autoNameAllSpeakers();
    expect(result.named.map((n) => n.documentId)).toContain(early.documentId);
    const doc = (await memloom.contextList()).find((d) => d.id === early.documentId);
    expect(doc?.speakers?.speakers[0]?.name).toBe("Kostek Sytnyk");
  });
});
