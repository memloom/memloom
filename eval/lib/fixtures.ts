import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type SessionChunk,
  type SessionUnit,
  chunkUnits,
} from "../../packages/core/src/claude-sessions.js";
import type { TranscriptKind } from "../../packages/core/src/distill.js";

// One fixture is one transcript plus the memories a careful human would keep from it. The
// three fixture folders are the three transcript kinds memloom has to serve: coding sessions
// (agent-session), advice chats (chat; LongMemEval_S sessions), and voice-note monologues
// (note). Expectations are hand-written; `keywords` is the cheap deterministic fallback for
// the recall score (every group must match some memory; a group is a string or any-of list).

export type FixtureKind = "coding" | "advice" | "voice";

export interface Expected {
  content: string;
  type?: string;
  keywords?: (string | string[])[];
}

export interface Fixture {
  id: string;
  folder: FixtureKind;
  kind: TranscriptKind;
  /** When the transcript happened, handed to the prompt as recordedAt. */
  date?: string;
  source?: unknown;
  units: { role: "user" | "assistant"; text: string }[];
  expected: Expected[];
}

export const FIXTURE_FOLDERS: FixtureKind[] = ["coding", "advice", "voice"];

export function loadFixtures(root: string, folders: FixtureKind[] = FIXTURE_FOLDERS): Fixture[] {
  const out: Fixture[] = [];
  for (const folder of folders) {
    const dir = join(root, folder);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as Omit<Fixture, "folder">;
      if (!raw.id) raw.id = basename(file, ".json");
      out.push({ ...raw, folder });
    }
  }
  return out;
}

/** Fixture units become session units with 1-based line numbers, then the real chunker runs. */
export function chunksOf(fixture: Fixture): SessionChunk[] {
  const units: SessionUnit[] = fixture.units.map((u, i) => ({
    line: i + 1,
    role: u.role,
    text: u.text,
  }));
  return chunkUnits(units).chunks;
}

export function transcriptText(fixture: Fixture): string {
  return fixture.units.map((u, i) => `[L${i + 1}] ${u.role}: ${u.text}`).join("\n");
}

export function keywordsMatch(expected: Expected, memories: readonly string[]): boolean {
  if (!expected.keywords || expected.keywords.length === 0) return false;
  const haystack = memories.map((m) => m.toLowerCase());
  return expected.keywords.every((group) => {
    const options = (Array.isArray(group) ? group : [group]).map((k) => k.toLowerCase());
    return haystack.some((m) => options.some((k) => m.includes(k)));
  });
}
