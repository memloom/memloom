import { entityNameKey } from "./entities.js";

// Entity resolution: deciding when two entity rows are the same real-world thing.
//
// Everything here is PURE, so the rules can be tested without a store and audited without
// running an LLM. The store-side half (candidate generation over memory_entities, the fold
// itself, the conflicts queue) lives in memloom.ts.
//
// The governing observation, measured on the motivating corpus of ~1800 entities: fragments are
// ORTHOGRAPHIC, not semantic. "Claude Opus 4.8"/"Opus 4.8", "Postgres"/"PostgreSQL",
// "Claude Code"/"claude-code". Semantic aliases ("the founder" for a person) barely occur,
// because the extractor's own guards refuse roles and grammatical subjects. So candidate
// generation is LEXICAL and deterministic; an embedding is a confirming signal, never the
// thing that pairs two rows on its own. That keeps precision high and costs nothing per pair.

/** What the resolver decided to do with a pair. */
export type PairVerdict = "auto" | "review" | "reject";

export interface PairJudgement {
  verdict: PairVerdict;
  /** 0..1. Only meaningful for auto and review. */
  score: number;
  /** Human-readable, stored on the merge record and shown in the queue. */
  reason: string;
}

/** The fields resolution needs about an entity. `mentions` decides which spelling wins. */
export interface ResolvableEntity {
  id: string;
  name: string;
  entityType: string;
  mentions: number;
}

/**
 * The aggressive equivalence key: casefold, then drop everything that is not a letter or a
 * digit. "Claude Code", "claude-code" and "ClaudeCode" all collapse to "claudecode".
 * Equality here is pure orthography, which is the one signal safe enough to fold without
 * asking anyone.
 *
 * Deliberately stronger than entityNameKey (which preserves word boundaries and is the
 * IDENTITY key #resolveEntity looks rows up by). This one is only ever used to compare.
 */
export function mergeKey(name: string): string {
  return entityNameKey(name).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Normalized word tokens: the containment test's unit ("Opus 4.8" inside "Claude Opus 4.8"). */
export function nameTokens(name: string): string[] {
  return entityNameKey(name)
    .split(/[^\p{L}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

/**
 * Tokens carrying a digit: version numbers, model generations, years. These are the
 * discriminators that make two otherwise-identical names different things, so they get
 * their own guard below.
 */
export function versionTokens(name: string): string[] {
  return nameTokens(name).filter((t) => /\d/.test(t));
}

/** Levenshtein distance, abandoned once it provably exceeds `max` (returns max + 1). */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      curr.push(v);
      if (v < rowMin) rowMin = v;
    }
    // Every remaining path runs through this row, so nothing can come back under the bound.
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length] ?? max + 1;
}

/** Does the name start with punctuation once the leading "@" convention is stripped? */
function leadsWithPunctuation(name: string): boolean {
  const key = entityNameKey(name);
  return key.length > 0 && !/[\p{L}\p{N}]/u.test(key[0] ?? "");
}

/**
 * Is one name a multi-word phrase appearing verbatim inside the other?
 *
 * The naive version of this test (every token of one appears somewhere in the other) is the
 * single biggest source of false candidates on a real store: it pairs "memloom" with
 * "memloom serve", "MEMLOOM_HOME", "@memloom/cli", "memloom.ts" and 60 other rows, because a
 * one-word name is a substring of every phrase built on it. Adding a word to a single-word
 * name almost always makes a DIFFERENT thing (a command, a file, a package).
 *
 * Requiring at least two words, contiguous and in order, keeps the case worth catching
 * ("Opus 4.8" inside "Claude Opus 4.8") and drops the noise. On the motivating corpus this
 * rule alone took the queue from 1129 pairs to 364.
 *
 * `minTokens` is that requirement, relaxed to 1 for people: see PERSON_MIN_PHRASE_TOKENS.
 */
function isContainedPhrase(
  a: readonly string[],
  b: readonly string[],
  minTokens = MIN_PHRASE_TOKENS,
): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < minTokens || shorter.length === longer.length) return false;
  // Adding more than a couple of words is a new thing, not a variant spelling.
  if (longer.length - shorter.length > 2) return false;
  for (let i = 0; i + shorter.length <= longer.length; i++) {
    let hit = true;
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] !== shorter[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * If one name is the other plus a dot and a short suffix, return the dotted one. Catches
 * "memloom.ts" against "memloom" and "CLAUDE.md" against "Claude": file extensions and TLDs
 * survive entityNameKey but not mergeKey, so this compares the word-preserving form.
 */
function extensionOf(a: string, b: string): string | null {
  const ka = entityNameKey(a);
  const kb = entityNameKey(b);
  const [shortKey, longKey, longName] = ka.length <= kb.length ? [ka, kb, b] : [kb, ka, a];
  return new RegExp(`^${shortKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-z0-9]{1,4}$`).test(
    longKey,
  )
    ? longName
    : null;
}

/** Below this many characters, orthographic equality is not evidence ("C#" and "C" collide). */
export const MIN_AUTO_KEY_LENGTH = 3;
/** At or above this length, a name can absorb two edits and still be the same name. */
export const LONG_NAME_CHARS = 8;
/** Edit distance on the merge key that still counts as a spelling variant. */
export const MAX_VARIANT_EDIT_DISTANCE = 2;
/** A confirming cosine at or above this raises a review pair's score; it never pairs alone. */
export const CONFIRMING_COSINE = 0.8;
/** Words a contained phrase needs before containment counts as evidence. */
export const MIN_PHRASE_TOKENS = 2;
/**
 * The exception, and it is the only one.
 *
 * For every other type, a name plus a word is a different thing: "memloom serve" is a command,
 * "@memloom/cli" is a package, "memloom.ts" is a file. People are the opposite. A human's name
 * is routinely written at several lengths that all mean the same human, and first-name against
 * full-name is the most common alias there is, so a person pair earns containment at one word.
 * Both sides must be typed person, and it still only ASKS: "John" against "John Smith" and
 * "John Doe" is a genuine question, not a fold.
 */
export const PERSON_MIN_PHRASE_TOKENS = 1;

/**
 * Decide what to do with one candidate pair.
 *
 * The load-bearing rule is the NEGATIVE one. "Claude Opus 4.8"/"Claude Opus 4.7" and
 * "memory_entities"/"memory_edges" are close by every lexical and semantic measure and must
 * never fold. Differing version tokens are therefore a hard reject, checked before anything
 * else can promote a pair.
 */
export function judgePair(
  a: ResolvableEntity,
  b: ResolvableEntity,
  cosine: number | null = null,
): PairJudgement {
  const keyA = mergeKey(a.name);
  const keyB = mergeKey(b.name);

  if (!keyA || !keyB || a.id === b.id) {
    return { verdict: "reject", score: 0, reason: "same row or empty name" };
  }

  // Guard first. A version token present on both sides and disagreeing means these are two
  // releases of one family, which is exactly what the graph should keep apart.
  const versA = versionTokens(a.name);
  const versB = versionTokens(b.name);
  if (versA.length > 0 && versB.length > 0) {
    const setB = new Set(versB);
    const shared = versA.filter((t) => setB.has(t));
    if (shared.length === 0) {
      return {
        verdict: "reject",
        score: 0,
        reason: `different version tokens (${versA.join(",")} vs ${versB.join(",")})`,
      };
    }
  } else if (versA.length !== versB.length) {
    // A version on one side only: "Postgres 15" is a specific release of "Postgres", which
    // is a relationship the graph should keep, not a spelling of the same row.
    return {
      verdict: "reject",
      score: 0,
      reason: "one name pins a version and the other does not",
    };
  }

  // "memloom.ts", "CLAUDE.md", "memloom.ai": a name plus a file extension or a TLD is a
  // file or a domain, not the thing it is named after. Cheap to state, and it removes a
  // whole class of confident-looking wrong pairs.
  const dotted = extensionOf(a.name, b.name);
  if (dotted) {
    return {
      verdict: "reject",
      score: 0,
      reason: `"${dotted}" reads as a file or domain built on the other name, not a spelling of it`,
    };
  }

  // Pure orthographic equality: the only fold safe to make without asking.
  if (keyA === keyB) {
    if (keyA.length < MIN_AUTO_KEY_LENGTH) {
      return {
        verdict: "review",
        score: 0.6,
        reason: `spellings match but "${keyA}" is too short to fold automatically`,
      };
    }
    // A leading dot or underscore is not decoration in a developer's graph: ".next" is the
    // build directory and "Next" is the framework, "_memloom_meta" is a table and "memloom"
    // is the project. Same merge key, different things, so ask instead of folding.
    if (leadsWithPunctuation(a.name) !== leadsWithPunctuation(b.name)) {
      return {
        verdict: "review",
        score: 0.7,
        reason: `same spelling but one is punctuation-prefixed ("${a.name}" / "${b.name}"), which usually marks a file or directory rather than the thing itself`,
      };
    }
    return {
      verdict: "auto",
      score: 1,
      reason: `identical apart from case and punctuation ("${a.name}" / "${b.name}")`,
    };
  }

  const tokensA = nameTokens(a.name);
  const tokensB = nameTokens(b.name);

  let score = 0;
  let reason = "";

  const bothPeople = a.entityType === "person" && b.entityType === "person";
  const minTokens = bothPeople ? PERSON_MIN_PHRASE_TOKENS : MIN_PHRASE_TOKENS;

  if (isContainedPhrase(tokensA, tokensB, minTokens)) {
    // "Opus 4.8" inside "Claude Opus 4.8". Strong, but a qualifier can also distinguish
    // ("Claude Code" inside "Claude Code SDK"), so this asks rather than folds.
    score = 0.75;
    reason =
      bothPeople && Math.min(tokensA.length, tokensB.length) < MIN_PHRASE_TOKENS
        ? `one person's name written short and long ("${a.name}" / "${b.name}")`
        : `one name's words are contained in the other ("${a.name}" / "${b.name}")`;
  } else {
    // Tolerance scales with length. Two edits inside a six-letter word is most of the word
    // ("NOTICE" and "Notion" are two edits apart and unrelated); inside a ten-letter one it
    // is a suffix ("postgres" and "postgresql").
    const shortest = Math.min(keyA.length, keyB.length);
    const allowed = shortest >= LONG_NAME_CHARS ? MAX_VARIANT_EDIT_DISTANCE : 1;
    const dist = boundedEditDistance(keyA, keyB, allowed);
    if (dist <= allowed) {
      // "postgres"/"postgresql". Scale by how much of the shorter name survives, so short
      // names (where 2 edits is most of the word) score lower.
      const shorter = Math.min(keyA.length, keyB.length);
      score = 0.6 + 0.15 * Math.max(0, 1 - dist / Math.max(1, shorter));
      reason = `spelling variant, ${dist} character edit${dist === 1 ? "" : "s"} apart ("${a.name}" / "${b.name}")`;
    } else {
      return { verdict: "reject", score: 0, reason: "names are not lexical variants" };
    }
  }

  if (cosine !== null && cosine >= CONFIRMING_COSINE) {
    score = Math.min(0.95, score + 0.1);
    reason += `, and their vectors agree (${cosine.toFixed(2)})`;
  }
  if (a.entityType !== b.entityType) {
    reason += `, typed differently (${a.entityType} vs ${b.entityType})`;
  }
  return { verdict: "review", score, reason };
}

/** Capital letters in a name: the tie-break signal for "which of these is the display form". */
function capitals(name: string): number {
  return (name.match(/\p{Lu}/gu) ?? []).length;
}

/**
 * Which spelling survives.
 *
 * Mention count decides first: the hub form is the one the graph and the fuse entity arm
 * already lean on, and demoting it would move retrieval weight off the anchor that works.
 * Ties break toward the longer (more specific) name, then toward the properly capitalized
 * one, because "Claude Code" and "claude-code" are the same length and letting the uuid pick
 * between them makes the graph's display names arbitrary. The id is the last resort, present
 * only so the choice is deterministic.
 */
export function pickCanonical<T extends ResolvableEntity>(a: T, b: T): { canonical: T; source: T } {
  if (a.mentions !== b.mentions) {
    return a.mentions > b.mentions ? { canonical: a, source: b } : { canonical: b, source: a };
  }
  if (a.name.length !== b.name.length) {
    return a.name.length > b.name.length
      ? { canonical: a, source: b }
      : { canonical: b, source: a };
  }
  const capsA = capitals(a.name);
  const capsB = capitals(b.name);
  if (capsA !== capsB) {
    return capsA > capsB ? { canonical: a, source: b } : { canonical: b, source: a };
  }
  return a.id < b.id ? { canonical: a, source: b } : { canonical: b, source: a };
}

/**
 * Group pairs into fold sets by union-find, so "Postgres"/"PostgreSQL" and
 * "PostgreSQL"/"postgres" become one group of three rather than two overlapping merges.
 */
export function groupPairs(pairs: readonly (readonly [string, string])[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined || p === x) {
      parent.set(x, x);
      return x;
    }
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const [a, b] of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    const bucket = groups.get(root);
    if (bucket) bucket.push(key);
    else groups.set(root, [key]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
